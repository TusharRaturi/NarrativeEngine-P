import type { ChatMessage, NPCEntry } from '../../types';
import type { TurnState, TurnCallbacks } from './turnOrchestrator';
import { useAppStore } from '../../store/useAppStore';
import { api } from '../llm/apiClient';
import { CHAPTER_SCENE_SOFT_CAP } from '../../types';
import { rateImportance } from '../archive-memory/importanceRater';
import { sealChapterCombined } from '../saveFileEngine';
import { backgroundQueue } from '../infrastructure/backgroundQueue';
import { extractSceneEvents } from '../archive-memory/sceneEventExtractor';
import { extractTurnDivergences } from '../archive-memory/turnDivergenceExtractor';
import { scanPressure, buildPressurePatch, shouldArchiveNPC, findArchivedToRestore } from '../npc/npcPressureTracker';
import { scanCharacterProfile } from '../characterProfileParser';
import { scanCharacterTraits } from '../characterTraitParser';
import { scanInventory } from '../inventoryParser';
import { mergeLocationScanLedger, scanLocation } from '../locationParser';
import { resolveLocationHeader } from '../locationHeader';
import { toast } from '../../components/Toast';
import { mergeSealEntries, EMPTY_REGISTER } from '../campaign-state/divergenceRegister';
import { saveDivergenceRegister } from '../../store/campaignStore';
import { tierAllows } from './aiTier';

const PRESENT_HEADER_RE = /👥\s*\[Present\]\s*(.+)/i;

// Cache for multi-turn narrative scenes (so we can extract the whole scene at once when it increments)
let narrativeSceneCache: { userText: string; gmText: string; maxImportance: number; }[] = [];
let currentNarrativeScene: string | null = null;
let narrativeArchiveSceneId: string | null = null;

/**
 * Campaign-id guard factory for background-task callbacks. Mirrors the
 * established `guardedUpdateNPC` pattern (L478-485): reads the live
 * `activeCampaignId` from the store and drops the call if the user has
 * switched campaigns while the background task was in flight. The guard
 * only suppresses stale writes — same-campaign calls pass through
 * untouched, so synchronous UI handlers (which call the store directly,
 * not via these wrappers) are unaffected.
 *
 * Used to close the race where a background scan (Profile/Trait/Inventory,
 * Event-Extraction, Chapter-AutoSeal, Timeskip-Narration) completes after
 * a campaign switch and would otherwise contaminate the new campaign's
 * context via `callbacks.updateContext` (campaignSlice.ts:512 has no
 * campaign-id check and merges the patch into whatever `s.context` is
 * currently active).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeGuarded<T extends (...args: any[]) => void>(
    fn: T,
    activeCampaignId: string,
    label: string,
): T {
    return ((...args: Parameters<T>) => {
        const currentId = useAppStore.getState().activeCampaignId;
        if (currentId !== activeCampaignId) {
            console.warn(`[PostTurn] Dropping ${label} — campaign switched (${activeCampaignId} → ${currentId})`);
            return;
        }
        return fn(...args);
    }) as T;
}

/** Drop the entire background closure if the campaign switched before it
 *  starts running (cheap fast-fail). Re-check after each significant await
 *  via `assertStillActive` for closures with multiple awaited steps. */
function assertStillActive(activeCampaignId: string, label: string): boolean {
    const currentId = useAppStore.getState().activeCampaignId;
    if (currentId !== activeCampaignId) {
        console.warn(`[PostTurn] Aborting ${label} — campaign switched (${activeCampaignId} → ${currentId})`);
        return false;
    }
    return true;
}

function parsePresentHeader(content: string): string[] | null {
    const match = content.match(PRESENT_HEADER_RE);
    if (!match) return null;
    return match[1].split(/[,;]/).map(n => n.trim()).filter(Boolean);
}

function resolveNPCIds(
    names: string[],
    npcLedger: NPCEntry[]
): string[] {
    const nameToId = new Map<string, string>();
    for (const npc of npcLedger) {
        const nameLower = npc.name.toLowerCase();
        nameToId.set(nameLower, npc.id);
        if (npc.aliases) {
            npc.aliases.split(',').map(a => a.trim().toLowerCase()).filter(Boolean)
                .forEach(a => nameToId.set(a, npc.id));
        }
    }
    return names
        .map(n => nameToId.get(n.toLowerCase()))
        .filter((id): id is string => !!id);
}

