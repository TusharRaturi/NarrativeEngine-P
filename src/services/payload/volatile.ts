import type { GameContext, InventoryItemCategory, ChatMessage, NPCEntry, SceneEventType } from '../../types';
import { CORE_FLOOR_TRAITS } from '../../types';
import { countTokens } from '../infrastructure/tokenizer';
import { minifyBookkeepingStub, minifySelectedInventory, minifySelectedProfile } from '../turn/contextMinifier';
import { queryTraits, formatTraitsForContext } from '../retrieval/semanticMemory';
import type { TraceCollector } from './traceCollector';

export function buildVolatile(opts: {
    context: GameContext;
    inventoryCategories?: (InventoryItemCategory | 'equipped')[];
    profileFields?: string[];
    budgetVolatile: number;
    collector: TraceCollector;
    plannerEventTypes?: SceneEventType[];
    userMessage?: string;
    history?: ChatMessage[];
    npcLedger?: NPCEntry[];
}): { volatileContent: string; volatileTokens: number } {
    const { context, inventoryCategories, profileFields, budgetVolatile, collector, plannerEventTypes, userMessage, history, npcLedger } = opts;

    // --- 5. Volatile State (Profile, Inventory) — Smart Injection ---
    // WO-I: capture each module's text so we can emit per-module trace rows with previews
    // (was one lumped 'Profile/Inventory' row). volatileContent/volatileTokens stay byte-identical.
    const volatileParts: string[] = [];
    let characterBlock = '';
    let inventoryBlock = '';
    let profileBlock = '';
    let notebookBlock = '';

    const hasSmart = context.smartBookkeepingActive;
    const hasStructured = (context.inventoryItems?.length ?? 0) > 0 || context.characterProfileData?.name;

    if (hasSmart && hasStructured) {
        // Stub is always injected (cheap, prevents total amnesia)
        const stub = minifyBookkeepingStub(context.characterProfileData!, context.inventoryItems || []);
        if (stub) {
            characterBlock = `[CHARACTER]\n${stub}`;
            volatileParts.push(characterBlock);
        }

        // Recommender-selected categories / fields
        const anyInventory = context.inventoryItems && context.inventoryItems.length > 0;
        const anyProfile = context.characterProfileData && context.characterProfileData.name;

        if (anyInventory && inventoryCategories && inventoryCategories.length > 0) {
            const invBlock = minifySelectedInventory(context.inventoryItems, inventoryCategories);
            if (invBlock) {
                inventoryBlock = `[INVENTORY]\n${invBlock}`;
                volatileParts.push(inventoryBlock);
            }
        }
        if (anyProfile && profileFields && profileFields.length > 0) {
            const profBlock = minifySelectedProfile(context.characterProfileData, profileFields);
            if (profBlock) {
                profileBlock = `[PROFILE]\n${profBlock}`;
                volatileParts.push(profileBlock);
            }
        }
    } else if (context.characterProfileActive && context.characterProfile) {
        // WO-G: structured PC profile — scene-aware trait retrieval via queryTraits.
        // Core floor (CORE_FLOOR_TRAITS=5) always injects; extended tier filtered by
        // planner eventTypes + entity match + 400-token budget. legacyNotes is storage-only.
        const profile = context.characterProfile;
        if (profile.activeTraits?.length || profile.identity?.name || profile.stats) {
            const selected = queryTraits(
                profile.activeTraits ?? [],
                userMessage ?? '',
                history ?? [],
                npcLedger ?? [],
                plannerEventTypes,
                400,
                CORE_FLOOR_TRAITS,
            );
            const profileText = formatTraitsForContext(profile, selected);
            if (profileText) {
                const profileSceneTag = context.characterProfileLastScene && context.characterProfileLastScene !== 'Never'
                    ? `Last Updated: Scene #${context.characterProfileLastScene}`
                    : '';
                profileBlock = profileSceneTag ? `${profileSceneTag}\n${profileText}` : profileText;
                volatileParts.push(profileBlock);
            }
        }
    }
    if (!hasSmart && context.inventoryActive && context.inventory) {
        // Legacy fallback
        const inventorySceneTag = context.inventoryLastScene && context.inventoryLastScene !== 'Never'
            ? `Last Updated: Scene #${context.inventoryLastScene}`
            : 'NEVER AUTO-UPDATED — may be stale';
        inventoryBlock = `[PLAYER INVENTORY — ${inventorySceneTag}]\n${context.inventory}`;
        volatileParts.push(inventoryBlock);
    }
    if (context.notebookActive && context.notebook && context.notebook.length > 0) {
        // Notebook is the only unbounded volatile source. Reserve whatever budget remains after the
        // higher-priority character/inventory/profile parts and admit newest-first entries until full,
        // so a large notebook can't silently overrun the context window.
        const usedTokens = countTokens(volatileParts.join('\n\n'));
        const notebookBudget = budgetVolatile > 0 ? Math.max(0, budgetVolatile - usedTokens) : Infinity;
        const sorted = context.notebook
            .slice()
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, 50);
        const wrap = (lines: string[]) => `[SCENE NOTEBOOK — Volatile Working Memory]\n${lines.join('\n')}\n[END NOTEBOOK]`;
        const acceptedLines: string[] = [];
        let droppedNotes = 0;
        for (const n of sorted) {
            const candidate = [...acceptedLines, `▸ ${n.text}`];
            if (notebookBudget === Infinity || countTokens(wrap(candidate)) <= notebookBudget) {
                acceptedLines.push(`▸ ${n.text}`);
            } else {
                droppedNotes = sorted.length - acceptedLines.length;
                break;
            }
        }
        if (acceptedLines.length > 0) {
            notebookBlock = wrap(acceptedLines);
            volatileParts.push(notebookBlock);
        }
        if (droppedNotes > 0) {
            collector.addTrace({ source: 'Scene Notebook', classification: 'volatile_state', tokens: 0, reason: `Trimmed ${droppedNotes} notebook entr${droppedNotes === 1 ? 'y' : 'ies'} to fit volatile budget (${budgetVolatile} t)`, included: false, position: 'system_dynamic' });
        }
    }

    const volatileContent = volatileParts.join('\n\n');
    const volatileTokens = countTokens(volatileContent);
    // WO-I: per-module trace rows with previews (was one lumped row).
    if (characterBlock) collector.addTrace({ source: 'Character Stub', classification: 'volatile_state', tokens: countTokens(characterBlock), reason: 'Smart bookkeeping character stub', included: true, position: 'system_dynamic', preview: characterBlock });
    if (inventoryBlock) collector.addTrace({ source: 'Inventory', classification: 'volatile_state', tokens: countTokens(inventoryBlock), reason: 'Player inventory', included: true, position: 'system_dynamic', preview: inventoryBlock });
    if (profileBlock) collector.addTrace({ source: 'Player Profile', classification: 'volatile_state', tokens: countTokens(profileBlock), reason: hasSmart ? 'Recommender-selected profile fields' : 'Scene-selected PC traits', included: true, position: 'system_dynamic', preview: profileBlock });
    if (notebookBlock) collector.addTrace({ source: 'Scene Notebook', classification: 'volatile_state', tokens: countTokens(notebookBlock), reason: 'Volatile working memory notebook', included: true, position: 'system_dynamic', preview: notebookBlock });
    collector.addSection({ label: 'Profile/Inventory', role: 'system', tokens: volatileTokens, content: volatileContent, classification: 'volatile_state' });

    return { volatileContent, volatileTokens };
}
