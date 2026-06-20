import type { GameContext, InventoryItemCategory } from '../../types';
import { countTokens } from '../infrastructure/tokenizer';
import { minifyBookkeepingStub, minifySelectedInventory, minifySelectedProfile } from '../contextMinifier';
import type { TraceCollector } from './traceCollector';

export function buildVolatile(opts: {
    context: GameContext;
    inventoryCategories?: (InventoryItemCategory | 'equipped')[];
    profileFields?: string[];
    budgetVolatile: number;
    collector: TraceCollector;
}): { volatileContent: string; volatileTokens: number } {
    const { context, inventoryCategories, profileFields, budgetVolatile, collector } = opts;

    // --- 5. Volatile State (Profile, Inventory) — Smart Injection ---
    const volatileParts: string[] = [];

    const hasSmart = context.smartBookkeepingActive;
    const hasStructured = (context.inventoryItems?.length ?? 0) > 0 || context.characterProfileData?.name;

    if (hasSmart && hasStructured) {
        // Stub is always injected (cheap, prevents total amnesia)
        const stub = minifyBookkeepingStub(context.characterProfileData!, context.inventoryItems || []);
        if (stub) volatileParts.push(`[CHARACTER]
${stub}`);

        // Recommender-selected categories / fields
        const anyInventory = context.inventoryItems && context.inventoryItems.length > 0;
        const anyProfile = context.characterProfileData && context.characterProfileData.name;

        if (anyInventory && inventoryCategories && inventoryCategories.length > 0) {
            const invBlock = minifySelectedInventory(context.inventoryItems, inventoryCategories);
            if (invBlock) volatileParts.push(`[INVENTORY]
${invBlock}`);
        }
        if (anyProfile && profileFields && profileFields.length > 0) {
            const profBlock = minifySelectedProfile(context.characterProfileData, profileFields);
            if (profBlock) volatileParts.push(`[PROFILE]
${profBlock}`);
        }
    } else if (context.characterProfileActive && context.characterProfile) {
        // Legacy fallback
        const profileSceneTag = context.characterProfileLastScene && context.characterProfileLastScene !== 'Never'
            ? `Last Updated: Scene #${context.characterProfileLastScene}`
            : 'NEVER AUTO-UPDATED — may be stale';
        volatileParts.push(`[CHARACTER PROFILE — ${profileSceneTag}]\n${context.characterProfile}`);
    }
    if (!hasSmart && context.inventoryActive && context.inventory) {
        // Legacy fallback
        const inventorySceneTag = context.inventoryLastScene && context.inventoryLastScene !== 'Never'
            ? `Last Updated: Scene #${context.inventoryLastScene}`
            : 'NEVER AUTO-UPDATED — may be stale';
        volatileParts.push(`[PLAYER INVENTORY — ${inventorySceneTag}]\n${context.inventory}`);
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
            volatileParts.push(wrap(acceptedLines));
        }
        if (droppedNotes > 0) {
            collector.addTrace({ source: 'Scene Notebook', classification: 'volatile_state', tokens: 0, reason: `Trimmed ${droppedNotes} notebook entr${droppedNotes === 1 ? 'y' : 'ies'} to fit volatile budget (${budgetVolatile} t)`, included: false, position: 'system_dynamic' });
        }
    }

    const volatileContent = volatileParts.join('\n\n');
    const volatileTokens = countTokens(volatileContent);
    collector.addTrace({ source: 'Profile/Inventory', classification: 'volatile_state', tokens: volatileTokens, reason: hasSmart ? 'Smart bookkeeping (stub + recommender selected)' : 'Legacy player state', included: true, position: 'system_dynamic' });
    collector.addSection({ label: 'Profile/Inventory', role: 'system', tokens: volatileTokens, content: volatileContent, classification: 'volatile_state' });

    return { volatileContent, volatileTokens };
}