export async function runPostTurnPipeline(
    state: TurnState,
    callbacks: TurnCallbacks,
    lastAssistantContent: string,
    allMsgs: ChatMessage[],
    // WO-P1-03: optional TurnContext bus, carried across the commit boundary
    // by the PendingTurnSnapshot. Thread-only — the pipeline does NOT yet read
    // this (the existing reads stay, preserving byte-identical behaviour).
    // Project 4's memory port will swap selected reads to bus fields. Keeping
    // the param optional so callers that don't have a bus (e.g. launch
    // reconciliation's rebuildStateFromLiveStore path) still work.
    turnContext?: import('./turnContext').TurnContext,
): Promise<void> {
    // WO-P1-03: thread-only seam. Acknowledge the param is intentionally
    // threaded but not yet consumed — Project 4 will read bus fields here.
    // The void reference keeps lint happy without changing behaviour.
    void turnContext;
    const activeCampaignId = state.activeCampaignId!;
    const { displayInput, npcLedger } = state;

    // B3 — a PC built in chat never flips characterProfileActive (only the PC Creation
    // Wizard did). Auto-enable the moment a campaign has an isPC NPC, and seed the profile
    // name from it. Idempotent: once the gate is true this is a no-op. Never clobbers an
    // existing name (|| guard) — a profile the scan already built must survive. Only name is
    // mappable from NPCEntry (race/class/level are NOT on the entry); scanCharacterProfile
    // enriches the rest over the next few turns, preserving identity as it goes.
    autoEnableCharacterProfile(state, callbacks, npcLedger);

    // ── Phase 2/3: clear agency + arc digests at the top so each is consumed exactly once ──
    // The previous turn's digests were folded into the GM call we just made; clear them
    // before fresh digests accumulate from this turn's agency + arc ticks.
    if (state.context.agencyDigest) {
        callbacks.updateContext({ agencyDigest: '' });
    }
    if (state.context.arcDigest) {
        callbacks.updateContext({ arcDigest: '' });
    }

    const results = await Promise.allSettled([
        runArchiveTrack(state, callbacks, displayInput, lastAssistantContent, allMsgs, activeCampaignId),
        runPressureTrack(state, callbacks, displayInput, npcLedger, activeCampaignId, lastAssistantContent),
    ]);

    // ── On-Stage NPC Tracking ──
    const presentNames = parsePresentHeader(lastAssistantContent);
    const onStageIds = presentNames && presentNames.length > 0
        ? resolveNPCIds(presentNames, npcLedger)
        : [];
    callbacks.setOnStageNpcIds?.(onStageIds);

    // ── Location Header Tracking (hot path) ──
    // Sibling of the 👥 [Present] parse above: the GM's 📍 [Location] header is the
    // authoritative per-turn location self-report (requested by defaultRules.ts:51).
    // Engine regex, zero LLM, every tier. The interval-gated scanLocation call in
    // runArchiveTrack stays the cold path (features/connections enrichment). Header
    // absent or unusable → no-op; the last known pointer stands. Unknown places are
    // suggested, never auto-added (same trust model as NPC suggestions).
    try {
        const sNow = useAppStore.getState();
        if (sNow.activeCampaignId === activeCampaignId) {
            const outcome = resolveLocationHeader(
                lastAssistantContent,
                sNow.locationLedger ?? [],
                sNow.context.currentPlaceId ?? null,
            );
            if (outcome.kind === 'resolved') {
                callbacks.updateContext({ currentPlaceId: outcome.placeId, currentFeature: outcome.feature });
                if (outcome.appendFeature && outcome.feature) {
                    const entry = sNow.locationLedger.find(l => l.id === outcome.placeId);
                    if (entry) sNow.updateLocation(outcome.placeId, { features: [...entry.features, outcome.feature], lastSeenScene: String(Date.now()) });
                }
            } else if (outcome.kind === 'feature-only') {
                callbacks.updateContext({ currentFeature: outcome.feature });
                if (outcome.appendFeature && sNow.context.currentPlaceId) {
                    const entry = sNow.locationLedger.find(l => l.id === sNow.context.currentPlaceId);
                    if (entry) sNow.updateLocation(entry.id, { features: [...entry.features, outcome.feature] });
                }
            } else if (outcome.kind === 'unknown') {
                sNow.addLocationSuggestions([outcome.suggestion]);
            }
        }
    } catch (err) {
        console.warn('[LocationHeader] Parse failed (non-fatal):', err);
    }

    for (const r of results) {
        if (r.status === 'rejected') {
            console.warn('[PostTurn] Track failed:', r.reason);
        }
    }

    // ── NPC Agency Tick (Phase 2 port) ──
    // Runs after archive/NPC/pressure tracks settle so newly-detected NPCs have profiles
    // before they're ticked. Mutates NPC agency state in-place via callbacks.updateNPC;
    // folds a digest into context.agencyDigest for the next GM call. Gated by aiTier in Phase 4.
    // Also bumps activity for every NPC that was on-stage last turn so the deep tier tracks the
    // player's active social circle (bumpOnStageActivity is unconditional — same pattern as the
    // short-want lifecycle).
    try {
        const { runAgencyTick, bumpOnStageActivity } = await import('../npc/agency/agencyEngine');
        bumpOnStageActivity(state, callbacks, npcLedger);
        if (tierAllows(state.settings.aiTier, 'heartbeatTick')) {
            // Guard only addMessage — it's the only callback invoked from a
            // backgroundQueue.push closure inside runAgencyTick (Timeskip-Narration,
            // agencyEngine.ts:341). The synchronous updateContext/updateNPC calls in
            // runAgencyTick run in the same microtask as this line, so they don't need
            // guarding (same reasoning as the synchronous pipeline calls at L68/111).
            const agencyCallbacks: TurnCallbacks = {
                ...callbacks,
                addMessage: makeGuarded(callbacks.addMessage, activeCampaignId, 'addMessage (Timeskip-Narration)'),
            };
            runAgencyTick(state, agencyCallbacks, npcLedger, displayInput);
        }
    } catch (err) {
        console.warn('[AgencyTick] Failed (non-fatal):', err);
    }

    // ── Inner Repression booking (parity 30/06 WO-3) — the once-per-turn pressure accrual ──
    // The payload reaction menu (world.ts read path) MASKS a hostile impulse on every render but
    // intentionally drops the repression `event`, because payload assembly re-runs within a turn
    // and would double-count. THIS is the single authoritative booking site: roll repression once
    // per on-stage hex NPC and persist the pressure delta, so the build-up → burst dynamic actually
    // fires (without this, repressionPressure never accrues and the feature is inert). Zero LLM;
    // pure dice. Ungated (mirrors the menu, which is shown on every tier). Never inside payload.
    try {
        const { buildReactionMenu } = await import('../npc/reactionMenu');
        const { applyRepressionToMenu, bookRepression } = await import('../npc/reactionRepression');
        const onStageSet = new Set(onStageIds);
        const matureMode = state.settings.matureMode ?? false;
        for (const npc of npcLedger) {
            if (!onStageSet.has(npc.id) || !npc.personalityHex) continue;
            const rng = Math.random; // one fresh roll per turn per NPC — that IS the once-per-turn accrual
            const menu = buildReactionMenu(npc, 'peaceful', rng, matureMode);
            const { event } = applyRepressionToMenu(menu, npc, 'peaceful', rng);
            if (!event) continue; // nothing repressible this turn
            const patch = bookRepression(npc, event);
            if (Object.keys(patch).length > 0) callbacks.updateNPC(npc.id, patch);
        }
    } catch (err) {
        console.warn('[RepressionBooking] Failed (non-fatal):', err);
    }

    // ── Arc Engine Tick (Phase 3 port) — sibling of the agency tick ──
    // Rolls tempo per active arc, advances the ladder, runs stance scan against on-stage NPCs,
    // builds the arcSurfaceLine, and folds it into context.arcDigest for the next GM call.
    // Gated by aiTier in Phase 4. Zero LLM (the only LLM call is the spawn, fired manually
    // via the ArcInjectorButton).
    try {
        if (tierAllows(state.settings.aiTier, 'arcTick')) {
            const { runArcTick } = await import('../arc/arcEngine');
            runArcTick(state, callbacks, displayInput, lastAssistantContent);
        }
    } catch (err) {
        console.warn('[ArcTick] Failed (non-fatal):', err);
    }
}

