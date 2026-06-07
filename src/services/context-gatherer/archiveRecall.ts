import type { ArchiveScene, ArchiveChapter } from '../../types';
import type { TurnState } from '../turnOrchestrator';
import { recallArchiveScenes, retrieveArchiveMemory, fetchArchiveScenes } from '../archiveMemory';
import { rankChapters, recallWithChapterFunnel } from '../archiveChapterEngine';
import { runArchivePlanner } from '../archivePlanner';
import { getDivergenceSceneIds, EMPTY_REGISTER, buildSceneMap } from '../divergenceRegister';
import type { SemanticCandidates } from './semanticCandidates';

export type ArchiveRecallDeps = {
    chapters: ArchiveChapter[];
};

export async function gatherPlannerSceneIds(
    state: TurnState,
    signal?: AbortSignal
): Promise<string[] | undefined> {
    const plannerEndpoint = state.getUtilityEndpoint?.();
    const plannerTimeoutMs = (state.settings.utilityTimeoutSeconds ?? 45) * 1000;
    if (state.settings.enableArchivePlanner && plannerEndpoint?.endpoint) {
        try {
            return await runArchivePlanner(plannerEndpoint, state.input, state.archiveIndex, plannerTimeoutMs, signal);
        } catch {
            return undefined;
        }
    }
    return undefined;
}

export async function gatherArchiveRecall(
    state: TurnState,
    deps: ArchiveRecallDeps,
    semanticCandidates: SemanticCandidates,
    plannerSceneIds: string[] | undefined,
    excludeSceneIds: Set<string> | undefined,
    signal?: AbortSignal
): Promise<ArchiveScene[] | undefined> {
    const { input, messages, npcLedger, archiveIndex, activeCampaignId } = state;

    if (archiveIndex.length === 0 || !activeCampaignId) {
        return undefined;
    }

    const { semanticArchiveIds } = semanticCandidates;
    const archiveRecallDepth = state.settings.archiveRecallDepth ?? 'standard';
    const divergenceSceneIds = getDivergenceSceneIds(state.divergenceRegister || EMPTY_REGISTER);
    const chapters = deps.chapters;
    const hasSealedChapters = chapters.some(c => c.sealedAt && c.summary);

    if (!hasSealedChapters) {
        return recallArchiveScenes(
            activeCampaignId, archiveIndex, input, messages, 3000,
            npcLedger, (state as any).semanticFacts,
            undefined, semanticArchiveIds,
            divergenceSceneIds,
            excludeSceneIds,
            plannerSceneIds,
            archiveRecallDepth
        );
    }

    const rankedChapters = rankChapters(
        chapters, input, messages, npcLedger, (state as any).semanticFacts
    );

    const utilityConfig = state.getUtilityEndpoint?.();
    const FUNNEL_TIMEOUT_MS = 8000;

    const funnelPromise = recallWithChapterFunnel(
        chapters, archiveIndex, input, messages,
        npcLedger, (state as any).semanticFacts, utilityConfig,
        activeCampaignId, 3000, excludeSceneIds
    );

    const timeoutPromise = new Promise<ArchiveScene[]>((resolve) => {
        setTimeout(() => {
            console.warn('[ChapterFunnel] Timeout - using top-3 fallback');
            const fallbackRanges: [string, string][] = rankedChapters
                .slice(0, 3)
                .map(ch => ch.sceneRange);
            const openChapter = chapters.find(c => !c.sealedAt);
            if (openChapter) fallbackRanges.push(openChapter.sceneRange);

            const matchedIds = retrieveArchiveMemory(
                archiveIndex, input, messages, npcLedger,
                undefined, (state as any).semanticFacts, fallbackRanges,
                undefined, semanticArchiveIds,
                divergenceSceneIds,
                excludeSceneIds,
                plannerSceneIds,
                archiveRecallDepth
            );
            fetchArchiveScenes(activeCampaignId!, matchedIds, 3000)
                .then(resolve)
                .catch(() => resolve([]));
        }, FUNNEL_TIMEOUT_MS);
    });

    let archiveRecall = await Promise.race([funnelPromise, timeoutPromise]);

    if (archiveRecall.length === 0) {
        console.warn('[ChapterFunnel] Empty result - falling back to flat retrieval');
        archiveRecall = await recallArchiveScenes(
            activeCampaignId, archiveIndex, input, messages, 3000,
            npcLedger, (state as any).semanticFacts,
            undefined, semanticArchiveIds,
            divergenceSceneIds,
            excludeSceneIds,
            plannerSceneIds,
            archiveRecallDepth
        );
    }

    return archiveRecall;
}

export function buildExcludeSceneIds(state: TurnState): Set<string> | undefined {
    const { messages, archiveIndex } = state;
    const candidateMessages = (state.condenser?.condensedUpToIndex !== undefined && state.condenser.condensedUpToIndex >= 0)
        ? messages.slice(state.condenser.condensedUpToIndex + 1)
        : messages;
    const sceneMap = archiveIndex.length > 0 ? buildSceneMap(archiveIndex, candidateMessages) : null;
    return sceneMap
        ? new Set(Object.values(sceneMap.sceneIdsByMessageId))
        : undefined;
}
