import type { ChatMessage, NPCEntry, SceneStakes, PipelinePhase } from '../../types';
import type { TurnCallbacks, TurnState } from './turnOrchestrator';
import type { OpenAIMessage } from '../llm/llmService';
import { runPostTurnPipeline } from './postTurnPipeline';
import { classifySceneStakes } from './sceneStakesTag';
import { tierAllows } from './aiTier';
import { shouldCondense, computeTrimIndex, getCondenseBudgetRatio } from '../archive-memory/condenser';
import { toast } from '../../components/Toast';
import { useAppStore } from '../../store/useAppStore';
import { saveCampaignState } from '../../store/campaignStore';

// ── In-memory snapshot ─────────────────────────────────────────────────
// Lost on crash — that's OK. Relaunch reconciliation rebuilds from the live
// store (no "next turn's messages" exist after a crash, so live == snapshot).
interface PendingTurnSnapshot {
    turnState: TurnState;               // ORIGINAL reference — do NOT rebuild from live
    messages: ChatMessage[];              // messages at swipe-1 completion time (frozen)
    cachedPayload: OpenAIMessage[];      // for swipes 2–5 (sanitizePayloadForApi(false))
    displayInput: string;                // user's display input for this turn
    activeCampaignId: string;            // campaign at turn time
    npcLedger: NPCEntry[];               // ledger at turn time
}

let pendingSnapshot: PendingTurnSnapshot | null = null;

export function capturePendingTurnSnapshot(
    state: TurnState,
    cachedPayload: OpenAIMessage[],
    displayInput: string,
): void {
    pendingSnapshot = {
        turnState: state,
        messages: [...state.getMessages()],
        cachedPayload: [...cachedPayload],
        displayInput,
        activeCampaignId: state.activeCampaignId ?? '',
        npcLedger: state.npcLedger,
    };
}

export function clearPendingTurnSnapshot(): void {
    pendingSnapshot = null;
}

export function getPendingTurnSnapshot(): PendingTurnSnapshot | null {
    return pendingSnapshot;
}

export function getCachedSwipePayload(): OpenAIMessage[] | null {
    return pendingSnapshot?.cachedPayload ?? null;
}

// ── Find the latest GM message with a pending commit ───────────────────
// mainApp stamps sceneId on committed messages (WO-F) instead of inserting a
// scene-marker system message. So the scan stops at a message with sceneId set
// (committed) OR at a user message — only the un-committed tail is eligible.
export function findPendingCommitMessage(messages: ChatMessage[]): ChatMessage | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === 'assistant' && m.pendingCommit) return m;
        // Stop at a committed assistant message (sceneId is set) or a user message —
        // the pending message is always the latest GM bubble in the un-committed tail.
        if (m.role === 'assistant' && m.sceneId) break;
        if (m.role === 'user') break;
    }
    return null;
}

// ── Build fresh callbacks from the live store for commit ────────────────
function buildCommitCallbacks(activeCampaignId: string): TurnCallbacks {
    return {
        onCheckingNotes: () => {},
        addMessage: (msg) => useAppStore.getState().addMessage(msg),
        updateLastAssistant: (content) => useAppStore.getState().updateLastAssistant(content),
        updateLastMessage: (patch) => {
            const msgs = useAppStore.getState().messages;
            if (msgs.length > 0) useAppStore.getState().updateLastMessage(patch);
        },
        updateContext: (patch) => useAppStore.getState().updateContext(patch),
        setArchiveIndex: (entries) => useAppStore.getState().setArchiveIndex(entries),
        setTimeline: (events) => useAppStore.getState().setTimeline(events),
        updateNPC: (id, patch) => useAppStore.getState().updateNPC(id, patch),
        addNPC: (npc) => useAppStore.getState().addNPC(npc),
        addNpcSuggestions: (names, ctx) => useAppStore.getState().addNpcSuggestions(names, ctx),
        setCondensed: (upToIndex) => useAppStore.getState().setCondensed(upToIndex),
        setStreaming: () => {},
        setLastPayloadTrace: useAppStore.getState().setLastPayloadTrace,
        setLoadingStatus: () => {},
        setPipelinePhase: (phase: PipelinePhase) => useAppStore.getState().setPipelinePhase(phase),
        setDivergenceRegister: (reg) => {
            useAppStore.getState().setDivergenceRegister(reg);
            if (activeCampaignId) {
                import('../../store/campaignStore')
                    .then(m => m.saveDivergenceRegister(activeCampaignId, reg))
                    .catch(e => console.warn('[Commit] saveDivergenceRegister failed:', e));
            }
        },
        setOnStageNpcIds: (ids) => useAppStore.getState().setOnStageNpcIds(ids),
        archiveNPC: (id, turn, reason) => useAppStore.getState().archiveNPC(id, turn, reason),
        restoreNPC: (id) => useAppStore.getState().restoreNPC(id),
        stageInventoryProposal: (proposal) => {
            // No direct store slot; surface via a custom event the ChatArea listens to.
            // For the commit path this is unlikely (swipes send tools: undefined), but
            // wire it for parity so a late proposal doesn't crash.
            window.dispatchEvent(new CustomEvent('stage-inventory-proposal', { detail: proposal }));
        },
    };
}