// B3 — Auto-enable characterProfileActive for chat-made PCs. The flag was flipped true ONLY by
// the PC Creation Wizard, so PCs built conversationally never engaged the structured-profile
// subsystem (scan, payload injection). Fires at the top of runPostTurnPipeline with npcLedger
// in scope, before runArchiveTrack's bookkeeping scan so the scan can fire the same turn.
// Idempotent: once characterProfileActive is true, this is a no-op. Never clobbers an existing
// profile name (|| guard) — a profile the scan already built must survive. Only name is mappable
// from NPCEntry (race/class/level are NOT on the entry); scanCharacterProfile enriches the rest.
function autoEnableCharacterProfile(
    state: TurnState,
    callbacks: TurnCallbacks,
    npcLedger: NPCEntry[],
): void {
    if (state.context.characterProfileActive) return;
    // WO-A rewrite 2 §2: PC lives at `context.playerCharacter`. Defensive
    // fallback to a legacy `isPC` ledger row (post-migration this is empty).
    const pc = state.context.playerCharacter ?? npcLedger.find(n => n.isPC);
    if (!pc) return;
    const existing = state.context.characterProfileData || { name: '', race: '', class: '', level: 1, hp: { current: 20, max: 20 }, stats: {}, skills: [], abilities: [], traits: [], notes: '' };
    const seeded: typeof existing = {
        ...existing,
        name: existing.name || pc.name,
    };
    callbacks.updateContext({
        characterProfileActive: true,
        characterProfileData: seeded,
    });
    console.log(`[B3] Auto-enabled characterProfileActive; seeded characterProfileData.name from PC "${pc.name}"`);
}

