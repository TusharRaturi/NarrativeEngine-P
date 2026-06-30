import type { ArchiveChapter } from '../../types';
import type { TurnState } from '../turn/turnOrchestrator';
import { recommendContext } from '../turn/contextRecommender';

export type RecommenderResult = {
    recommendedNPCNames: string[] | undefined;
    inventoryCategories: string[] | undefined;
    profileFields: string[] | undefined;
};

export async function gatherRecommender(
    state: TurnState,
    finalInput: string,
    pinnedChapters: ArchiveChapter[] | undefined,
    signal?: AbortSignal
): Promise<RecommenderResult> {
    const { npcLedger, loreChunks, messages, context } = state;
    const utilityEndpoint = state.getUtilityEndpoint?.();

    if (!utilityEndpoint?.endpoint) {
        return { recommendedNPCNames: undefined, inventoryCategories: undefined, profileFields: undefined };
    }

    // Skip the blocking recommender call when there's nothing for it to select from.
    // The model can only return items that exist — on a fresh campaign (no NPCs, no
    // imported lore, empty inventory, blank profile) it's a pure round-trip that stalls
    // turn 1 (e.g. starter prompt / character creation) for no gain. See contextRecommender.
    const profile = context.characterProfileData;
    const hasSelectableContent =
        npcLedger.length > 0 ||
        loreChunks.some(c => !c.alwaysInclude) ||
        (context.inventoryItems?.length ?? 0) > 0 ||
        (pinnedChapters?.length ?? 0) > 0 ||
        !!(profile && (profile.name || profile.class || profile.skills?.length || profile.abilities?.length));
    if (!hasSelectableContent) {
        return { recommendedNPCNames: undefined, inventoryCategories: undefined, profileFields: undefined };
    }

    try {
        const result = await recommendContext(
            utilityEndpoint,
            npcLedger,
            loreChunks,
            messages,
            finalInput,
            signal,
            pinnedChapters,
            context.inventoryItems,
            context.characterProfileData
        );
        const { relevantNPCNames: recommendedNPCNames, inventoryCategories, profileFields } = result;
        console.log(`[ContextGatherer] Recommender returned: ${recommendedNPCNames?.length || 0} NPCs, ${result.relevantLoreIds.length} lore, ${inventoryCategories?.length || 0} inv cats, ${profileFields?.length || 0} profile fields`);
        return {
            recommendedNPCNames: recommendedNPCNames ?? undefined,
            inventoryCategories: inventoryCategories ?? undefined,
            profileFields: profileFields ?? undefined,
        };
    } catch (err) {
        console.warn('[ContextGatherer] UtilityAI recommender failed:', err);
        return { recommendedNPCNames: undefined, inventoryCategories: undefined, profileFields: undefined };
    }
}
