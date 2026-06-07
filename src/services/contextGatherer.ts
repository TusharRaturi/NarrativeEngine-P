import type { ArchiveChapter, TimelineEvent } from '../types';
import type { TurnState } from './turnOrchestrator';
import { API_BASE as API } from '../lib/apiBase';
import { gatherSemanticCandidates } from './context-gatherer/semanticCandidates';
import { gatherPlannerSceneIds, gatherArchiveRecall, buildExcludeSceneIds } from './context-gatherer/archiveRecall';
import { gatherRecommender } from './context-gatherer/recommenderGather';
import { gatherLoreAndRules } from './context-gatherer/loreRulesGather';
import { injectPinnedChapters } from './context-gatherer/pinnedChaptersGather';
import { gatherDeepSearch, gatherSemanticFacts } from './context-gatherer/deepSearchGather';
import type { LoreChunk } from '../types';

export type GatheredContext = {
    sceneNumber: string | undefined;
    archiveRecall: import('../types').ArchiveScene[] | undefined;
    recommendedNPCNames: string[] | undefined;
    timelineEvents: TimelineEvent[];
    relevantLore: LoreChunk[] | undefined;
    semanticArchiveIds: string[] | undefined;
    semanticLoreIds: string[] | undefined;
    inventoryCategories: string[] | undefined;
    profileFields: string[] | undefined;
    deepContextSummary?: string;
    semanticFactText?: string;
    relevantRules?: LoreChunk[];
    rulesManifest?: string;
};

type GatherDeps = {
    chapters: ArchiveChapter[];
    pinnedChapterIds: string[];
    clearPinnedChapters: () => void;
    deepSearchThisTurn: boolean;
    setLoadingStatus?: (status: string | null) => void;
};

export async function gatherContext(
    state: TurnState,
    finalInput: string,
    deps: GatherDeps,
    signal?: AbortSignal
): Promise<GatheredContext> {
    const { activeCampaignId } = state;

    const excludeSceneIds = buildExcludeSceneIds(state);

    // ─── Kick off planner and semantic candidates in parallel ───
    const plannerPromise = gatherPlannerSceneIds(state, signal);

    const semanticPromise = activeCampaignId
        ? gatherSemanticCandidates(state, signal)
        : Promise.resolve({ semanticArchiveIds: undefined, semanticLoreIds: undefined, semanticRuleIds: undefined });

    // Scene number (next-scene endpoint) — fire-and-forget, result captured via mutation
    let sceneNumber: string | undefined;
    const timelinePromise = activeCampaignId
        ? fetch(`${API}/campaigns/${activeCampaignId}/archive/next-scene`, { signal })
            .then(async res => {
                if (res.ok) {
                    const snData = await res.json();
                    sceneNumber = snData.sceneId;
                    console.log(`[Scene Engine] Pre-assigned scene #${sceneNumber}`);
                }
            }).catch(() => { /* ignored */ })
        : Promise.resolve();

    // Pinned chapters for recommender (computed before awaiting)
    const pinnedChaptersForRecommender = deps.pinnedChapterIds.length > 0
        ? deps.chapters.filter(c => deps.pinnedChapterIds.includes(c.chapterId))
        : undefined;

    // ─── Archive recall — depends on semantic candidates + planner ───
    const archiveRecallPromise = (async () => {
        const [semanticCandidates, plannerSceneIds] = await Promise.all([semanticPromise, plannerPromise]);
        return gatherArchiveRecall(state, { chapters: deps.chapters }, semanticCandidates, plannerSceneIds, excludeSceneIds, signal);
    })();

    // ─── Recommender — independent ───
    const recommenderPromise = gatherRecommender(state, finalInput, pinnedChaptersForRecommender, signal);

    // ─── Lore & rules — depend on semantic candidates ───
    const loreRulesPromise = (async () => {
        const semanticCandidates = await semanticPromise;
        return gatherLoreAndRules(state, semanticCandidates);
    })();

    // Timeline events — from state, used directly
    const timelineEvents: TimelineEvent[] = state.timeline || [];

    // ─── Await all async operations with a 15s safety timeout ───
    const CONTEXT_GATHER_TIMEOUT_MS = 15_000;
    await Promise.race([
        Promise.all([timelinePromise, archiveRecallPromise, recommenderPromise, loreRulesPromise, plannerPromise]),
        new Promise<void>((resolve) => setTimeout(() => {
            console.warn('[ContextGatherer] Context gather timeout — proceeding with partial results');
            resolve();
        }, CONTEXT_GATHER_TIMEOUT_MS)),
    ]);

    let archiveRecall = await archiveRecallPromise;
    const recommender = await recommenderPromise;
    const { relevantLore, relevantRules, rulesManifest } = await loreRulesPromise.catch(() => ({ relevantLore: undefined, relevantRules: [], rulesManifest: '' }));
    const semanticCandidates = await semanticPromise;
    const plannerSceneIds = await plannerPromise;

    // ─── Pinned Chapter Injection ───
    archiveRecall = await injectPinnedChapters(
        state,
        { pinnedChapterIds: deps.pinnedChapterIds, chapters: deps.chapters, clearPinnedChapters: deps.clearPinnedChapters },
        archiveRecall,
        semanticCandidates,
        plannerSceneIds,
        excludeSceneIds
    );

    // ─── Deep Archive Search (one-shot) ───
    const deepContextSummary = await gatherDeepSearch(
        state,
        { deepSearchThisTurn: deps.deepSearchThisTurn, chapters: deps.chapters, setLoadingStatus: deps.setLoadingStatus },
        finalInput,
        signal
    );

    // ─── Semantic Facts ───
    const semanticFactText = gatherSemanticFacts(state, finalInput);

    return {
        sceneNumber,
        archiveRecall,
        recommendedNPCNames: recommender.recommendedNPCNames,
        timelineEvents,
        relevantLore,
        semanticArchiveIds: semanticCandidates.semanticArchiveIds,
        semanticLoreIds: semanticCandidates.semanticLoreIds,
        inventoryCategories: recommender.inventoryCategories,
        profileFields: recommender.profileFields,
        deepContextSummary,
        semanticFactText,
        relevantRules,
        rulesManifest,
    };
}
