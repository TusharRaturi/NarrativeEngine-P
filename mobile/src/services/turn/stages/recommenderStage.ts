import type { ChatMessage, LoreChunk } from '../../../types';
import type { TurnCallbacks, TurnState, UtilityLLM } from '../turnTypes';
import { recommendContext } from '../../payload';
import { tierAllows } from '../aiTier';

/**
 * AI context recommender: asks the utility LLM which NPCs and lore are relevant
 * to the current moment. Returns the recommended NPC names and, as a side
 * effect, injects recommender-picked lore chunks that keyword/semantic retrieval
 * missed into `relevantLore` (mutated in place, capped at 600 extra tokens).
 */
export async function recommenderStage(params: {
    state: TurnState;
    callbacks: TurnCallbacks;
    finalInput: string;
    messages: ChatMessage[];
    relevantLore: LoreChunk[] | undefined;
    utilityLLM: UtilityLLM;
    utilityTimeoutMs: number;
}): Promise<string[] | undefined> {
    const { state, callbacks, finalInput, messages, relevantLore, utilityLLM, utilityTimeoutMs } = params;
    const { settings, npcLedger, loreChunks } = state;

    let recommendedNPCNames: string[] | undefined;
    const utilityEndpoint = utilityLLM.endpoint();
    const pinnedChaptersForRecommender = state.pinnedChapterIds.length > 0
        ? state.chapters.filter(c => state.pinnedChapterIds.includes(c.chapterId))
        : undefined;
    if (tierAllows(settings.aiTier, 'recommender') && utilityEndpoint?.endpoint) {
        callbacks.setLoadingStatus?.('[4/5] Consulting AI Recommender...');
        try {
            const recommenderResult = await recommendContext(utilityEndpoint, npcLedger, loreChunks, messages, finalInput, pinnedChaptersForRecommender, utilityTimeoutMs);
            if (recommenderResult) {
                recommendedNPCNames = recommenderResult.relevantNPCNames;

                // Inject lore chunks the recommender picked that keyword/semantic retrieval missed
                const { relevantLoreIds } = recommenderResult;
                if (relevantLoreIds.length > 0 && loreChunks.length > 0 && relevantLore) {
                    const alreadyIn = new Set(relevantLore.map(c => c.id));
                    const RECOMMENDER_EXTRA_BUDGET = 600;
                    let extraTokens = 0;

                    for (const id of relevantLoreIds) {
                        const chunk = loreChunks.find(c => c.id === id);
                        if (!chunk || alreadyIn.has(chunk.id) || chunk.alwaysInclude) continue;
                        if (extraTokens + chunk.tokens > RECOMMENDER_EXTRA_BUDGET) continue;
                        relevantLore.push(chunk);
                        alreadyIn.add(chunk.id);
                        extraTokens += chunk.tokens;
                    }

                    if (extraTokens > 0) console.log(`[TurnContext] Recommender injected lore (${extraTokens} extra tokens)`);
                }
            }
        } catch (err) {
            console.warn('[TurnOrchestrator] UtilityAI recommender failed:', err);
        }
    }
    return recommendedNPCNames;
}