// ── commitPendingTurn ──────────────────────────────────────────────────
// Fires runPostTurnPipeline with the visible variant's CURRENT (possibly edited)
// text. Guards against late swipe results. Reworded failure toast for the
// commit path. Auto-condense runs here (moved out of the orchestrator onDone).
export async function commitPendingTurn(): Promise<void> {
    const snapshot = pendingSnapshot;
    const store = useAppStore.getState();
    const messages = store.messages;

    const pendingMsg = findPendingCommitMessage(messages);
    if (!pendingMsg || !pendingMsg.swipeSet) {
        // No pending turn (normal first-turn case, or already committed).
        clearPendingTurnSnapshot();
        return;
    }

    const variantIdx = pendingMsg.swipeActiveIndex ?? 0;
    const variant = pendingMsg.swipeSet[variantIdx];
    if (!variant) {
        clearPendingTurnSnapshot();
        return;
    }

    // The visible variant's CURRENT text — read from the message content
    // (which reflects edits the user may have made while browsing).
    const text = pendingMsg.content;

    // Determine scene stakes from the chosen variant.
    let sceneStakes: SceneStakes = variant.sceneStakes;
    if (!variant.tagPresent) {
        const utilityProvider = snapshot?.turnState.getUtilityEndpoint?.() ?? store.getActiveUtilityEndpoint?.();
        const aiTier = snapshot?.turnState.settings.aiTier ?? store.settings.aiTier;
        if (utilityProvider && tierAllows(aiTier, 'sceneStakesClassify')) {
            try {
                const recentScene = (snapshot?.messages ?? messages).slice(-3).map(m => {
                    const role = m.role === 'assistant' ? 'GM' : m.role.toUpperCase();
                    return `[${role}]: ${(m.content || '').slice(0, 500)}`;
                }).join('\n\n');
                sceneStakes = await classifySceneStakes(utilityProvider, recentScene + '\n\n' + text.slice(0, 1000));
            } catch (e) {
                console.warn('[Commit] scene-stakes fallback classify failed:', e);
            }
        }
    }

    // Update context with lastSceneStakes from the chosen variant (commit only).
    store.updateContext({ lastSceneStakes: sceneStakes });

    // Build the commit state — use the ORIGINAL TurnState reference but
    // override getMessages so the importance rater reads the snapshot,
    // never live getMessages() (a late commit must not see the next turn's messages).
    const commitState: TurnState = snapshot
        ? { ...snapshot.turnState, getMessages: () => snapshot.messages }
        : rebuildStateFromLiveStore(store);

    const commitCallbacks = buildCommitCallbacks(commitState.activeCampaignId ?? '');
    const snapshotMessages = commitState.getMessages();

    try {
        await runPostTurnPipeline(commitState, commitCallbacks, text, snapshotMessages);

        // Auto-condense check — moved to commit (was in the orchestrator completion callback).
        if (commitState.settings.autoCondenseEnabled) {
            const allMsgs = commitState.getMessages();
            if (shouldCondense(allMsgs, commitState.settings.contextLimit, commitState.condenser.condensedUpToIndex, getCondenseBudgetRatio(commitState.settings.condenseAggressiveness ?? 'smart'))) {
                const newIndex = computeTrimIndex(allMsgs, commitState.condenser.condensedUpToIndex);
                if (newIndex !== commitState.condenser.condensedUpToIndex) {
                    useAppStore.getState().setCondensed(newIndex);
                }
            }
        }
    } catch (err) {
        console.error('[Commit] runPostTurnPipeline failed:', err);
        toast.error('Turn committed but some archive updates may be missing. Your story is saved.');
    }

    // Clear the swipe set + pendingCommit marker — the bubble is now a
    // normal historical message. Flush immediately (commit path should not debounce).
    const freshStore = useAppStore.getState();
    const freshMsgs = freshStore.messages;
    const idx = freshMsgs.findIndex(m => m.id === pendingMsg.id);
    if (idx !== -1) {
        const updated = [...freshMsgs];
        const { swipeSet: _ss, pendingCommit: _pc, swipeActiveIndex: _si, ...rest } = updated[idx];
        updated[idx] = rest as ChatMessage;
        useAppStore.setState({ messages: updated });
        const activeCampaignId = commitState.activeCampaignId;
        if (activeCampaignId) {
            saveCampaignState(activeCampaignId, {
                context: useAppStore.getState().context,
                messages: updated,
                condenser: useAppStore.getState().condenser,
                pinnedExcerpts: useAppStore.getState().pinnedExcerpts,
            }).catch(e => console.warn('[Commit] saveCampaignState failed:', e));
        }
    }

    clearPendingTurnSnapshot();
}

