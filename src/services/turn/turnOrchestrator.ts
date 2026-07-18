import { useAppStore } from '../../store/useAppStore';
import type { AppSettings, GameContext, ChatMessage, NPCEntry, LoreChunk, CondenserState, ArchiveIndexEntry, TimelineEvent, EndpointConfig, ProviderConfig, ArchiveChapter, SamplingConfig, PipelinePhase, DivergenceRegister, ThinkingEffort, InventoryProposal, PayloadTrace, SwipeVariant, SemanticFact } from '../../types';
import { uid } from '../../utils/uid';
import { buildPayload, sendMessage } from '../chatEngine';
import { rollEngines, rollDiceFairness, resolveManualRoll } from '../engine/engineRolls';
import { resolveLootDrop } from '../engine/lootEngine';
import { buildOneShotDirective } from '../oneshot/oneShotEvents';
import type { OneShotEventId } from '../oneshot/oneShotEvents';
import { toast } from '../../components/Toast';
import { sanitizePayloadForApi } from '../lib/payloadSanitizer';
import { getToolDefinitions } from './toolHandlers';
import { resolveToolHandler } from './toolRegistry';
import { gatherContext } from './contextGatherer';
import { tierAllows } from './aiTier';
import { extractAndStripSceneStakes } from './sceneStakesTag';
import { capturePendingTurnSnapshot } from './pendingCommit';

const MAX_TOOL_CALLS_PER_TURN = 5;

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
    setLastPayloadTrace?: (trace: PayloadTrace[] | undefined) => void;
    setLoadingStatus?: (status: string | null) => void;
    setPipelinePhase?: (phase: PipelinePhase) => void;
    setDivergenceRegister?: (register: DivergenceRegister) => void;
    setOnStageNpcIds?: (ids: string[]) => void;
    addNpcSuggestions?: (names: string[], context?: string) => void;
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
    // Player-called dice ("dice me"): armed roll resolved at send time (WO-H).
    // Accepts the new ManualRollRequest shape OR the legacy '1d20'|'adv'|'disadv' string.
    armedRoll?: import('../../types').ManualRollRequest | string | null;
    armedLoot?: import('../../types').ArmedLoot | null;
    armedOneShot?: OneShotEventId | null;
    /** Confirmed Ask GM meta-guidance. Volatile only; it is never added to story history. */
    nextTurnOocBrief?: string;
    semanticFacts?: SemanticFact[];
};


