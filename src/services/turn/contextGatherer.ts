import type { ArchiveChapter, TimelineEvent } from '../../types';
import type { TurnState } from './turnOrchestrator';
import { API_BASE as API } from '../../lib/apiBase';
import { gatherSemanticCandidates } from '../context-gatherer/semanticCandidates';
import { gatherPlannerSceneIds, gatherArchiveRecall, buildExcludeSceneIds } from '../context-gatherer/archiveRecall';
import { gatherRecommender } from '../context-gatherer/recommenderGather';
import { gatherLoreAndRules } from '../context-gatherer/loreRulesGather';
import { injectPinnedChapters } from '../context-gatherer/pinnedChaptersGather';
import { gatherDeepSearch, gatherSemanticFacts } from '../context-gatherer/deepSearchGather';
import { beginGatherStage, endGatherStage, clearGatherStages } from './gatherProgress';
import { AI_CALL_TIMEOUT_MS } from '../llm/timeouts';
import type { LoreChunk } from '../../types';

// Friendly, user-facing labels for the live step indicator (keyed by internal stage id).
const STAGE_LABELS: Record<string, string> = {
    'planner': 'Planning search',
    'semantic-candidates': 'Searching memory',
    'next-scene': 'Assigning scene',
    'archive-recall': 'Recalling scenes',
    'recommender': 'Selecting context',
    'lore-rules': 'Loading lore & rules',
    'deep-search': 'Deep archive search',
};

export type GatheredContext = {
    sceneNumber: string | undefined;
    archiveRecall: import('../../types').ArchiveScene[] | undefined;
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

    // ─── Per-stage timing (debug only) ───
    // Surfaces what's actually slow during "GATHERING CONTEXT" — including non-LLM work
    // (fetches, archive recall) that the UtilityCallStrip can't see. Logged as one line
    // when debugMode or verbose utility logging is on; zero overhead otherwise.
    const debugTrace = !!(state.settings.debugMode || state.settings.verboseUtilityLogging);
    const gatherStart = performance.now();
    const traceTimings: Record<string, number> = {};
    clearGatherStages();
    // Always publishes the active stage to the live UI; records timing only under debug.
    const timed = <T,>(label: string, p: Promise<T>): Promise<T> => {
        const friendly = STAGE_LABELS[label] ?? label;
        beginGatherStage(friendly);
        const t0 = performance.now();
        return p.finally(() => {
            endGatherStage(friendly);
            if (debugTrace) traceTimings[label] = Math.round(performance.now() - t0);
        });
    };

    // ─── Kick off planner and semantic candidates in parallel ───
    const plannerPromise = timed('planner', gatherPlannerSceneIds(state, signal));

    const semanticPromise = timed('semantic-candidates', activeCampaignId
        ? gatherSemanticCandidates(state, signal)
        : Promise.resolve({ semanticArchiveIds: undefined, semanticLoreIds: undefined, semanticRuleIds: undefined }));

    // Scene number (next-scene endpoint) — fire-and-forget, result captured via mutation
    let sceneNumber: string | undefined;
    const timelinePromise = timed('next-scene', activeCampaignId
        ? fetch(`${API}/campaigns/${activeCampaignId}/archive/next-scene`, { signal })
            .then(async res => {
                if (res.ok) {
                    const snData = await res.json();
                    sceneNumber = snData.sceneId;
                    console.log(`[Scene Engine] Pre-assigned scene #${sceneNumber}`);
                }
            }).catch(() => { /* ignored */ })
        : Promise.resolve());

    // Pinned chapters for recommender (computed before awaiting)
    const pinnedChaptersForRecommender = deps.pinnedChapterIds.length > 0
        ? deps.chapters.filter(c => deps.pinnedChapterIds.includes(c.chapterId))
        : undefined;

    // ─── Archive recall — depends on semantic candidates + planner ───
    const archiveRecallPromise = timed('archive-recall', (async () => {
        const [semanticCandidates, plannerSceneIds] = await Promise.all([semanticPromise, plannerPromise]);
        return gatherArchiveRecall(state, { chapters: deps.chapters }, semanticCandidates, plannerSceneIds, excludeSceneIds, signal);
    })());

    // ─── Recommender — independent ───
    const recommenderPromise = timed('recommender', gatherRecommender(state, finalInput, pinnedChaptersForRecommender, signal));

    // ─── Lore & rules — depend on semantic candidates ───
    const loreRulesPromise = timed('lore-rules', (async () => {
        const semanticCandidates = await semanticPromise;
        return gatherLoreAndRules(state, semanticCandidates);
    })());

    // Timeline events — from state, used directly
    const timelineEvents: TimelineEvent[] = state.timeline || [];

    // ─── Await all async operations with a safety backstop ───
    // Raised to match the AI-call budget: gather waits for slow stages rather than
    // bailing early, and the live step indicator (GenerationProgress) shows what's
    // running so the user sees movement instead of a frozen "GATHERING CONTEXT".
    // Individual calls have their own (tighter) timeouts, so this is just a backstop.
    const CONTEXT_GATHER_TIMEOUT_MS = AI_CALL_TIMEOUT_MS;
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
    const deepContextSummary = await timed('deep-search', gatherDeepSearch(
        state,
        { deepSearchThisTurn: deps.deepSearchThisTurn, chapters: deps.chapters, setLoadingStatus: deps.setLoadingStatus },
        finalInput,
        signal
    ));

    // ─── Semantic Facts ───
    const semanticFactText = gatherSemanticFacts(state, finalInput);

    if (debugTrace) {
        const total = Math.round(performance.now() - gatherStart);
        const breakdown = Object.entries(traceTimings)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `${k}=${v}ms`)
            .join('  ');
        console.log(`[GatherTrace] total=${total}ms | ${breakdown}`);
    }

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