// ── Rebuild TurnState from the live store (crash recovery path) ────────
// Used when pendingCommit is true on launch but the in-memory snapshot was
// lost (Electron/renderer death). At relaunch, no "next turn's messages"
// exist, so reading live is safe — the snapshot invariant (don't see the
// next turn's messages) holds vacuously.
function rebuildStateFromLiveStore(store: ReturnType<typeof useAppStore.getState>): TurnState {
    return {
        input: '',
        displayInput: '',
        settings: store.settings,
        context: store.context,
        messages: store.messages,
        condenser: store.condenser,
        loreChunks: store.loreChunks,
        npcLedger: store.npcLedger,
        archiveIndex: store.archiveIndex,
        activeCampaignId: store.activeCampaignId,
        provider: store.getActiveStoryEndpoint(),
        getMessages: () => useAppStore.getState().messages,
        getFreshProvider: () => store.getActiveStoryEndpoint(),
        getUtilityEndpoint: () => store.getActiveUtilityEndpoint(),
        getFreshAuxiliaryProvider: () => {
            const aux = store.getActiveAuxiliaryEndpoint?.();
            return aux?.modelName ? aux : store.getActiveStoryEndpoint();
        },
        chapters: store.chapters ?? [],
        pinnedChapterIds: useAppStore.getState().pinnedChapterIds,
        clearPinnedChapters: () => useAppStore.getState().clearPinnedChapters(),
        setChapters: (chapters) => useAppStore.getState().setChapters(chapters),
        incrementBookkeepingTurnCounter: () => useAppStore.getState().incrementBookkeepingTurnCounter(),
        resetBookkeepingTurnCounter: () => useAppStore.getState().resetBookkeepingTurnCounter(),
        autoBookkeepingInterval: useAppStore.getState().autoBookkeepingInterval,
        getFreshContext: () => useAppStore.getState().context,
        timeline: store.timeline,
        divergenceRegister: store.divergenceRegister,
        onStageNpcIds: store.onStageNpcIds,
        pinnedExcerpts: store.pinnedExcerpts,
    };
}

// ── Launch reconciliation ──────────────────────────────────────────────
// On app launch, if any message has pendingCommit=true, fire runPostTurnPipeline
// with the then-visible variant's text, then clear the marker. Covers
// Electron/renderer death mid-browse.
export async function reconcilePendingCommitOnLaunch(): Promise<void> {
    const store = useAppStore.getState();
    const pendingMsg = findPendingCommitMessage(store.messages);
    if (!pendingMsg || !pendingMsg.swipeSet) return;

    console.log('[Reconcile] Found pendingCommit on launch — firing deferred runPostTurnPipeline');
    await commitPendingTurn();
}

// ── Swipe-set helpers ──────────────────────────────────────────────────
// Check if a message is the latest GM message (eligible for 🔄)
export function isLatestGmMessage(messages: ChatMessage[], msgId: string): boolean {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === 'assistant') return m.id === msgId;
        // Skip trailing system messages (timeskip-seam, etc.)
        if (m.role === 'system') continue;
        // If we hit a user message first, this isn't the latest GM
        if (m.role === 'user') return false;
    }
    return false;
}

// Check if a message has a browseable swipe set (pre-commit)
export function hasSwipeSet(msg: ChatMessage | undefined): boolean {
    return !!(msg && msg.swipeSet && msg.swipeSet.length > 0 && msg.pendingCommit);
}