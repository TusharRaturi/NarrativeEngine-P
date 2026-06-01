import type { GameContext, InventoryItemCategory } from '../../types';
import { countTokens } from '../tokenizer';
import { minifyBookkeepingStub, minifySelectedInventory, minifySelectedProfile } from '../contextMinifier';
import type { TraceCollector } from './traceCollector';

export function buildVolatile(opts: {
    context: GameContext;
    inventoryCategories?: (InventoryItemCategory | 'equipped')[];
    profileFields?: string[];
    collector: TraceCollector;
}): { volatileContent: string; volatileTokens: number } {
    const { context, inventoryCategories, profileFields, collector } = opts;

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
        const noteLines = context.notebook
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, 50)
            .map(n => `▸ ${n.text}`);
        volatileParts.push(`[SCENE NOTEBOOK — Volatile Working Memory]\n${noteLines.join('\n')}\n[END NOTEBOOK]`);
    }

    const volatileContent = volatileParts.join('\n\n');
    const volatileTokens = countTokens(volatileContent);
    collector.addTrace({ source: 'Profile/Inventory', classification: 'volatile_state', tokens: volatileTokens, reason: hasSmart ? 'Smart bookkeeping (stub + recommender selected)' : 'Legacy player state', included: true, position: 'system_dynamic' });
    collector.addSection({ label: 'Profile/Inventory', role: 'system', tokens: volatileTokens, content: volatileContent, classification: 'volatile_state' });

    return { volatileContent, volatileTokens };
}
