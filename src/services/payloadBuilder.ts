import type { AppSettings, ChatMessage, GameContext, LoreChunk, NPCEntry, ArchiveScene, ArchiveIndexEntry, PayloadTrace, TimelineEvent, DebugSection, InventoryItemCategory, DivergenceRegister, ArchiveChapter } from '../types';
import type { OpenAIMessage } from './llmService';
import { createTraceCollector } from './payload/traceCollector';
import { computeBudgets } from './payload/budgets';
import { buildStable } from './payload/stable';
import { buildWorld } from './payload/world';
import { buildVolatile } from './payload/volatile';
import { buildHistory } from './payload/history';

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
    rulesManifest?: string
): { messages: OpenAIMessage[]; trace?: PayloadTrace[]; debugSections?: DebugSection[] } {
    const isDebug = settings.debugMode === true;
    const limit = settings.contextLimit || 8192;
    const collector = createTraceCollector(isDebug);
    const { rulesBudget, budgetMap } = computeBudgets(limit, settings.rulesBudgetPct, !!deepContextSummary);
    const { stableContent, stableTokens } = buildStable({ settings, context, sceneNumber, relevantRules, rulesManifest, rulesBudget, collector });
    const { worldContent, currentWorldTokens } = buildWorld({ history, userMessage, condensedUpToIndex, relevantLore, npcLedger, archiveRecall, recommendedNPCNames, semanticFactText, archiveIndex, timelineEvents, deepContextSummary, divergenceRegister, chapters, onStageNpcIds, loreRaw: context.loreRaw, budgetWorld: budgetMap.world, isDebug, collector });
    const { volatileContent, volatileTokens } = buildVolatile({ context, inventoryCategories, profileFields, collector });
    const fitted = buildHistory({ history, condensedUpToIndex, userMessage, limit, stableTokens, currentWorldTokens, volatileTokens, context, collector });

    // --- 8. Final Assembly ---
    const messages: OpenAIMessage[] = [];
    if (stableContent) messages.push({ role: 'system', content: stableContent });
    if (worldContent || volatileContent) {
        messages.push({ role: 'system', content: [worldContent, volatileContent].filter(Boolean).join('\n\n') });
    }
    messages.push(...fitted);
    messages.push({ role: 'system', content: '[GM REMINDER: NPCs push back when their wants/boundaries are crossed. Do not default to facilitation.]' });
    messages.push({ role: 'user', content: userMessage });

    return { messages, trace: isDebug ? collector.trace : undefined, debugSections: isDebug ? collector.debugSections : undefined };
}
