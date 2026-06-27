import { shouldCondense, computeTrimIndex, getCondenseBudgetRatio } from '../archive-memory/condenser';
import { useAppStore } from '../../store/useAppStore';
import type { AppSettings, GameContext, ChatMessage, NPCEntry, LoreChunk, CondenserState, ArchiveIndexEntry, TimelineEvent, EndpointConfig, ProviderConfig, ArchiveChapter, SamplingConfig, PipelinePhase, DivergenceRegister, ThinkingEffort, InventoryProposal, PayloadTrace } from '../../types';
import { uid } from '../../utils/uid';
import { buildPayload, sendMessage } from '../chatEngine';
import { rollEngines, rollDiceFairness, resolveManualRoll } from '../engine/engineRolls';
import { toast } from '../../components/Toast';
import { sanitizePayloadForApi } from '../lib/payloadSanitizer';
import { getToolDefinitions, handleLoreTool, handleNotebookTool, handleDiceTool, handleProposeInventoryTool, handleInitiateCombatTool } from './toolHandlers';
import { gatherContext } from './contextGatherer';
import { runPostTurnPipeline } from './postTurnPipeline';

export type TurnCallbacks = {
    onCheckingNotes: (checking: boolean) => void;
    addMessage: (msg: ChatMessage) => void;
    updateLastAssistant: (content: string) => void;
    updateLastMessage: (patch: Partial<ChatMessage>) => void;
    updateContext: (patch: Partial<GameContext>) => void;
    setArchiveIndex: (entries: ArchiveIndexEntry[]) => void;
    setTimeline?: (events: TimelineEvent[]) => void;
    updateNPC: (id: string, patch: Partial<NPCEntry>) => void;
    addNPC: (npc: NPCEntry) => void;
    setCondensed: (upToIndex: number) => void;
    setStreaming: (v: boolean) => void;
    setLastPayloadTrace?: (trace: any) => void;
    setLoadingStatus?: (status: string | null) => void;
    setPipelinePhase?: (phase: PipelinePhase) => void;
    setDivergenceRegister?: (register: DivergenceRegister) => void;
    setOnStageNpcIds?: (ids: string[]) => void;
    archiveNPC: (id: string, turn: number, reason: string) => void;
    restoreNPC: (id: string) => void;
    /** Stage a GM-proposed inventory change for user confirmation (Phase 6). The
     *  proposal does not mutate inventory until the user confirms it in the UI. */
    stageInventoryProposal?: (proposal: InventoryProposal) => void;
};

export type TurnState = {
    input: string;
    displayInput: string;
    settings: AppSettings;
    context: GameContext;
    messages: ChatMessage[];
    condenser: CondenserState;
    loreChunks: LoreChunk[];
    npcLedger: NPCEntry[];
    archiveIndex: ArchiveIndexEntry[];
    activeCampaignId: string | null;
    provider: EndpointConfig | ProviderConfig | undefined;
    getMessages: () => ChatMessage[]; // to get fresh messages midway
    getFreshProvider: () => EndpointConfig | ProviderConfig | undefined;
    getUtilityEndpoint?: () => EndpointConfig | undefined;
    getFreshAuxiliaryProvider?: () => EndpointConfig | undefined;
    onStageNpcIds?: string[];
    timeline?: TimelineEvent[];
    // Phase 2B: store-lifted fields (eliminate useAppStore.getState() inside runTurn)
    chapters: ArchiveChapter[];
    pinnedChapterIds: string[];
    clearPinnedChapters: () => void;
    setChapters: (chapters: ArchiveChapter[]) => void;
    incrementBookkeepingTurnCounter: () => number;
    resetBookkeepingTurnCounter: () => void;
    autoBookkeepingInterval: number;
    getFreshContext: () => GameContext;
    sampling?: SamplingConfig;
    deepSearchThisTurn?: boolean;
    divergenceRegister?: DivergenceRegister;
    pinnedExcerpts?: import('../../types').PinnedExcerpt[];
    // Player-called dice ("dice me"): armed mode resolved at send time (WO-H).
    armedRoll?: import('../../types').ManualRollMode | null;
};


