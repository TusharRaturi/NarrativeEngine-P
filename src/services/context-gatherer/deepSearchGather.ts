import type { ArchiveChapter } from '../../types';
import type { TurnState } from '../turnOrchestrator';
import { deepArchiveScan } from '../deepArchiveSearch';
import { queryFacts, formatFactsForContext } from '../retrieval/semanticMemory';

export type DeepSearchDeps = {
    deepSearchThisTurn: boolean;
    chapters: ArchiveChapter[];
    setLoadingStatus?: (status: string | null) => void;
};

export async function gatherDeepSearch(
    state: TurnState,
    deps: DeepSearchDeps,
    finalInput: string,
    signal?: AbortSignal
): Promise<string | undefined> {
    if (!deps.deepSearchThisTurn || !state.activeCampaignId) {
        return undefined;
    }

    const utilityEndpoint = state.getUtilityEndpoint?.();
    if (!utilityEndpoint?.endpoint) {
        return undefined;
    }

    try {
        const sealedChapters = deps.chapters.filter(c => c.sealedAt !== undefined);
        if (sealedChapters.length > 0) {
            const deepBudget = Math.floor((state.settings.contextLimit || 8192) * 0.45);
            const deepContextSummary = await deepArchiveScan(
                utilityEndpoint,
                state.archiveIndex,
                sealedChapters,
                state.activeCampaignId,
                state.messages,
                finalInput,
                deepBudget,
                (msg) => deps.setLoadingStatus?.(msg),
                signal,
            );
            console.log(`[DeepArchiveSearch] Brief generated: ~${Math.ceil((deepContextSummary || '').length / 4)} tokens`);
            return deepContextSummary;
        }
    } catch (err) {
        console.warn('[DeepArchiveSearch] Failed, standard recall used:', err);
    }

    return undefined;
}

export function gatherSemanticFacts(
    state: TurnState,
    finalInput: string
): string | undefined {
    const semanticFacts = (state as any).semanticFacts ?? [];
    if (semanticFacts.length === 0) {
        return undefined;
    }
    const relevantFacts = queryFacts(semanticFacts, finalInput, state.messages, state.npcLedger, 500);
    return formatFactsForContext(relevantFacts) || undefined;
}
