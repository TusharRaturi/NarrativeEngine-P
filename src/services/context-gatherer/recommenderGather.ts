import type { ArchiveChapter } from '../../types';
import type { TurnState } from '../turnOrchestrator';
import { recommendContext } from '../contextRecommender';

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
