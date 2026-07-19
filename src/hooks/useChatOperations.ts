import { useState, useRef, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../store/useAppStore';
import { runTurn } from '../services/turn/turnOrchestrator';
import { commitPendingTurn } from '../services/turn/pendingCommit';
import { debouncedSaveCampaignState } from '../store/slices/campaignSlice';
import type { InventoryProposal } from '../types';
import type { useSceneContinue } from '../components/hooks/useSceneContinue';

/**
 * Send / stop / abort lifecycle for the main chat turn loop, extracted from
 * ChatArea. Owns the streaming flags, the AbortController, the live streaming
 * stats ticker, and the staged GM inventory proposal.
 */
export function useChatOperations({
    input,
    setInput,
    resetTextareaHeight,
    oocBusy,
    armedAskGmBrief,
    setArmedAskGmBrief,
    sceneContinue,
    checkAndSealChapter,
}: {
    input: string;
    setInput: (v: string) => void;
    resetTextareaHeight: () => void;
    oocBusy: boolean;
    armedAskGmBrief: { campaignId: string; text: string } | null;
    setArmedAskGmBrief: (v: { campaignId: string; text: string } | null) => void;
    sceneContinue: ReturnType<typeof useSceneContinue>;
    checkAndSealChapter: (campaignId: string) => void;
}) {
    const context = useAppStore(s => s.context);
    const activeCampaignId = useAppStore(s => s.activeCampaignId);
    const deepArmed = useAppStore(s => s.deepArmed);
    const setDeepArmed = useAppStore(s => s.setDeepArmed);

    const { settings, loreChunks, npcLedger, archiveIndex } = useAppStore(
        useShallow(s => ({
            settings: s.settings,
            loreChunks: s.loreChunks,
            npcLedger: s.npcLedger,
            archiveIndex: s.archiveIndex,
        }))
    );

    const {
        setArchiveIndex, updateLastAssistant, updateContext, setCondensed,
        setTimeline, setChapters,
        pipelinePhase, setPipelinePhase, setStreamingStats,
    } = useAppStore(
        useShallow(s => ({
            setArchiveIndex: s.setArchiveIndex,
            updateLastAssistant: s.updateLastAssistant,
            updateContext: s.updateContext,
            setCondensed: s.setCondensed,
            setTimeline: s.setTimeline,
            setChapters: s.setChapters,
            pipelinePhase: s.pipelinePhase,
            setPipelinePhase: s.setPipelinePhase,
            setStreamingStats: s.setStreamingStats,
        }))
    );

    const [isStreaming, setStreaming] = useState(false);
    const [, setIsCheckingNotes] = useState(false);
    const [loadingStatus, setLoadingStatus] = useState<string | null>(null);
    // Phase 6: GM-proposed inventory change awaiting user confirmation.
    const [pendingProposal, setPendingProposal] = useState<InventoryProposal | null>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    const streamStartRef = useRef<number>(0);

    useEffect(() => {
        if (pipelinePhase === 'generating') {
            streamStartRef.current = Date.now();
        }
    }, [pipelinePhase]);

    useEffect(() => {
        if (pipelinePhase !== 'generating') {
            setStreamingStats(null);
            return;
        }
        const interval = setInterval(() => {
            const msgs = useAppStore.getState().messages;
            const last = msgs[msgs.length - 1];
            if (!last || last.role !== 'assistant') return;
            const tokens = Math.round(last.content.length / 4);
            const elapsed = Date.now() - streamStartRef.current;
            const speed = elapsed > 0 ? (tokens / (elapsed / 1000)) : 0;
            setStreamingStats({ tokens, elapsed, speed });
        }, 500);
        return () => clearInterval(interval);
    }, [pipelinePhase, setStreamingStats]);

    const handleSend = async (overrideText?: string, deepSearch = false) => {
        const textToUse = overrideText || input.trim();
        if (!textToUse || isStreaming || oocBusy) return;

        const useDeepSearch = deepSearch || deepArmed;
        if (deepArmed) setDeepArmed(false);

        // Consume the armed dice mode (cleared whether or not a roll was set this turn).
        const useArmedRoll = useAppStore.getState().armedRoll;
        useAppStore.getState().setArmedRoll(null);

        const useArmedLoot = useAppStore.getState().armedLoot;
        useAppStore.getState().clearArmedLoot();

        // One-Shot Event Injector v1: capture then clear, exactly like the
        // dice/loot arming above. Cleared BEFORE runTurn so it fires exactly
        // once even if the turn errors mid-stream (mirrors armedRoll/armedLoot).
        const useArmedOneShot = useAppStore.getState().armedOneShot;
        useAppStore.getState().setArmedOneShot(null);

        if (!overrideText) {
            setInput('');
            resetTextareaHeight();
        }

        abortControllerRef.current = new AbortController();

        const storeSnapshot = useAppStore.getState();

        // Swipe Generation v1 — commit any pending turn BEFORE the next turn's
        // gatherContext. The previous turn's post-turn work (archive append,
        // agency tick, arc tick, witness capture) must fire on the variant the
        // user is keeping, before the next turn re-gathers context. A late
        // swipe result still streaming in the background finishes and fills its
        // slot (the onDone guard drops it silently once commit fired).
        await commitPendingTurn().catch(e => console.warn('[ChatArea] commit failed:', e));
        const storyProvider = storeSnapshot.getActiveStoryEndpoint();
        if (!storyProvider) return;
        const useAskGmBrief = armedAskGmBrief?.campaignId === activeCampaignId ? armedAskGmBrief.text : undefined;
        // Consume only as the real story run begins. runTurn builds once, so retries reuse this payload.
        if (useAskGmBrief) {
            setArmedAskGmBrief(null);
        }

        await runTurn({
            input: textToUse,
            displayInput: textToUse,
            settings,
            context,
            messages: storeSnapshot.messages,
            condenser: storeSnapshot.condenser,
            loreChunks,
            npcLedger,
            archiveIndex,
            activeCampaignId,
            provider: storyProvider,
            getMessages: () => useAppStore.getState().messages,
            getFreshProvider: () => useAppStore.getState().getActiveStoryEndpoint(),
            getUtilityEndpoint: () => useAppStore.getState().getActiveUtilityEndpoint(),
            timeline: storeSnapshot.timeline,
            chapters: storeSnapshot.chapters,
            pinnedChapterIds: storeSnapshot.pinnedChapterIds,
            clearPinnedChapters: storeSnapshot.clearPinnedChapters,
            setChapters: setChapters,
            incrementBookkeepingTurnCounter: storeSnapshot.incrementBookkeepingTurnCounter,
            resetBookkeepingTurnCounter: storeSnapshot.resetBookkeepingTurnCounter,
            autoBookkeepingInterval: storeSnapshot.autoBookkeepingInterval,
            getFreshContext: () => useAppStore.getState().context,
            sampling: storeSnapshot.getActivePreset()?.sampling,
            deepSearchThisTurn: useDeepSearch,
            divergenceRegister: storeSnapshot.divergenceRegister,
            onStageNpcIds: storeSnapshot.onStageNpcIds,
            pinnedExcerpts: storeSnapshot.pinnedExcerpts,
            armedRoll: useArmedRoll,
            armedLoot: useArmedLoot,
            armedOneShot: useArmedOneShot,
            getFreshAuxiliaryProvider: () => {
                const aux = useAppStore.getState().getActiveAuxiliaryEndpoint();
                return aux?.modelName ? aux : useAppStore.getState().getActiveStoryEndpoint();
            },
            nextTurnOocBrief: useAskGmBrief,
        }, {
            onCheckingNotes: setIsCheckingNotes,
            addMessage: storeSnapshot.addMessage,
            updateLastAssistant: updateLastAssistant,
            updateLastMessage: storeSnapshot.updateLastMessage,
            updateContext: updateContext,
            setArchiveIndex: setArchiveIndex,
            setTimeline: setTimeline,
            updateNPC: storeSnapshot.updateNPC,
            addNPC: storeSnapshot.addNPC,
            setCondensed: setCondensed,
            setStreaming: setStreaming,
            setLoadingStatus: setLoadingStatus,
            setPipelinePhase: setPipelinePhase,
            setLastPayloadTrace: storeSnapshot.setLastPayloadTrace,
            setDivergenceRegister: storeSnapshot.setDivergenceRegister,
            setOnStageNpcIds: storeSnapshot.setOnStageNpcIds,
            addNpcSuggestions: storeSnapshot.addNpcSuggestions,
            archiveNPC: storeSnapshot.archiveNPC,
            restoreNPC: storeSnapshot.restoreNPC,
            stageInventoryProposal: (proposal) => setPendingProposal(proposal),
        }, abortControllerRef.current);

        if (activeCampaignId) {
            checkAndSealChapter(activeCampaignId);
        }
    };

    const handleStop = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
        }
        // Scene Continue v1: abort an in-flight continue too (the global Stop owns
        // every streaming operation — no second stop button is built).
        sceneContinue.getAbortController()?.abort();
        setStreaming(false);
        setIsCheckingNotes(false);
        setLoadingStatus(null);
        setPipelinePhase('idle');
        debouncedSaveCampaignState();
    };

    return {
        isStreaming,
        loadingStatus,
        pendingProposal,
        setPendingProposal,
        handleSend,
        handleStop,
    };
}