export async function runTurn(
    state: TurnState,
    callbacks: TurnCallbacks,
    abortController: AbortController
): Promise<void> {
    const { input, displayInput, settings, context, messages, condenser, loreChunks, npcLedger, archiveIndex, activeCampaignId, provider } = state;

    if (!provider) return;

    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const abortListener = () => {
        if (retryTimer) {
            clearTimeout(retryTimer);
            retryTimer = null;
        }
    };
    abortController.signal.addEventListener('abort', abortListener);

    let finalInput = input;
    let displayInputFinal = displayInput;
    callbacks.setPipelinePhase?.('rolling-dice');
    const engineResult = rollEngines(context);
    finalInput += engineResult.appendToInput;
    callbacks.updateContext(engineResult.updatedDCs);
    const historyInput = finalInput;

    // Player-called dice ("dice me"). When the player armed a roll, resolve REAL dice now
    // (hidden until this commit), assert the tier as FACT, and SUPPRESS the auto pool menu +
    // dice tool for this turn so the model gets exactly one signal it cannot cherry-pick.
    const armed = state.armedRoll;
    if (armed) {
        const r = resolveManualRoll(armed, context.diceConfig);
        const rollsLabel = r.rolls.length > 1 ? ` (rolled ${r.rolls.join(', ')})` : '';
        finalInput += `\n[RESOLVED ROLL — ${r.detail} → ${r.tier} (${r.faceValue})${rollsLabel}. This HAPPENED. The outcome is fixed — do not re-roll, do not alter the tier, do not skip the roll. Narrate the consequence.]`;
        // Player-facing reveal — shows on their own turn bubble.
        displayInputFinal += `\n\n🎲 ${r.detail} → ${r.tier} (${r.faceValue})`;
    } else {
        finalInput += rollDiceFairness(context);
    }

    // Provide immediate UI feedback by adding the user message synchronously before heavy async operations
    const userMsgId = uid();
    callbacks.addMessage({
        id: userMsgId,
        role: 'user',
        content: historyInput,
        displayContent: displayInputFinal,
        timestamp: Date.now()
    });
    callbacks.setStreaming(true);
    callbacks.setPipelinePhase?.('gathering-context');
    callbacks.setLoadingStatus?.('Gathering Context & Memories concurrently...');

    // ─── Context Gathering (parallel: archive, timeline, recommender, lore, pinned chapters) ───
    const {
        sceneNumber, archiveRecall, recommendedNPCNames, timelineEvents, relevantLore, inventoryCategories, profileFields, deepContextSummary, semanticFactText, relevantRules, rulesManifest,
    } = await gatherContext(state, finalInput, {
        chapters: state.chapters,
        pinnedChapterIds: state.pinnedChapterIds,
        clearPinnedChapters: state.clearPinnedChapters,
        deepSearchThisTurn: !!state.deepSearchThisTurn,
        setLoadingStatus: callbacks.setLoadingStatus,
    }, abortController.signal);

    if (abortController.signal.aborted) {
        abortController.signal.removeEventListener('abort', abortListener);
        return;
    }

    if (context.npcIntroEngineActive) {
        const seenNpcNames = new Set((npcLedger ?? []).map((n: NPCEntry) => n.name.toLowerCase()));
        try {
            const auxProvider = useAppStore.getState().getActiveAuxiliaryEndpoint() ?? provider;
            const { rollCharacterIntroEngine } = await import('../npc-generation/charIntroEngine');
            const introResult = await rollCharacterIntroEngine(
                context,
                seenNpcNames,
                messages,
                auxProvider
            );
            if (introResult.tag) {
                finalInput = finalInput + '\n' + introResult.tag;
            }
            if (introResult.newDC !== context.npcIntroDC) {
                callbacks.updateContext({ npcIntroDC: introResult.newDC });
            }
        } catch (err) {
            console.warn('[CharIntroEngine] Failed to run intro engine:', err);
        }
    }

    callbacks.setPipelinePhase?.('building-prompt');
    callbacks.setLoadingStatus?.('Architecting AI Prompt...');
    const payloadResult = buildPayload(
        settings,
        context,
        messages,
        finalInput,
        condenser.condensedUpToIndex,
        relevantLore,
        npcLedger,
        archiveRecall,
        sceneNumber,
        recommendedNPCNames,
        semanticFactText,
        archiveIndex,
        timelineEvents,
        inventoryCategories as (import('../../types').InventoryItemCategory | 'equipped')[] | undefined,
        profileFields as string[] | undefined,
        deepContextSummary,
        state.divergenceRegister,
        state.chapters,
        state.onStageNpcIds,
        relevantRules,
        rulesManifest,
        state.pinnedExcerpts,
    );

    const payload = payloadResult.messages;
    if (settings.debugMode && callbacks.setLastPayloadTrace) {
        callbacks.setLastPayloadTrace(payloadResult.trace);
    }

    // WO-I: tool calls fire after the snapshot above; append a row each time a tool result is
    // folded back into the payload and re-publish so the debug panel includes them too.
    const liveTrace: PayloadTrace[] = payloadResult.trace ? [...payloadResult.trace] : [];
    const pushToolTrace = (name: string, args: string, result: string) => {
        if (!settings.debugMode || !callbacks.setLastPayloadTrace) return;
        liveTrace.push({
            source: `Tool Call — ${name}`,
            classification: 'world_context',
            tokens: Math.round((args.length + result.length) / 4),
            reason: `Model called ${name}; result folded back into the payload`,
            included: true,
            position: 'tool',
            preview: `↳ ARGS:\n${args}\n\n↳ RESULT:\n${result}`,
        });
        callbacks.setLastPayloadTrace([...liveTrace]);
    };
    
    // Attach the debug payload to the user message we added earlier (memory-only, never persisted)
    if (settings.debugMode) {
        callbacks.updateLastMessage({ debugPayload: { sections: payloadResult.debugSections, raw: payload } });
    }

    const stripLLMSceneHeader = (text: string): string =>
        text.replace(/^Scene\s*#\d+\s*\|?\s*/i, '');

    let accumulatedContent = '';

    const executeTurn = async (currentPayload: any[], toolCallCount = 0, apiRetryCount = 0, existingMsgId?: string) => {
        if (abortController.signal.aborted) return;

        const assistantMsgId = existingMsgId ?? uid();
        if (!existingMsgId) {
            callbacks.addMessage({ id: assistantMsgId, role: 'assistant' as const, content: '', timestamp: Date.now() });
        } else if (apiRetryCount > 0) {
            // Error retry: clear any error message shown in the bubble
            callbacks.updateLastAssistant('');
        }
        // Tool-call recursion (existingMsgId + apiRetryCount === 0): preserve existing content
        callbacks.setStreaming(true);

        const allowTools = toolCallCount < 2 && apiRetryCount < 2;
        const requestPayload = sanitizePayloadForApi(currentPayload, allowTools, provider?.modelName);

        // Suppress the dice tool when the player armed a manual roll (WO-H) — the resolved
        // fact is already in the payload; offering the tool too would let the model double-roll.
        const allowDiceTool = context.diceFairnessActive === false && !armed;
        const tools = allowTools ? getToolDefinitions({ allowDiceTool, combatModeActive: context.combatModeActive }) : undefined;

        callbacks.setPipelinePhase?.('generating');
        callbacks.setLoadingStatus?.(null);
        await sendMessage(
            provider,
            requestPayload,
            (fullText) => {
                const newText = sceneNumber ? `Scene #${sceneNumber} | ${stripLLMSceneHeader(fullText)}` : fullText;
                callbacks.updateLastAssistant(
                    accumulatedContent ? `${accumulatedContent}\n\n${stripLLMSceneHeader(fullText)}` : newText
                );
            },
            async (finalText, toolCall, reasoningContent) => {
                if (toolCall && toolCall.name === 'query_campaign_lore') {
                    callbacks.setPipelinePhase?.('checking-notes');
                    callbacks.onCheckingNotes(true);
                    const loreEngineText = sceneNumber
                        ? `Scene #${sceneNumber} | ${stripLLMSceneHeader(finalText)}`
                        : finalText;
                    accumulatedContent = loreEngineText;
                    callbacks.updateLastAssistant(loreEngineText);

                    callbacks.updateLastMessage({
                        tool_calls: [{
                            id: toolCall.id,
                            type: 'function' as const,
                            function: { name: toolCall.name, arguments: toolCall.arguments }
                        }],
                        ...(reasoningContent ? { reasoning_content: reasoningContent } : {})
                    });

                    currentPayload.push({
                        role: 'assistant',
                        content: loreEngineText || "",
                        reasoning_content: reasoningContent || undefined,
                        tool_calls: [{ id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: toolCall.arguments } }]
                    } as unknown as import('../chatEngine').OpenAIMessage);

                    const { toolResult: loreResult } = handleLoreTool(toolCall.arguments, { loreChunks, notebook: state.context.notebook });
                    pushToolTrace(toolCall.name, toolCall.arguments, loreResult);

                    const toolMsgId = uid();
                    callbacks.addMessage({
                        id: toolMsgId,
                        role: 'tool' as const,
                        content: loreResult,
                        timestamp: Date.now(),
                        name: toolCall.name,
                        tool_call_id: toolCall.id,
                        ephemeral: true
                    });

                    currentPayload.push({
                        role: 'tool',
                        content: loreResult,
                        name: toolCall.name,
                        tool_call_id: toolCall.id
                    } as unknown as import('../chatEngine').OpenAIMessage);

                    retryTimer = setTimeout(() => {
                        retryTimer = null;
                        if (abortController.signal.aborted) return;
                        callbacks.onCheckingNotes(false);
                        callbacks.setPipelinePhase?.('generating');
                        executeTurn(currentPayload, toolCallCount + 1, 0, assistantMsgId);
                    }, 800);
                    return;
                }

                if (toolCall && toolCall.name === 'update_scene_notebook') {
                    const nbEngineText = sceneNumber
                        ? `Scene #${sceneNumber} | ${stripLLMSceneHeader(finalText)}`
                        : finalText;
                    accumulatedContent = nbEngineText;
                    callbacks.updateLastAssistant(nbEngineText);

                    callbacks.updateLastMessage({
                        tool_calls: [{
                            id: toolCall.id,
                            type: 'function' as const,
                            function: { name: toolCall.name, arguments: toolCall.arguments }
                        }],
                        ...(reasoningContent ? { reasoning_content: reasoningContent } : {})
                    });

                    currentPayload.push({
                        role: 'assistant',
                        content: nbEngineText || "",
                        reasoning_content: reasoningContent || undefined,
                        tool_calls: [{ id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: toolCall.arguments } }]
                    } as unknown as import('../chatEngine').OpenAIMessage);

                    const { toolResult: notebookResult, updatedNotebook } = handleNotebookTool(toolCall.arguments, { loreChunks, notebook: state.context.notebook });
                    pushToolTrace(toolCall.name, toolCall.arguments, notebookResult);
                    callbacks.updateContext({ notebook: updatedNotebook });

                    const toolMsgId = uid();
                    callbacks.addMessage({
                        id: toolMsgId,
                        role: 'tool' as const,
                        content: notebookResult,
                        timestamp: Date.now(),
                        name: toolCall.name,
                        tool_call_id: toolCall.id,
                        ephemeral: true
                    });

                    currentPayload.push({
                        role: 'tool',
                        content: notebookResult,
                        name: toolCall.name,
                        tool_call_id: toolCall.id
                    } as unknown as import('../chatEngine').OpenAIMessage);

                    retryTimer = setTimeout(() => {
                        retryTimer = null;
                        if (abortController.signal.aborted) return;
                        executeTurn(currentPayload, toolCallCount + 1, 0, assistantMsgId);
                    }, 800);
                    return;
                }

                if (toolCall && toolCall.name === 'roll_dice') {
                    const diceEngineText = sceneNumber
                        ? `Scene #${sceneNumber} | ${stripLLMSceneHeader(finalText)}`
                        : finalText;
                    accumulatedContent = accumulatedContent
                        ? `${accumulatedContent}\n\n${stripLLMSceneHeader(finalText)}`
                        : diceEngineText;
                    callbacks.updateLastAssistant(accumulatedContent);

                    callbacks.updateLastMessage({
                        tool_calls: [{
                            id: toolCall.id,
                            type: 'function' as const,
                            function: { name: toolCall.name, arguments: toolCall.arguments }
                        }],
                        ...(reasoningContent ? { reasoning_content: reasoningContent } : {})
                    });

                    currentPayload.push({
                        role: 'assistant',
                        content: diceEngineText || "",
                        reasoning_content: reasoningContent || undefined,
                        tool_calls: [{ id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: toolCall.arguments } }]
                    } as unknown as import('../chatEngine').OpenAIMessage);

                    const { toolResult: diceResult } = handleDiceTool(toolCall.arguments, { diceConfig: context.diceConfig });
                    pushToolTrace(toolCall.name, toolCall.arguments, diceResult);

                    const toolMsgId = uid();
                    callbacks.addMessage({
                        id: toolMsgId,
                        role: 'tool' as const,
                        content: diceResult,
                        timestamp: Date.now(),
                        name: toolCall.name,
                        tool_call_id: toolCall.id,
                        ephemeral: true
                    });

                    currentPayload.push({
                        role: 'tool',
                        content: diceResult,
                        name: toolCall.name,
                        tool_call_id: toolCall.id
                    } as unknown as import('../chatEngine').OpenAIMessage);

                    retryTimer = setTimeout(() => {
                        retryTimer = null;
                        if (abortController.signal.aborted) return;
                        executeTurn(currentPayload, toolCallCount + 1, 0, assistantMsgId);
                    }, 800);
                    return;
                }

                if (toolCall && toolCall.name === 'propose_inventory_change') {
                    const invEngineText = sceneNumber
                        ? `Scene #${sceneNumber} | ${stripLLMSceneHeader(finalText)}`
                        : finalText;
                    accumulatedContent = accumulatedContent
                        ? `${accumulatedContent}\n\n${stripLLMSceneHeader(finalText)}`
                        : invEngineText;
                    callbacks.updateLastAssistant(accumulatedContent);

                    callbacks.updateLastMessage({
                        tool_calls: [{
                            id: toolCall.id,
                            type: 'function' as const,
                            function: { name: toolCall.name, arguments: toolCall.arguments }
                        }],
                        ...(reasoningContent ? { reasoning_content: reasoningContent } : {})
                    });

                    currentPayload.push({
                        role: 'assistant',
                        content: invEngineText || "",
                        reasoning_content: reasoningContent || undefined,
                        tool_calls: [{ id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: toolCall.arguments } }]
                    } as unknown as import('../chatEngine').OpenAIMessage);

                    const { toolResult: invResult, proposal } = handleProposeInventoryTool(toolCall.arguments);
                    callbacks.stageInventoryProposal?.(proposal);

                    const toolMsgId = uid();
                    callbacks.addMessage({
                        id: toolMsgId,
                        role: 'tool' as const,
                        content: invResult,
                        timestamp: Date.now(),
                        name: toolCall.name,
                        tool_call_id: toolCall.id,
                        ephemeral: true
                    });

                    currentPayload.push({
                        role: 'tool',
                        content: invResult,
                        name: toolCall.name,
                        tool_call_id: toolCall.id
                    } as unknown as import('../chatEngine').OpenAIMessage);

                    retryTimer = setTimeout(() => {
                        retryTimer = null;
                        if (abortController.signal.aborted) return;
                        executeTurn(currentPayload, toolCallCount + 1, 0, assistantMsgId);
                    }, 800);
                    return;
                }

                if (toolCall && toolCall.name === 'initiate_combat') {
                    // Phase 6 stub: combat engine is Phase 7. The handler defers gracefully
                    // (returns "not available") and we do NOT flip combatModeActive — the turn
                    // continues narratively without erroring on the tool call.
                    const combatEngineText = sceneNumber
                        ? `Scene #${sceneNumber} | ${stripLLMSceneHeader(finalText)}`
                        : finalText;
                    accumulatedContent = accumulatedContent
                        ? `${accumulatedContent}\n\n${stripLLMSceneHeader(finalText)}`
                        : combatEngineText;
                    callbacks.updateLastAssistant(accumulatedContent);

                    callbacks.updateLastMessage({
                        tool_calls: [{
                            id: toolCall.id,
                            type: 'function' as const,
                            function: { name: toolCall.name, arguments: toolCall.arguments }
                        }],
                        ...(reasoningContent ? { reasoning_content: reasoningContent } : {})
                    });

                    currentPayload.push({
                        role: 'assistant',
                        content: combatEngineText || "",
                        reasoning_content: reasoningContent || undefined,
                        tool_calls: [{ id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: toolCall.arguments } }]
                    } as unknown as import('../chatEngine').OpenAIMessage);

                    const { toolResult: combatResult } = handleInitiateCombatTool(toolCall.arguments);

                    const toolMsgId = uid();
                    callbacks.addMessage({
                        id: toolMsgId,
                        role: 'tool' as const,
                        content: combatResult,
                        timestamp: Date.now(),
                        name: toolCall.name,
                        tool_call_id: toolCall.id,
                        ephemeral: true
                    });

                    currentPayload.push({
                        role: 'tool',
                        content: combatResult,
                        name: toolCall.name,
                        tool_call_id: toolCall.id
                    } as unknown as import('../chatEngine').OpenAIMessage);

                    retryTimer = setTimeout(() => {
                        retryTimer = null;
                        if (abortController.signal.aborted) return;
                        executeTurn(currentPayload, toolCallCount + 1, 0, assistantMsgId);
                    }, 800);
                    return;
                }

                callbacks.setStreaming(false);
                callbacks.onCheckingNotes(false);
                callbacks.setPipelinePhase?.('post-processing');
                const baseText = sceneNumber
                    ? `Scene #${sceneNumber} | ${stripLLMSceneHeader(finalText)}`
                    : finalText;
                const engineText = accumulatedContent
                    ? `${accumulatedContent}\n\n${stripLLMSceneHeader(finalText)}`
                    : baseText;
                callbacks.updateLastAssistant(engineText);
                // Only store reasoning_content when this is the FIRST (and only) response for this
                // assistant message — i.e. not a post-tool-call continuation. If accumulatedContent
                // is non-empty it means a tool call already ran and reasoning_content was already
                // stored on this message from that first response; overwriting it with the second
                // response's reasoning would corrupt the history and cause 400 on the next turn.
                if (reasoningContent && !accumulatedContent) {
                    callbacks.updateLastMessage({ reasoning_content: reasoningContent });
                }
                
                const allMsgs = state.getMessages();
                const userIdx = allMsgs.findIndex(m => m.id === userMsgId);
                // Guard: if userMsgId not found (state reset / condenser ran during generation),
                // slice(0) would return ALL messages — fall back to engineText only.
                const combinedContent = userIdx === -1
                    ? engineText
                    : allMsgs.slice(userIdx + 1)
                        .filter(m => m.role === 'assistant' && m.content)
                        .map(m => m.content)
                        .join('\n\n');

                if (combinedContent && activeCampaignId) {
                    await runPostTurnPipeline(state, callbacks, combinedContent, allMsgs);
                }

                const allMsgs2 = state.getMessages();
                const liveStore = useAppStore.getState();
                const liveSettings = liveStore.settings;
                const liveCondenser = liveStore.condenser;
                if (liveSettings.autoCondenseEnabled && shouldCondense(allMsgs2, liveSettings.contextLimit,
                    liveCondenser.condensedUpToIndex, getCondenseBudgetRatio(liveSettings.condenseAggressiveness ?? 'smart'))) {
                    const newIndex = computeTrimIndex(allMsgs2, liveCondenser.condensedUpToIndex);
                    if (newIndex !== liveCondenser.condensedUpToIndex) {
                        callbacks.setCondensed(newIndex);
                    }
                }

                callbacks.setPipelinePhase?.('idle');
                abortController.signal.removeEventListener('abort', abortListener);
            },
            (err) => {
                const isUserAbort = abortController.signal.aborted
                    || err === 'AbortError'
                    || err === 'The user aborted a request.'
                    || (typeof err === 'string' && err.includes('abort'));

                if (isUserAbort) {
                    callbacks.setStreaming(false);
                    callbacks.onCheckingNotes(false);
                    callbacks.setLoadingStatus?.(null);
                    callbacks.setPipelinePhase?.('idle');
                    abortController.signal.removeEventListener('abort', abortListener);
                    return;
                }

                const currentAssistantContent = state.getMessages().find(m => m.id === assistantMsgId)?.content || '';

                if (apiRetryCount === 0) {
                    if (!currentAssistantContent) {
                        callbacks.updateLastAssistant(`⚠️ Error: ${err}. Retrying...`);
                    }
                    toast.warning('LLM request failed — retrying...');
                    retryTimer = setTimeout(() => {
                        retryTimer = null;
                        if (abortController.signal.aborted) return;
                        executeTurn(currentPayload, toolCallCount, 1, assistantMsgId);
                    }, 2000);
                } else if (apiRetryCount === 1) {
                    if (!currentAssistantContent) {
                        callbacks.updateLastAssistant(`⚠️ Error: ${err}. Retrying without tools...`);
                    }
                    toast.warning('Retry failed — trying without tools...');
                    retryTimer = setTimeout(() => {
                        retryTimer = null;
                        if (abortController.signal.aborted) return;
                        executeTurn(currentPayload, 999, 2, assistantMsgId);
                    }, 4000);
                } else {
                    if (!currentAssistantContent) {
                        callbacks.updateLastAssistant(`⚠️ Error: ${err}`);
                    }
                    toast.error('LLM request failed after retries');
                    callbacks.setStreaming(false);
                    callbacks.onCheckingNotes(false);
                    callbacks.setLoadingStatus?.(null);
                    callbacks.setPipelinePhase?.('idle');
                    abortController.signal.removeEventListener('abort', abortListener);
                }
            },
            tools ? [...tools] : undefined,
            abortController,
            state.sampling,
            (state.provider as EndpointConfig).thinkingEffort as ThinkingEffort | undefined
        );
    };

    await executeTurn(payload);
}
