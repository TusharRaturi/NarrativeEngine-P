import { useState, useRef, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Send, Save, Loader2, Zap, Scroll, Edit2, X, Square, Search, Check, Package } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { runTurn } from '../services/turn/turnOrchestrator';
import { uid } from '../utils/uid';
import type { InventoryProposal, InventoryItem, InventoryItemCategory } from '../types';
import { set } from 'idb-keyval';
import { toast } from './Toast';
import { debouncedSaveCampaignState } from '../store/slices/campaignSlice';
import { rollbackArchiveFrom, openArchive as openArchiveFn } from '../services/archive-memory/archiveManager';
import { MessageBubble } from './MessageBubble';
import { GenerationProgress } from './GenerationProgress';
import { useCondenser } from './hooks/useCondenser';
import { useChapterSealing } from './hooks/useChapterSealing';
import { useMessageEditor } from './hooks/useMessageEditor';
import { UtilityCallStrip } from './UtilityCallStrip';
import { CreateTroubleButton } from './CreateTroubleButton';
import { ArcInjectorButton } from './ArcInjectorButton';
import { PCCreationWizard } from './pc/PCCreationWizard';

export function ChatArea() {
    const messages = useAppStore(s => s.messages);
    const condenser = useAppStore(s => s.condenser);
    const context = useAppStore(s => s.context);
    const activeCampaignId = useAppStore(s => s.activeCampaignId);
    const activeProvider = useAppStore(s => s.getActiveStoryEndpoint?.());

    const { settings, loreChunks, npcLedger, archiveIndex, chapters } = useAppStore(
        useShallow(s => ({
            settings: s.settings,
            loreChunks: s.loreChunks,
            npcLedger: s.npcLedger,
            archiveIndex: s.archiveIndex,
            chapters: s.chapters,
        }))
    );

    const {
        setArchiveIndex, clearArchive, updateLastAssistant, updateContext,
        setCondensed, deleteMessage, deleteMessagesFrom,
        setTimeline, setChapters,
        pipelinePhase, streamingStats, setPipelinePhase, setStreamingStats,
    } = useAppStore(
        useShallow(s => ({
            setArchiveIndex: s.setArchiveIndex,
            clearArchive: s.clearArchive,
            updateLastAssistant: s.updateLastAssistant,
            updateContext: s.updateContext,
            setCondensed: s.setCondensed,
            deleteMessage: s.deleteMessage,
            deleteMessagesFrom: s.deleteMessagesFrom,
            setTimeline: s.setTimeline,
            setChapters: s.setChapters,
            pipelinePhase: s.pipelinePhase,
            streamingStats: s.streamingStats,
            setPipelinePhase: s.setPipelinePhase,
            setStreamingStats: s.setStreamingStats,
        }))
    );


    const [input, setInput] = useState('');
    const [isStreaming, setStreaming] = useState(false);
    const [, setIsCheckingNotes] = useState(false);
    const [loadingStatus, setLoadingStatus] = useState<string | null>(null);
    const [visibleCount, setVisibleCount] = useState(10);
    const [loadStep, setLoadStep] = useState(10);
    const [isSaving, setIsSaving] = useState(false);
    const [showPCCreator, setShowPCCreator] = useState(false);
    // Phase 6: GM-proposed inventory change awaiting user confirmation.
    const [pendingProposal, setPendingProposal] = useState<InventoryProposal | null>(null);
    const deepArmed = useAppStore(s => s.deepArmed);
    const setDeepArmed = useAppStore(s => s.setDeepArmed);
    const composerInjection = useAppStore(s => s.composerInjection);
    const consumeComposerInjection = useAppStore(s => s.consumeComposerInjection);

    useEffect(() => {
        if (composerInjection != null) {
            setInput(composerInjection);
            consumeComposerInjection();
            inputRef.current?.focus();
        }
    }, [composerInjection, consumeComposerInjection]);
    const bottomRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    const streamStartRef = useRef<number>(0);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages.length]);

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

    const resetTextareaHeight = () => {
        if (inputRef.current) {
            inputRef.current.style.height = '40px';
        }
    };

    const { triggerCondense } = useCondenser({
        messages,
        condenser,
        setCondensed,
    });

    const { checkAndSealChapter } = useChapterSealing({
        activeCampaignId,
        chapters,
        context,
        setChapters,
        getActiveSummarizerEndpoint: () => useAppStore.getState().getActiveSummarizerEndpoint?.(),
        getActiveStoryEndpoint: () => useAppStore.getState().getActiveStoryEndpoint(),
    });

    const handleSend = async (overrideText?: string, deepSearch = false) => {
        const textToUse = overrideText || input.trim();
        if (!textToUse || isStreaming) return;

        const useDeepSearch = deepSearch || deepArmed;
        if (deepArmed) setDeepArmed(false);

        if (!overrideText) {
            setInput('');
            resetTextareaHeight();
        }

        abortControllerRef.current = new AbortController();

        const storeSnapshot = useAppStore.getState();

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
            provider: storeSnapshot.getActiveStoryEndpoint(),
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
            getFreshAuxiliaryProvider: () => {
                const aux = useAppStore.getState().getActiveAuxiliaryEndpoint();
                return aux?.modelName ? aux : useAppStore.getState().getActiveStoryEndpoint();
            },
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
            archiveNPC: storeSnapshot.archiveNPC,
            restoreNPC: storeSnapshot.restoreNPC,
            stageInventoryProposal: (proposal) => setPendingProposal(proposal),
        }, abortControllerRef.current);

        if (activeCampaignId) {
            checkAndSealChapter(activeCampaignId);
        }
    };

    const archiveDeps = {
        setArchiveIndex,
        setTimeline,
        setChapters,
        clearArchive,
        setCondenser: useAppStore.getState().setCondenser,
        getActiveCampaignId: () => useAppStore.getState().activeCampaignId,
        getArchiveIndex: () => useAppStore.getState().archiveIndex,
        getChapters: () => useAppStore.getState().chapters,
        getCondenser: () => useAppStore.getState().condenser,
        getMessages: () => useAppStore.getState().messages,
    };

    const { editingMessageId, startEditing, cancelEditing, handleEditSubmit, handleRegenerate } = useMessageEditor({
        messages,
        input,
        setInput,
        inputRef,
        resetTextareaHeight,
        rollbackArchive: (ts) => rollbackArchiveFrom(archiveDeps, ts),
        deleteMessagesFrom,
        updateMessageContent: (id, content) => useAppStore.getState().updateMessageContent(id, content),
        onAfterEdit: (text) => handleSend(text),
        onAfterRegenerate: (text) => handleSend(text),
    });

    // Phase 6: apply a confirmed GM inventory proposal as a real delta on the ledger.
    const applyInventoryProposal = (p: InventoryProposal) => {
        const store = useAppStore.getState();
        const items = store.inventoryItems ?? [];
        const lastScene = archiveIndex.length > 0 ? archiveIndex[archiveIndex.length - 1].sceneId : '000';
        const findByName = () => items.find(it => it.name.toLowerCase() === p.name.toLowerCase());

        if (p.op === 'remove') {
            const target = findByName();
            if (target) { store.removeInventoryItem(target.id); toast.info(`Removed ${p.name}`); }
            else toast.warning(`"${p.name}" not found in inventory`);
        } else if (p.op === 'equip') {
            const target = findByName();
            if (target) { store.updateInventoryItem(target.id, { equipped: true }); toast.success(`Equipped ${p.name}`); }
            else toast.warning(`"${p.name}" not found to equip`);
        } else {
            const category: InventoryItemCategory = p.kind === 'weapon' ? 'weapon'
                : p.kind === 'armor' ? 'armor'
                : p.kind === 'consumable' ? 'consumable'
                : 'misc';
            const newItem: InventoryItem = {
                id: uid(),
                name: p.name,
                qty: 1,
                category,
                keywords: p.name.toLowerCase().split(/\s+/).filter(w => w.length > 2),
                equipped: p.equip,
                lastUsedScene: lastScene,
                importance: 5,
                notes: [p.description, p.properties.length ? `(${p.properties.join(', ')})` : ''].filter(Boolean).join(' '),
            };
            store.addInventoryItem(newItem);
            toast.success(`Added ${p.name}`);
        }
        setPendingProposal(null);
    };

    const handleStop = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
        }
        setStreaming(false);
        setIsCheckingNotes(false);
        setLoadingStatus(null);
        setPipelinePhase('idle');
        debouncedSaveCampaignState();
    };

    const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setInput(e.target.value);
        if (deepArmed) setDeepArmed(false);
        if (inputRef.current) {
            inputRef.current.style.height = '40px';
            const newHeight = Math.min(inputRef.current.scrollHeight, 240);
            inputRef.current.style.height = `${newHeight}px`;
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (editingMessageId) {
                handleEditSubmit();
            } else {
                handleSend();
            }
        }
    };

    const handleForceSave = () => {
        setIsSaving(true);
        const state = useAppStore.getState();
        if (state.activeCampaignId) {
            try {
                set(`nn_settings`, { settings: state.settings, activeCampaignId: state.activeCampaignId });
                set(`nn_campaign_${state.activeCampaignId}_state`, { context: state.context, messages: state.messages, condenser: state.condenser });
                set(`nn_campaign_${state.activeCampaignId}_npcs`, state.npcLedger);
                toast.success('Campaign saved');
            } catch (e) {
                console.error("[Save] Failed to force save to IndexedDB:", e);
                toast.error('Force save failed');
            }
        }
        setTimeout(() => setIsSaving(false), 2000);
    };

    const handleOpenArchive = () => {
        if (activeCampaignId) openArchiveFn(activeCampaignId);
    };

    return (
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
            {context.sceneNoteActive && (
                <div className="absolute top-0 left-0 right-0 z-20 px-4 py-1.5 bg-amber/90 backdrop-blur-sm border-b border-amber/40 flex items-center justify-between text-[10px] text-void-dark font-bold uppercase tracking-widest animate-in slide-in-from-top duration-300">
                    <div className="flex items-center gap-2">
                        <div className="w-1.5 h-1.5 rounded-full bg-void-dark animate-pulse" />
                        Active Scene Note: {context.sceneNote.slice(0, 50)}{context.sceneNote.length > 50 ? '...' : ''}
                    </div>
                    <button
                        onClick={() => updateContext({ sceneNoteActive: false })}
                        className="hover:opacity-60 transition-opacity"
                        title="Dismiss banner (note remains active in context settings)"
                    >
                        <X size={12} strokeWidth={3} />
                    </button>
                </div>
            )}

            <div className="flex-1 overflow-y-auto px-2 md:px-4 py-4 space-y-3">
                {messages.length === 0 && (
                    <div className="flex items-center justify-center h-full">
                        <div className="text-center space-y-3">
                            <div className="text-4xl">⚔</div>
                            <p className="text-text-dim text-xs uppercase tracking-widest">
                                Awaiting transmission...
                            </p>
                            <div className="space-y-2">
                                <button
                                    onClick={() => setShowPCCreator(true)}
                                    className="block w-full px-6 py-2.5 bg-terminal/20 text-terminal border border-terminal/30 rounded hover:bg-terminal/30 transition-colors text-[11px] uppercase tracking-widest"
                                >
                                    Create Character
                                </button>
                                <p className="text-text-dim/50 text-[10px]">
                                    Or paste your lore in the context drawer, configure your LLM, and begin.
                                </p>
                            </div>
                        </div>
                    </div>
                )}

                {messages.length > visibleCount && (
                    <div className="flex justify-center py-2">
                        <button
                            onClick={() => setVisibleCount(prev => {
                                const next = prev + loadStep;
                                setLoadStep(s => s + 20);
                                return next;
                            })}
                            className="text-xs text-terminal/70 hover:text-terminal bg-terminal/10 hover:bg-terminal/20 px-4 py-2 rounded transition-colors"
                        >
                            ↑ Load older messages... ({messages.length - visibleCount} hidden)
                        </button>
                    </div>
                )}

                {messages.slice(-visibleCount).filter(msg => msg.role !== 'tool').map((msg, idx, arr) => (
                    <MessageBubble
                        key={msg.id}
                        message={msg}
                        isStreaming={isStreaming}
                        isLastMessage={idx === arr.length - 1}
                        showReasoning={!!settings.showReasoning}
                        debugMode={!!settings.debugMode}
                        onStartEdit={startEditing}
                        onRegenerate={handleRegenerate}
                        onDelete={(id) => deleteMessage(id)}
                    />
                ))}

                <UtilityCallStrip />
                <GenerationProgress phase={pipelinePhase} stats={streamingStats} />

                {loadingStatus && pipelinePhase === 'idle' && (
                    <div className="flex items-center gap-2 text-terminal text-xs px-4">
                        <Loader2 size={12} className="animate-spin" />
                        <span className="animate-pulse-slow">{loadingStatus}</span>
                    </div>
                )}

                <div ref={bottomRef} />
            </div>

            <div className="px-2 md:px-4 pb-1 flex gap-2 overflow-x-auto">
                <button
                    onClick={handleForceSave}
                    disabled={isSaving}
                    className="flex items-center gap-1.5 bg-void border border-emerald-500/30 hover:border-emerald-500 text-emerald-500 text-[10px] sm:text-[11px] uppercase tracking-wider px-2 sm:px-3 py-1.5 transition-all hover:bg-emerald-500/5 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {isSaving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                    <span className="hidden xs:inline">{isSaving ? 'SAVING...' : 'SAVE CAMPAIGN'}</span>
                    {!isSaving && <span className="inline xs:hidden">SAVE</span>}
                </button>
                <button
                    onClick={triggerCondense}
                    disabled={isStreaming || messages.length < 6}
                    className="flex items-center gap-1.5 bg-void border border-terminal/30 hover:border-terminal text-terminal text-[10px] sm:text-[11px] uppercase tracking-wider px-2 sm:px-3 py-1.5 transition-all hover:bg-terminal/5 disabled:opacity-30 disabled:cursor-not-allowed"
                    title="Trim history"
                >
                    <Zap size={13} />
                    Trim
                </button>
                {settings.deepContextSearch && (
                    <button
                        onClick={() => setDeepArmed(!deepArmed)}
                        disabled={isStreaming || !activeCampaignId}
                        className={`flex items-center gap-1.5 bg-void border text-[10px] sm:text-[11px] uppercase tracking-wider px-2 sm:px-3 py-1.5 transition-all disabled:opacity-30 disabled:cursor-not-allowed ${deepArmed ? 'border-amber-500 text-amber-500 bg-amber-500/10 hover:bg-amber-500/20' : 'border-amber-500/30 hover:border-amber-500 text-amber-500 hover:bg-amber-500/5'}`}
                        title={deepArmed ? 'Deep Search armed — type to send normally, or Esc to disarm' : 'Arm Deep Archive Search (sends on next Enter)'}
                    >
                        <Search size={13} />
                        <span className="hidden xs:inline">{deepArmed ? 'DEEP SEARCH ARMED' : 'Deep Search'}</span>
                        <span className="inline xs:hidden">{deepArmed ? 'ARMED' : 'Deep'}</span>
                    </button>
                )}
                {activeCampaignId && (
                    <CreateTroubleButton provider={activeProvider} />
                )}
                {activeCampaignId && (
                    <ArcInjectorButton />
                )}
                <button
                    onClick={handleOpenArchive}
                    disabled={!activeCampaignId}
                    className="flex items-center gap-1.5 bg-void border border-ice/30 hover:border-ice text-ice text-[10px] sm:text-[11px] uppercase tracking-wider px-2 sm:px-3 py-1.5 transition-all hover:bg-ice/5 disabled:opacity-30 disabled:cursor-not-allowed ml-auto"
                >
                    <Scroll size={13} />
                    Archive
                </button>
            </div>

            <div className="flex-shrink-0 bg-void border-t border-border">
                {pendingProposal && (
                    <div className="bg-amber-500/10 border-b border-amber-500/40 px-4 py-2 flex items-center justify-between gap-3">
                        <span className="text-amber-400 text-[11px] font-mono flex items-center gap-2 min-w-0">
                            <Package size={13} className="shrink-0" />
                            <span className="truncate">
                                GM proposes:{' '}
                                <span className="font-bold uppercase">{pendingProposal.op}</span>{' '}
                                <span className="text-text-primary">{pendingProposal.name}</span>
                                {pendingProposal.op === 'grant' && (
                                    <span className="text-text-dim"> ({pendingProposal.quality} {pendingProposal.kind})</span>
                                )}
                            </span>
                        </span>
                        <div className="flex items-center gap-1.5 shrink-0">
                            <button
                                onClick={() => applyInventoryProposal(pendingProposal)}
                                className="flex items-center gap-1 bg-green-900/30 border border-green-600 text-green-400 hover:bg-green-900/50 text-[10px] uppercase tracking-wider px-2 py-1 rounded-sm transition-colors"
                            >
                                <Check size={12} /> Apply
                            </button>
                            <button
                                onClick={() => setPendingProposal(null)}
                                className="flex items-center gap-1 text-text-dim hover:text-text-primary border border-border hover:border-text-dim text-[10px] uppercase tracking-wider px-2 py-1 rounded-sm transition-colors"
                            >
                                <X size={12} /> Dismiss
                            </button>
                        </div>
                    </div>
                )}
                {editingMessageId && (
                    <div className="bg-terminal/10 border-b border-border px-4 py-2 flex items-center justify-between">
                        <span className="text-terminal text-[11px] uppercase tracking-wider font-bold flex items-center gap-2">
                            <Edit2 size={12} /> Editing Message
                        </span>
                        <button
                            onClick={cancelEditing}
                            className="text-text-dim hover:text-text-primary flex items-center gap-1 text-[10px] uppercase tracking-wider"
                        >
                            <X size={12} /> Cancel
                        </button>
                    </div>
                )}
                <div className="px-2 sm:px-4 pb-3 sm:pb-4 pt-3 sm:pt-4">
                    <div className="flex gap-1 border border-border bg-void focus-within:border-terminal transition-colors items-end p-1 rounded-sm">
                        <div className="relative shrink-0 mb-[4px] ml-1">
                            <select
                                value={settings.activePresetId}
                                onChange={(e) => useAppStore.getState().setActivePreset(e.target.value)}
                                className="h-[32px] bg-surface border border-border text-text-dim hover:text-terminal hover:border-terminal/50 pl-3 pr-7 text-[10px] uppercase tracking-widest focus:outline-none focus:border-terminal max-w-[120px] sm:max-w-[150px] truncate cursor-pointer appearance-none rounded transition-colors font-bold"
                                title="Active AI Preset"
                            >
                                {settings.presets.map(p => (
                                    <option key={p.id} value={p.id}>{p.name}</option>
                                ))}
                            </select>
                            <svg className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-text-dim pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                        </div>
                        {deepArmed && (
                            <div className="shrink-0 mb-[4px] px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-widest bg-amber-500/15 text-amber-400 border border-amber-500/40 rounded animate-pulse">
                                Deep
                            </div>
                        )}
                        <textarea
                            ref={inputRef}
                            value={input}
                            onChange={handleInputChange}
                            onKeyDown={handleKeyDown}
                            placeholder={editingMessageId ? "Edit message..." : "What do you do?"}
                            className="flex-1 bg-transparent px-2 py-2.5 text-sm text-text-primary placeholder:text-text-dim/40 font-mono resize-none border-none outline-none min-h-[40px] leading-5"
                        />
                        <button
                            onClick={isStreaming ? handleStop : (editingMessageId ? handleEditSubmit : () => handleSend())}
                            disabled={!isStreaming && !input.trim()}
                            className={`h-[32px] w-[44px] mb-[4px] rounded transition-all disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center shrink-0 ${isStreaming ? 'text-amber-500 hover:bg-amber-500/10' : 'text-terminal hover:bg-terminal/10'}`}
                        >
                            {isStreaming ? <Square size={16} fill="currentColor" /> : (editingMessageId ? <Edit2 size={16} /> : <Send size={16} />)}
                        </button>
                    </div>
                </div>
            </div>

            {showPCCreator && (
                <PCCreationWizard
                    onComplete={(result) => {
                        useAppStore.getState().updateNPC(result.npcEntry.id, { ...result.npcEntry });
                        useAppStore.getState().updateContext({
                            characterProfile: result.characterProfile,
                            characterProfileActive: true,
                        });
                        setShowPCCreator(false);
                        toast.success(`Character "${result.npcEntry.name}" created!`);
                    }}
                    onCancel={() => setShowPCCreator(false)}
                />
            )}
        </div>
    );
}
