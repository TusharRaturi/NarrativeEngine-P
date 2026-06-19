import type { AppSettings, ChatMessage, GameContext, LoreChunk, NPCEntry, ArchiveScene, ArchiveIndexEntry, PayloadTrace, TimelineEvent, DebugSection, InventoryItemCategory, DivergenceRegister, ArchiveChapter, PinnedExcerpt } from '../types';
import type { OpenAIMessage } from './llmService';
import { createTraceCollector } from './payload/traceCollector';
import { computeBudgets } from './payload/budgets';
import { buildStable } from './payload/stable';
import { buildWorld } from './payload/world';
import { buildVolatile } from './payload/volatile';
import { buildHistory } from './payload/history';
import { buildPinnedMemoriesBlock } from './payload/pinnedMemories';

export function buildPayload(
    settings: AppSettings,
    context: GameContext,
    history: ChatMessage[],
    userMessage: string,
    condensedUpToIndex?: number,
    relevantLore?: LoreChunk[],
    npcLedger?: NPCEntry[],
    archiveRecall?: ArchiveScene[],
    sceneNumber?: string,
    recommendedNPCNames?: string[],
    semanticFactText?: string,
    archiveIndex?: ArchiveIndexEntry[],
    timelineEvents?: TimelineEvent[],
    inventoryCategories?: (InventoryItemCategory | 'equipped')[],
    profileFields?: string[],
    deepContextSummary?: string,
    divergenceRegister?: DivergenceRegister,
    chapters?: ArchiveChapter[],
    onStageNpcIds?: string[],
    relevantRules?: LoreChunk[],
    rulesManifest?: string,
    pinnedExcerpts?: PinnedExcerpt[],
): { messages: OpenAIMessage[]; trace?: PayloadTrace[]; debugSections?: DebugSection[] } {
    const isDebug = settings.debugMode === true;
    const limit = settings.contextLimit || 8192;
    const collector = createTraceCollector(isDebug);
    const { rulesBudget, budgetMap } = computeBudgets(limit, settings.rulesBudgetPct, !!deepContextSummary);
    const { stableContent, stableTokens } = buildStable({ settings, context, sceneNumber, relevantRules, rulesManifest, rulesBudget, budgetStable: budgetMap.stable, collector });
    const { worldContent, currentWorldTokens, divergenceContent, divergenceTokens } = buildWorld({ history, userMessage, condensedUpToIndex, relevantLore, npcLedger, archiveRecall, recommendedNPCNames, semanticFactText, archiveIndex, timelineEvents, deepContextSummary, divergenceRegister, chapters, onStageNpcIds, loreRaw: context.loreRaw, agencyDigest: context.agencyDigest, arcDigest: context.arcDigest, budgetWorld: budgetMap.world, isDebug, collector });
    const { volatileContent, volatileTokens } = buildVolatile({ context, inventoryCategories, profileFields, budgetVolatile: budgetMap.volatile, collector });
    const fitted = buildHistory({ history, condensedUpToIndex, userMessage, limit, stableTokens: stableTokens + divergenceTokens, currentWorldTokens, volatileTokens, context, collector });

    // --- 8. Final Assembly ---
    // Stable, divergence, and pinned blocks get cache_control: ephemeral for Anthropic prompt caching.
    // These blocks change infrequently across turns, making them ideal cache hit candidates.
    const cacheControl = { type: 'ephemeral' as const };
    const messages: OpenAIMessage[] = [];
    if (stableContent) messages.push({ role: 'system', content: stableContent, cache_control: cacheControl });
    if (divergenceContent) messages.push({ role: 'system', content: divergenceContent, cache_control: cacheControl });
    if (pinnedExcerpts && pinnedExcerpts.length > 0) {
        messages.push({ role: 'system', content: buildPinnedMemoriesBlock(pinnedExcerpts), cache_control: cacheControl });
    }

    // Push history BEFORE the volatile block so the growing campaign log rides in the cached prefix.
    messages.push(...fitted);

    // Stamp cache_control: ephemeral on the last history message so prefix-caching covers all of history.
    if (fitted.length > 0) {
        const last = messages.length - 1;
        const lastMsg = messages[last];
        if (lastMsg.role === 'user' || lastMsg.role === 'assistant') {
            messages[last] = { ...lastMsg, cache_control: { type: 'ephemeral' } };
        }
    }

    // Fold the per-turn volatile world/NPC block and the GM reminder into the final user message
    // (below the cache boundary) so they never perturb the cached prefix.
    const GM_REMINDER = '[GM REMINDER: NPCs push back when their wants/boundaries are crossed. Do not default to facilitation.]';
    const volatileBlock = [worldContent, volatileContent].filter(Boolean).join('\n\n');
    const finalUserContent = [volatileBlock, GM_REMINDER, userMessage].filter(Boolean).join('\n\n');
    messages.push({ role: 'user', content: finalUserContent });

    return { messages, trace: isDebug ? collector.trace : undefined, debugSections: isDebug ? collector.debugSections : undefined };
}