export async function runTurn(
    state: TurnState,
    callbacks: TurnCallbacks,
    abortController: AbortController
): Promise<void> {
    const { input, displayInput, settings, context, messages, condenser, loreChunks, npcLedger, archiveIndex, provider } = state;

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
        const r = resolveManualRoll(armed, context.diceSystem);
        const rollsLabel = r.rolls.length > 1 ? ` (rolled ${r.rolls.join(', ')})` : '';
        const tierLabel = r.tier ?? 'Unmapped';
        finalInput += `\n[RESOLVED ROLL — ${r.detail} → ${tierLabel} (${r.faceValue})${rollsLabel}. This HAPPENED. The outcome is fixed — do not re-roll, do not alter the tier, do not skip the roll. Narrate the consequence.]`;
        // Player-facing reveal — shows on their own turn bubble.
        displayInputFinal += `\n\n🎲 ${r.detail} → ${tierLabel} (${r.faceValue})`;
    } else {
        finalInput += rollDiceFairness(context);
    }

    // Loot Engine WO-05: player-armed loot drop. Mirrors the dice block above —
    // the engine returns a BARE `[LOOT DROP: ...]` tag and the orchestrator adds
    // the fact-assertion wrapper. The caller (ChatArea) clears `armedLoot`
    // before runTurn, exactly as it clears `armedRoll` — so this only reads the
    // captured value. The engine is pure: dice + JSON, zero LLM at runtime.
    const armedLoot = state.armedLoot;
    if (armedLoot && context.lootTree) {
        const loot = resolveLootDrop(context.lootTree, {
            rolls: armedLoot.rolls,
            profile: armedLoot.reweight ? { reweight: armedLoot.reweight } : undefined,
        });
        if (loot.appendToInput) {
            // Inject the fact-assertion INSIDE the closing bracket so the whole
            // block reads as one engine signal. The engine returns a bare `\n[LOOT DROP: ...]`.
            const bare = loot.appendToInput.replace(/\]$/, '');
            finalInput +=
                bare +
                ` — this loot DROPPED. Narrate the player finding it as fact; ` +
                `do NOT change its identity, inflate it, or add items beyond this list.]`;
            // Player-facing reveal — shows the drop on their own turn bubble.
            displayInputFinal += `\n\n💰 Loot drop armed (${armedLoot.rolls})`;
        }
    }

    // One-Shot Event Injector v1: player-armed event directive. Mirrors the dice/loot
    // blocks above — appended AFTER the historyInput capture, so it steers THIS turn's
    // generation but never enters durable chat history. Fires once; caller clears it.
    const armedOneShot = state.armedOneShot;
    if (armedOneShot) {
        const directive = buildOneShotDirective(armedOneShot);
        if (directive) {
            finalInput += directive;
            displayInputFinal += `\n\n⚡ Event injected (${armedOneShot})`;
        }
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

    if (context.npcIntroEngineActive && tierAllows(settings.aiTier, 'introEngine')) {
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
        undefined, // plannerEventTypes — recomputed inside buildWorld
        useAppStore.getState().locationLedger,
        state.nextTurnOocBrief,
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

        const allowTools = toolCallCount < MAX_TOOL_CALLS_PER_TURN && apiRetryCount < 2;
        const requestPayload = sanitizePayloadForApi(currentPayload, allowTools, provider?.modelName);

        // Dice tool availability is decoupled from pool mode (diceFairnessActive).
        // Pool mode = pre-rolled numbers injected; tool mode = AI calls roll_dice on demand.
        // They are mutually exclusive: tool is available only when pool mode is OFF
        // (diceFairnessActive === false) and the player hasn't manually armed a roll.
        // When the player armed a manual roll, the resolved fact is already in the payload;
        // offering the tool too would let the model double-roll (WO-H).
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
                if (toolCall && toolCallCount >= MAX_TOOL_CALLS_PER_TURN) {
                    console.warn(`[Turn] Tool-call cap (${MAX_TOOL_CALLS_PER_TURN}) reached — refusing tool call '${toolCall.name}' and treating model output as final answer.`);
                    toolCall = undefined;
                }
                const toolHandler = toolCall ? resolveToolHandler(toolCall.name) : null;
                if (toolCall && toolHandler) {
                    const toolName = toolCall.name;
                    // Lore tool signals the "checking notes" UI state — preserved verbatim from
                    // the pre-Phase-4 inline implementation. This is a UI concern owned by the
                    // orchestrator, not the registry handler.
                    if (toolName === 'query_campaign_lore') {
                        callbacks.setPipelinePhase?.('checking-notes');
                        callbacks.onCheckingNotes(true);
                    }

                    const engineText = sceneNumber
                        ? `Scene #${sceneNumber} | ${stripLLMSceneHeader(finalText)}`
                        : finalText;
                    const dispatchResult = toolHandler({ arguments: toolCall.arguments, loreChunks, notebook: state.context.notebook, diceSystem: context.diceSystem });
                    if (dispatchResult.accumulation === 'overwrite') {
                        accumulatedContent = engineText;
                    } else {
                        accumulatedContent = accumulatedContent
                            ? `${accumulatedContent}\n\n${stripLLMSceneHeader(finalText)}`
                            : engineText;
                    }
                    callbacks.updateLastAssistant(accumulatedContent);

                    callbacks.updateLastMessage({
                        tool_calls: [{
                            id: toolCall.id,
                            type: 'function' as const,
                            function: { name: toolName, arguments: toolCall.arguments }
                        }],
                        ...(reasoningContent ? { reasoning_content: reasoningContent } : {})
                    });

                    currentPayload.push({
                        role: 'assistant',
                        content: engineText || "",
                        reasoning_content: reasoningContent || undefined,
                        tool_calls: [{ id: toolCall.id, type: 'function', function: { name: toolName, arguments: toolCall.arguments } }]
                    } as unknown as import('../chatEngine').OpenAIMessage);

                    if (dispatchResult.traceResult) {
                        pushToolTrace(toolName, toolCall.arguments, dispatchResult.toolResult);
                    }
                    if (dispatchResult.contextPatch) {
                        callbacks.updateContext(dispatchResult.contextPatch);
                    }
                    if (dispatchResult.proposal) {
                        callbacks.stageInventoryProposal?.(dispatchResult.proposal);
                    }

                    const toolMsgId = uid();
                    callbacks.addMessage({
                        id: toolMsgId,
                        role: 'tool' as const,
                        content: dispatchResult.toolResult,
                        timestamp: Date.now(),
                        name: toolName,
                        tool_call_id: toolCall.id,
                        ephemeral: true
                    });

                    currentPayload.push({
                        role: 'tool',
                        content: dispatchResult.toolResult,
                        name: toolName,
                        tool_call_id: toolCall.id
                    } as unknown as import('../chatEngine').OpenAIMessage);

                    retryTimer = setTimeout(() => {
                        retryTimer = null;
                        if (abortController.signal.aborted) return;
                        if (toolName === 'query_campaign_lore') {
                            callbacks.onCheckingNotes(false);
                            callbacks.setPipelinePhase?.('generating');
                        }
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

                // ── Swipe Generation v1 (per-variant scene-stakes strip) ──
                // mainApp accumulates tool-call preamble into engineText (unlike mobile,
                // which creates a new message per tool call). Strip the [[SCENE_STAKES]]
                // tag from the display text now and store the parsed stakes on the
                // SwipeVariant. The tag is removed from the bubble; classifySceneStakes
                // (LLM fallback) runs later at commit only when the variant had no tag.
                const { displayText: stakesStrippedText, stakes: parsedStakes } = extractAndStripSceneStakes(engineText);
                const tagPresent = engineText !== stakesStrippedText || parsedStakes !== 'calm';

                callbacks.updateLastAssistant(stakesStrippedText);
                // Only store reasoning_content when this is the FIRST (and only) response for this
                // assistant message — i.e. not a post-tool-call continuation. If accumulatedContent
                // is non-empty it means a tool call already ran and reasoning_content was already
                // stored on this message from that first response; overwriting it with the second
                // response's reasoning would corrupt the history and cause 400 on the next turn.
                if (reasoningContent && !accumulatedContent) {
                    callbacks.updateLastMessage({ reasoning_content: reasoningContent });
                }

                // ── Swipe Generation v1: stamp the swipe set + pendingCommit on the
                // latest GM message and capture the snapshot for lazy swipes + late commit.
                // runPostTurnPipeline + auto-condense are DEFERRED to commitPendingTurn
                // (called by the next send / Arc Injector / campaign switch).
                const variant: SwipeVariant = {
                    id: uid(),
                    text: stakesStrippedText,
                    reasoningContent: reasoningContent || undefined,
                    sceneStakes: parsedStakes,
                    tagPresent,
                };
                callbacks.updateLastMessage({
                    swipeSet: [variant],
                    pendingCommit: true,
                    swipeActiveIndex: 0,
                });

                // Capture the snapshot for lazy swipes (cached payload with tool history)
                // and for the late-commit path (frozen messages window for the importance
                // rater — it must read the snapshot, never live getMessages()).
                capturePendingTurnSnapshot(state, currentPayload, state.displayInput);

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