async function runArchiveTrack(
    state: TurnState,
    callbacks: TurnCallbacks,
    displayInput: string,
    lastAssistantContent: string,
    allMsgs: ChatMessage[],
    activeCampaignId: string
): Promise<void> {
    let sceneImportance: number | undefined;
    const importanceProvider = state.getFreshProvider();
    if (importanceProvider && tierAllows(state.settings.aiTier, 'importanceRating')) {
        try {
            sceneImportance = await rateImportance(importanceProvider, displayInput, lastAssistantContent, allMsgs);
            console.log(`[ImportanceRater] Scene rated: ${sceneImportance}/5`);
        } catch (err) {
            console.warn('[ImportanceRater] Failed (non-fatal):', err);
        }
    }

    const appendData = await api.archive.append(activeCampaignId, displayInput, lastAssistantContent, sceneImportance);
    const appendedSceneId = appendData?.sceneId;
    if (!appendData) {
        console.warn('[PostTurn] Archive append returned no data — skipping archive refresh');
        return;
    }

    // WO-F (2be3ad5) — stamp the archived sceneId onto the last assistant message so the
    // surgical-delete + edit-sync UI hooks can map an on-screen GM reply back to its
    // long-term-memory scene. (Mirrors mobile's scene-marker system message, via a direct
    // field instead since main has no scene-marker message stream.)
    //
    // Use `updateLastAssistantMessage` (scans back to the last assistant), NOT
    // `updateLastMessage` (literal last message). After a tool call, the literal
    // last message is the tool message — desktop reuses the same assistant id
    // across tool iterations instead of pushing a fresh bubble per call like
    // mobile does, so `updateLastMessage` would stamp sceneId on the tool
    // message and the assistant would never receive its archive-anchor sceneId.
    if (appendedSceneId) {
        callbacks.updateLastAssistantMessage?.({ sceneId: appendedSceneId });
    }

    const [freshIndex, freshTimeline, freshChapters] = await Promise.all([
        api.archive.getIndex(activeCampaignId),
        api.timeline.get(activeCampaignId),
        api.chapters.list(activeCampaignId),
    ]);
    callbacks.setArchiveIndex(freshIndex);
    callbacks.setTimeline?.(freshTimeline);
    state.setChapters(freshChapters);
    console.log(`[Archive] Appended scene #${appendedSceneId}`);

    const entry = freshIndex.find(e => e.sceneId === appendedSceneId);
    const bkProvider = state.getFreshProvider();
    if (entry && !entry.events && bkProvider) {
        const sceneText = `${displayInput}\n\n${lastAssistantContent}`;
        const guardedSetArchiveIndex = makeGuarded(callbacks.setArchiveIndex, activeCampaignId, 'setArchiveIndex (Event-Extraction)');
        backgroundQueue.push(`Event-Extraction:${appendedSceneId}`, async () => {
            if (!assertStillActive(activeCampaignId, 'Event-Extraction')) return;
            const events = await extractSceneEvents(bkProvider, sceneText);
            if (events && events.length > 0) {
                await api.archive.patchEvents(activeCampaignId, [{ sceneId: entry.sceneId, events }]);
                const updatedIndex = await api.archive.getIndex(activeCampaignId);
                guardedSetArchiveIndex(updatedIndex);
                console.log(`[Archive] Post-turn events extracted for scene #${entry.sceneId}`);
            }
        }).catch(err => console.warn('[PostTurn] Background event extraction failed:', err));
    }

    const auxProvider = state.getFreshAuxiliaryProvider?.() || bkProvider;
    if (state.settings.autoExtractDivergences && auxProvider) {
        const guardedSetDivergenceRegister = callbacks.setDivergenceRegister 
            ? makeGuarded(callbacks.setDivergenceRegister, activeCampaignId, 'setDivergenceRegister (AutoExtractDivergences)')
            : undefined;

        if (guardedSetDivergenceRegister) {
            const importanceGate = state.settings.divergenceImportanceGate ?? 7;
            const openChapter = freshChapters.find(c => !c.sealedAt);
            const chapterId = openChapter?.chapterId || 'unknown';

            const headerMatch = lastAssistantContent.match(/^Scene\s*#(\d+)/i);
            const turnNarrativeScene = headerMatch ? headerMatch[1] : null;

            if (turnNarrativeScene && currentNarrativeScene && turnNarrativeScene !== currentNarrativeScene) {
                // Scene incremented! Extract the cached scene.
                const textToExtractUser = narrativeSceneCache.map(c => c.userText).join('\n\n');
                const textToExtractGm = narrativeSceneCache.map(c => c.gmText).join('\n\n');
                const extractArchiveId = narrativeArchiveSceneId || appendedSceneId || '000';
                const extractImportance = Math.max(...narrativeSceneCache.map(c => c.maxImportance), 1);

                if (extractImportance >= importanceGate && textToExtractGm.trim()) {
                    backgroundQueue.push(`Divergence-Extraction:${extractArchiveId}`, async () => {
                        if (!assertStillActive(activeCampaignId, 'Divergence-Extraction')) return;
                        const storeState = useAppStore.getState();
                        const npcLedger = storeState.npcLedger || [];
                        const activeDivergences = storeState.divergenceRegister?.entries.filter(e => e.isActive !== false) || [];

                        const extracted = await extractTurnDivergences(
                            auxProvider,
                            textToExtractUser,
                            textToExtractGm,
                            extractArchiveId,
                            chapterId,
                            npcLedger,
                            importanceGate,
                            activeDivergences
                        );
                        if (!assertStillActive(activeCampaignId, 'Divergence-Extraction')) return;
                        
                        const postExtractStoreState = useAppStore.getState();
                        const currentRegister = postExtractStoreState.divergenceRegister;
                        if (currentRegister) {
                            const nextRegister = mergeSealEntries(currentRegister, extracted, extractArchiveId);
                            guardedSetDivergenceRegister(nextRegister);
                            
                            const allEntries = [...extracted.newEntries, ...extracted.updates.map(u => u.newEntry)];
                            if (allEntries.length > 0 || extracted.invalidations.length > 0) {
                                console.log(`[Archive] Post-turn divergences extracted for scene #${extractArchiveId} (${extracted.newEntries.length} new, ${extracted.updates.length} updates, ${extracted.invalidations.length} invalidations)`);
                                
                                // Dispatch divergence-based suggestions
                                const pc = postExtractStoreState.context?.playerCharacter;
                                const excludeNames = new Set<string>();
                                if (pc) {
                                    excludeNames.add(pc.name.toLowerCase());
                                    if (pc.aliases) {
                                        pc.aliases.split(',').forEach(a => excludeNames.add(a.trim().toLowerCase()));
                                    }
                                }

                                const npcsToSuggest = allEntries
                                    .flatMap(e => e.unrecognizedNpcNames || [])
                                    .filter(name => !excludeNames.has(name.toLowerCase()));

                                if (npcsToSuggest.length > 0 && postExtractStoreState.addNpcSuggestions) {
                                    postExtractStoreState.addNpcSuggestions(npcsToSuggest);
                                }
                                
                                const locationsToSuggest = allEntries.flatMap(e => e.locations || []);
                                if (locationsToSuggest.length > 0 && postExtractStoreState.addLocationSuggestions) {
                                    postExtractStoreState.addLocationSuggestions(
                                        locationsToSuggest.map(name => ({
                                            name,
                                            firstSeen: Date.now()
                                        }))
                                    );
                                }
                            }
                        }
                    }).catch(err => console.warn('[PostTurn] Background divergence extraction failed:', err));
                }

                // Clear cache
                narrativeSceneCache = [];
                narrativeArchiveSceneId = appendedSceneId || null;
            }

            if (turnNarrativeScene) {
                currentNarrativeScene = turnNarrativeScene;
            }
            if (!narrativeArchiveSceneId || narrativeSceneCache.length === 0) {
                narrativeArchiveSceneId = appendedSceneId || null;
            }

            if (appendedSceneId) {
                narrativeSceneCache.push({
                    userText: displayInput,
                    gmText: lastAssistantContent,
                    maxImportance: sceneImportance ?? 1
                });
            }
        }
    }

    const openChapter = freshChapters.find(c => !c.sealedAt);
    if (openChapter && openChapter.sceneCount >= CHAPTER_SCENE_SOFT_CAP) {
        console.log(`[Auto-Seal] Chapter "${openChapter.title}" hit ${openChapter.sceneCount} scenes — sealing...`);
        const guardedSetChapters = makeGuarded(state.setChapters, activeCampaignId, 'setChapters (Auto-Seal)');
        const guardedSealCallbacks: TurnCallbacks = {
            ...callbacks,
            setDivergenceRegister: callbacks.setDivergenceRegister
                ? makeGuarded(callbacks.setDivergenceRegister, activeCampaignId, 'setDivergenceRegister (Auto-Seal)')
                : undefined,
            setArchiveIndex: makeGuarded(callbacks.setArchiveIndex, activeCampaignId, 'setArchiveIndex (Auto-Seal)'),
        };
        backgroundQueue.push('Chapter-AutoSeal', async () => {
            if (!assertStillActive(activeCampaignId, 'Chapter-AutoSeal')) return;
            const sealResult = await api.chapters.seal(activeCampaignId);
            if (!assertStillActive(activeCampaignId, 'Chapter-AutoSeal')) return;
            if (!sealResult) return;
            const sealedChapters = await api.chapters.list(activeCampaignId);
            if (!assertStillActive(activeCampaignId, 'Chapter-AutoSeal')) return;
            guardedSetChapters(sealedChapters);
            toast.info(`Chapter "${sealResult.sealedChapter.title}" auto-sealed (${CHAPTER_SCENE_SOFT_CAP} scenes)`);

            const sealProvider = state.getFreshProvider();
            if (sealProvider && tierAllows(state.settings.aiTier, 'sealChapter')) {
                // WO-P1-03: pass the 5 formerly-coupling reads as explicit params.
                // These are read from the store here at the call site (still on
                // the post-turn path), but the seal function itself no longer
                // reaches into getState() — its inputs are now honest.
                await runCombinedSeal(
                    sealProvider,
                    sealResult.sealedChapter,
                    activeCampaignId,
                    state,
                    guardedSealCallbacks,
                    true,
                    {
                        npcLedger: useAppStore.getState().npcLedger ?? [],
                        archiveIndex: useAppStore.getState().archiveIndex ?? [],
                        divergenceScanBudget: useAppStore.getState().settings.divergenceScanBudget ?? 0,
                        contextLimit: useAppStore.getState().settings.contextLimit ?? 4096,
                        divergenceRegister: useAppStore.getState().divergenceRegister ?? EMPTY_REGISTER,
                    }
                );
            }
        }).catch(err => console.warn('[Auto-Seal] Failed:', err));
    }

    const turnCount = state.incrementBookkeepingTurnCounter();
    const interval = state.autoBookkeepingInterval;
    if (turnCount >= interval && appendedSceneId) {
        console.log(`[Auto Bookkeeping] Turn ${turnCount} >= interval ${interval} — queuing profile + inventory scan (scene #${appendedSceneId})`);
        state.resetBookkeepingTurnCounter();

        const bkProvider = state.getFreshProvider();
        if (bkProvider) {
            const sceneId = appendedSceneId;
            const inventoryItems = state.getFreshContext().inventoryItems || [];
            const profileData = state.getFreshContext().characterProfileData || { name: '', race: '', class: '', level: 1, hp: { current: 20, max: 20 }, stats: {}, skills: [], abilities: [], traits: [], notes: '' };

            const guardedUpdateContext = makeGuarded(callbacks.updateContext, activeCampaignId, 'updateContext (bookkeeping scan)');

            if (tierAllows(state.settings.aiTier, 'profileScan')) {
                backgroundQueue.push('Profile-Scan', async () => {
                    if (!assertStillActive(activeCampaignId, 'Profile-Scan')) return;
                    const newProfile = await scanCharacterProfile(bkProvider, state.getMessages(), profileData);
                    if (!assertStillActive(activeCampaignId, 'Profile-Scan')) return;
                    guardedUpdateContext({
                        characterProfileData: newProfile,
                        characterProfileLastScene: sceneId,
                    });
                    const s = useAppStore.getState();
                    if (s.activeCampaignId === activeCampaignId && 'setCharacterProfileData' in s) {
                        (s as { setCharacterProfileData: (p: typeof newProfile) => void }).setCharacterProfileData(newProfile);
                    }
                    console.log(`[Auto Bookkeeping] Profile sheet updated at scene #${sceneId}`);
                }).catch(err => console.warn('[Auto Bookkeeping] Profile scan failed:', err));
            }

            // WO-G: structured trait scan (sibling of the sheet scan). Maintains the
            // CharacterProfileState (identity + bounded activeTraits with supersession).
            // WO-J (5be8695): gate on characterProfileActive — skip the LLM call when the
            // toggle is off, since the result is never injected.
            if (state.getFreshContext().characterProfileActive && tierAllows(state.settings.aiTier, 'profileScan')) {
                const traitProfile = state.getFreshContext().characterProfile || { identity: {}, activeTraits: [] };
                backgroundQueue.push('Trait-Scan', async () => {
                    if (!assertStillActive(activeCampaignId, 'Trait-Scan')) return;
                    const newTraits = await scanCharacterTraits(bkProvider, state.getMessages(), traitProfile);
                    if (!assertStillActive(activeCampaignId, 'Trait-Scan')) return;
                    guardedUpdateContext({
                        characterProfile: newTraits,
                    });
                    console.log(`[Auto Bookkeeping] Traits updated at scene #${sceneId} (${newTraits.activeTraits.filter(t => !t.superseded).length} active)`);
                }).catch(err => console.warn('[Auto Bookkeeping] Trait scan failed:', err));
            }

            if (tierAllows(state.settings.aiTier, 'inventoryScan')) {
                backgroundQueue.push('Inventory-Scan', async () => {
                    if (!assertStillActive(activeCampaignId, 'Inventory-Scan')) return;
                    const newItems = await scanInventory(bkProvider, state.getMessages(), inventoryItems);
                    if (!assertStillActive(activeCampaignId, 'Inventory-Scan')) return;
                    guardedUpdateContext({
                        inventory: newItems.map(it => `- ${it.qty > 1 ? `${it.qty}x ` : ''}${it.name}`).join('\n'),
                        inventoryItems: newItems,
                        inventoryLastScene: sceneId,
                    });
                    const s = useAppStore.getState();
                    if (s.activeCampaignId === activeCampaignId && 'setInventoryItems' in s) {
                        (s as { setInventoryItems: (p: typeof newItems) => void }).setInventoryItems(newItems);
                    }
                    console.log(`[Auto Bookkeeping] Inventory updated at scene #${sceneId}`);
                }).catch(err => console.warn('[Auto Bookkeeping] Inventory scan failed:', err));
            }

            // WO-Location: structured location estimator — the place-analogue of the
            // inventory scan. Sibling block, same background queue + guards + tier gate
            // class as inventoryScan. Resolves the PC's current place + merges features/
            // connections into existing ledger entries + emits new-place suggestions for
            // player review. Never auto-adds entries. Pointer rides callbacks.updateContext
            // (currentPlaceId/currentFeature); ledger + suggestions ride the store setters.
            if (tierAllows(state.settings.aiTier, 'locationScan')) {
                backgroundQueue.push('Location-Scan', async () => {
                    if (!assertStillActive(activeCampaignId, 'Location-Scan')) return;
                    const before = useAppStore.getState();
                    const baselineLedger = before.locationLedger ?? [];
                    const baselinePlaceId = before.context.currentPlaceId ?? null;
                    const baselineFeature = before.context.currentFeature ?? null;
                    const scan = await scanLocation(
                        bkProvider,
                        state.getMessages(),
                        baselineLedger,
                        baselinePlaceId,
                        baselineFeature,
                    );
                    if (!assertStillActive(activeCampaignId, 'Location-Scan')) return;
                    const s = useAppStore.getState();
                    if (s.activeCampaignId !== activeCampaignId) return;

                    // A manual/header pointer change made while the LLM was in flight wins.
                    if (s.context.currentPlaceId === baselinePlaceId && (s.context.currentFeature ?? null) === baselineFeature
                        && (scan.currentPlaceId !== baselinePlaceId || scan.currentFeature !== baselineFeature)) {
                        guardedUpdateContext({ currentPlaceId: scan.currentPlaceId, currentFeature: scan.currentFeature });
                    }

                    const mergedLedger = mergeLocationScanLedger(baselineLedger, scan.ledger, s.locationLedger ?? []);
                    if (mergedLedger !== s.locationLedger && s.activeCampaignId === activeCampaignId) {
                        s.setLocationLedger(mergedLedger);
                    }
                    // Location suggestions are now handled exclusively by the Divergence Extractor
                    console.log(`[Auto Bookkeeping] Location scan at scene #${sceneId}: current=${scan.currentPlaceId ?? '(unclear)'}`);
                }).catch(err => console.warn('[Auto Bookkeeping] Location scan failed:', err));
            }
        }
    }
}

export async function runCombinedSeal(
    provider: { endpoint: string; apiKey: string; modelName: string; apiFormat?: string },
    chapter: import('../../types').ArchiveChapter,
    activeCampaignId: string,
    state: TurnState,
    callbacks: TurnCallbacks,
    setSealedAt: boolean,
    // WO-P1-03 §4 (Option A): the 5 coupling reads hoisted to explicit params.
    // Pre-refactor these were fetched inside the function via
    // `useAppStore.getState().*`. Hoisting them makes the seal's inputs honest
    // and testable. Same values, just passed in rather than fetched —
    // byte-identical effect (guarded by postTurnSealGolden.test.ts).
    sealInputs: {
        npcLedger: import('../../types').NPCEntry[];
        archiveIndex: import('../../types').ArchiveIndexEntry[];
        divergenceScanBudget: number;
        contextLimit: number;
        divergenceRegister: import('../../types').DivergenceRegister;
    },
): Promise<void> {
    const startNum = parseInt(chapter.sceneRange[0], 10);
    const endNum = parseInt(chapter.sceneRange[1], 10);
    const expectedCount = endNum - startNum + 1;
    const sceneIds = (chapter.sceneIds?.length === expectedCount)
        ? chapter.sceneIds
        : Array.from({ length: expectedCount }, (_, i) =>
            String(startNum + i).padStart(3, '0')
        );

    const scenes = await api.archive.fetchScenes(activeCampaignId, sceneIds);
    // WO-P1-03: was `useAppStore.getState().npcLedger ?? []` (the :489 read).
    const npcLedger = sealInputs.npcLedger;
    const npcData = npcLedger.map(n => ({
        id: n.id,
        name: n.name,
        aliases: n.aliases,
    }));

    // WO-P1-03: was `useAppStore.getState().archiveIndex ?? []` (the :496 read).
    const archiveIndex = sealInputs.archiveIndex;
    const indexEntries = archiveIndex
        .filter(e => {
            const sn = parseInt(e.sceneId, 10);
            return sn >= startNum && sn <= endNum && e.witnesses && e.witnesses.length > 0;
        })
        .map(e => ({ sceneId: e.sceneId, witnesses: e.witnesses }));

    // WO-P1-03: was `useAppStore.getState().settings.divergenceScanBudget ?? 0` (the :504 read)
    // and `useAppStore.getState().settings.contextLimit ?? 4096` (the :505 read).
    const scanBudgetSetting = sealInputs.divergenceScanBudget;
    const contextLimit = sealInputs.contextLimit;
    const effectiveScanBudget = scanBudgetSetting > 0 ? scanBudgetSetting : Math.round(contextLimit * 0.75);

    const liveRegister = sealInputs.divergenceRegister;
    const activeDivergences = liveRegister.entries.filter(e => e.isActive !== false);

    const result = await sealChapterCombined(
        provider as Parameters<typeof sealChapterCombined>[0],
        scenes,
        chapter.chapterId,
        chapter.title,
        sceneIds,
        npcData,
        activeDivergences,
        2,
        effectiveScanBudget,
        indexEntries.length > 0 ? indexEntries : undefined,
        contextLimit
    );

    const hasDivergences = result.divergences.newEntries.length > 0 || result.divergences.updates.length > 0 || result.divergences.invalidations.length > 0;

    if (result.divergenceParseError && !result.summary && !hasDivergences) {
        toast.error('Chapter seal produced no output. Try regenerating.');
        return;
    }

    if (result.divergenceParseError && !hasDivergences) {
        toast.warning('Summary generated but facts extraction failed. You can regenerate to retry.');
    }

    if (result.summary) {
        const patch: Record<string, unknown> = {
            ...result.summary,
            invalidated: false,
            sceneIds,
        };
        if (setSealedAt) {
            // Auto-seal already sets sealedAt via server; just update content
        }
        await api.chapters.update(activeCampaignId, chapter.chapterId, patch);
    } else if (setSealedAt || hasDivergences) {
        // Even without summary, persist sceneIds
        await api.chapters.update(activeCampaignId, chapter.chapterId, { sceneIds } as unknown as Parameters<typeof api.chapters.update>[2]);
    }

    if (hasDivergences) {
        const currentSceneId = sceneIds[sceneIds.length - 1] ?? '';
        const merged = mergeSealEntries(liveRegister, result.divergences, currentSceneId);
        callbacks.setDivergenceRegister?.(merged);

        try {
            await saveDivergenceRegister(activeCampaignId, merged);
        } catch (e) {
            console.warn('[CombinedSeal] Failed to save divergence register:', e);
        }

        const storeState = useAppStore.getState();
        
        const pc = storeState.context?.playerCharacter;
        const excludeNames = new Set<string>();
        if (pc) {
            excludeNames.add(pc.name.toLowerCase());
            if (pc.aliases) {
                pc.aliases.split(',').forEach(a => excludeNames.add(a.trim().toLowerCase()));
            }
        }

        const npcsToSuggest = [
            ...result.divergences.newEntries,
            ...result.divergences.updates.map(u => u.newEntry)
        ]
            .flatMap(e => e.unrecognizedNpcNames || [])
            .filter(name => !excludeNames.has(name.toLowerCase()));
        
        if (npcsToSuggest.length > 0 && storeState.addNpcSuggestions) {
            storeState.addNpcSuggestions(npcsToSuggest);
        }
        
        const locationsToSuggest = [
            ...result.divergences.newEntries,
            ...result.divergences.updates.map(u => u.newEntry)
        ].flatMap(e => e.locations || []);
        if (locationsToSuggest.length > 0 && storeState.addLocationSuggestions) {
            storeState.addLocationSuggestions(
                locationsToSuggest.map(name => ({
                    name,
                    firstSeen: Date.now()
                }))
            );
        }

        console.log(`[CombinedSeal] Chapter ${chapter.chapterId}: ${result.divergences.newEntries.length + result.divergences.updates.length + result.divergences.invalidations.length} facts extracted`);
    }

    // ── Apply witness corrections from seal audit ──
    if (result.witnessCorrections && Object.keys(result.witnessCorrections).length > 0) {
        try {
            const corrections = result.witnessCorrections;
            const patchPayload: { sceneId: string; witnesses: string[]; witnessSource: string }[] = [];
            for (const [sceneId, names] of Object.entries(corrections)) {
                if (names.length > 0) {
                    patchPayload.push({ sceneId, witnesses: names, witnessSource: 'seal_correction' });
                }
            }
            if (patchPayload.length > 0) {
                await api.archive.patchWitnesses(activeCampaignId, patchPayload);
                const freshIndex = await api.archive.getIndex(activeCampaignId);
                callbacks.setArchiveIndex(freshIndex);
                console.log(`[CombinedSeal] Applied witness corrections for ${Object.keys(corrections).length} scenes`);
            }
        } catch (e) {
            console.warn('[CombinedSeal] Failed to apply witness corrections:', e);
        }
    }

    // ── Apply scene event corrections/backfill from seal audit ──
    if (result.sceneEventMap && Object.keys(result.sceneEventMap).length > 0) {
        try {
            const patches = Object.entries(result.sceneEventMap).map(([sceneId, events]) => ({
                sceneId,
                events
            }));
            await api.archive.patchEvents(activeCampaignId, patches);
            const freshIndex = await api.archive.getIndex(activeCampaignId);
            callbacks.setArchiveIndex(freshIndex);
            console.log(`[CombinedSeal] Applied scene events backfill for ${patches.length} scenes`);
        } catch (e) {
            console.warn('[CombinedSeal] Failed to apply scene events backfill:', e);
        }
    }

    const latestChapters = await api.chapters.list(activeCampaignId);
    state.setChapters(latestChapters);

    if (result.summary) {
        console.log(`[CombinedSeal] Summary generated for "${chapter.title}"`);
    }
}


async function runPressureTrack(
    state: TurnState,
    callbacks: TurnCallbacks,
    displayInput: string,
    npcLedger: import('../../types').NPCEntry[],
    activeCampaignId: string,
    lastAssistantContent: string
): Promise<void> {
    if (!npcLedger || npcLedger.length === 0) return;

    const archiveIndex = state.archiveIndex;
    const sceneNumber = archiveIndex.length > 0
        ? parseInt(archiveIndex[archiveIndex.length - 1].sceneId, 10) || 0
        : 0;

    const loreHeadersSet = new Set<string>();
    if (state.loreChunks) {
        for (const chunk of state.loreChunks) {
            if (chunk.header) loreHeadersSet.add(chunk.header.toLowerCase());
        }
    }
    const activeNPCs = npcLedger.filter(npc => {
        if (npc.archived) return false;
        if (!npc.name) return false;
        if (loreHeadersSet.has(npc.name.toLowerCase())) return false;
        return true;
    });

    if (activeNPCs.length === 0) return;

    const updates = scanPressure(displayInput, activeNPCs);
    if (updates.length === 0) return;

    const guardedUpdateNPC = (id: string, patch: Parameters<typeof callbacks.updateNPC>[1]) => {
        const currentId = useAppStore.getState().activeCampaignId;
        if (currentId !== activeCampaignId) return;
        callbacks.updateNPC(id, patch);
    };

    for (const update of updates) {
        const npc = npcLedger.find(n => n.id === update.npcId);
        if (!npc) continue;

        const patch = buildPressurePatch(npc, update, sceneNumber);
        guardedUpdateNPC(npc.id, patch);

        if (update.reasons.length > 0) {
            console.log(`[PressureTracker] ${npc.name}: ignored=${patch.pressure?.ignored?.toFixed(1)}, engaged=${patch.pressure?.engaged?.toFixed(1)} — ${update.reasons.join(', ')}`);
        }
    }

    // ── Auto-archive stale NPCs ──
    const maxStaleTurns = useAppStore.getState().settings.autoArchiveStaleNPCsTurns ?? 0;
    const currentTurn = archiveIndex.length;
    if (maxStaleTurns > 0) {
        const guardedArchiveNPC = (id: string, turn: number, reason: string) => {
            const currentId = useAppStore.getState().activeCampaignId;
            if (currentId !== activeCampaignId) return;
            callbacks.archiveNPC(id, turn, reason);
        };

        for (const npc of activeNPCs) {
            const result = shouldArchiveNPC(npc, currentTurn, maxStaleTurns);
            if (result.shouldArchive) {
                guardedArchiveNPC(npc.id, currentTurn, result.reason);
                console.log(`[Auto-Archive] ${npc.name} archived after ${result.turnsSince} turns inactive`);
            }
        }
    }

    // ── Auto-restore archived NPCs mentioned in the response ──
    const archivedNPCs = npcLedger.filter(n => n.archived);
    if (archivedNPCs.length > 0) {
        const toRestore = findArchivedToRestore(lastAssistantContent, archivedNPCs);
        const guardedRestoreNPC = (id: string) => {
            const currentId = useAppStore.getState().activeCampaignId;
            if (currentId !== activeCampaignId) return;
            callbacks.restoreNPC(id);
        };

        for (const npcId of toRestore) {
            const npc = npcLedger.find(n => n.id === npcId);
            guardedRestoreNPC(npcId);
            if (npc) {
                console.log(`[Auto-Restore] ${npc.name} re-enters the scene`);
                toast.info(`${npc.name} re-enters the scene`);
            }
        }
    }
}