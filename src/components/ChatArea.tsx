import { useState, useRef, useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Send, Save, Loader2, Zap, Scroll, X, Square, Search, Check, Package, BookCheck, Pin, Replace, UserPlus, MapPin, Dices, ChevronUp, ArrowDown } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { runTurn } from '../services/turn/turnOrchestrator';
import { commitPendingTurn } from '../services/turn/pendingCommit';
import { findPendingCommitMessage } from '../services/turn/pendingCommit';
import { LootRollModal } from './chat/LootRollModal';
import { DiceRollModal } from './chat/DiceRollModal';
import { RegenerateSheet } from './chat/RegenerateSheet';
import { useSwipeVariants } from './hooks/useSwipeVariants';
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
import { IndexingBanner } from './IndexingBanner';
import { CreateTroubleButton } from './CreateTroubleButton';
import { ArcInjectorButton } from './ArcInjectorButton';
import { OneShotInjectorButton } from './OneShotInjectorButton';
import { PCCreationWizard } from './pc/PCCreationWizard';
import { addNpcFromSelection } from '../services/npc/manualAdd';
import { isLikelyFeatureLabel, parseLocationHeader, resolveLocationHeader } from '../services/locationHeader';
import { queueLocationEnrichment } from '../services/locationEnrich';

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
        setTimeline, setChapters, deleteDivergenceChapter,
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
            deleteDivergenceChapter: s.deleteDivergenceChapter,
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

    // WO-11.6 — Map tool_call_id -> result content, sourced from the (filtered-out)
    // `tool` role messages, so each assistant bubble can surface what its tool call
    // returned as a clean chip instead of raw system text.
    const toolResultById = useMemo(() => {
        const map = new Map<string, string>();
        for (const m of messages) {
            if (m.role === 'tool' && m.tool_call_id) map.set(m.tool_call_id, m.content);
        }
        return map;
    }, [messages]);

    // ── Swipe Generation v1 ──
    // The latest assistant message with pendingCommit=true, or null. Drives the
    // single useSwipeVariants hook instance owned by ChatArea. Scanning the tail
    // keeps this cheap and avoids re-subscribing on every keystroke.
    const pendingMessageId = useMemo(() => {
        const found = findPendingCommitMessage(messages);
        return found?.id ?? null;
    }, [messages]);

    const swipe = useSwipeVariants(pendingMessageId);
    const [swipeSheetMessageId, setSwipeSheetMessageId] = useState<string | null>(null);

    const deepArmed = useAppStore(s => s.deepArmed);

    // Selection state & action handlers (moved from Header for bottom toolbar visibility)
    type SelectionSnapshot = {
        messageId: string;
        text: string;
        start: number;
        end: number;
        bubbleText: string;
    };

    const stripMarkdown = (s: string) => s.replace(/\*\*/g, '').replace(/\*/g, '').trim();

    const captureFromBubble = (selector: string): SelectionSnapshot | null => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
        const range = sel.getRangeAt(0);
        const node = range.commonAncestorContainer;
        const el = (node.nodeType === 1 ? node as Element : node.parentElement);
        const bubble = el?.closest(selector) as HTMLElement | null;
        if (!bubble) return null;
        const messageId = bubble.dataset.messageId;
        const text = sel.toString().trim();
        if (!messageId || text.length < 1) return null;
        const bubbleText = bubble.textContent ?? '';
        let start = bubbleText.indexOf(text);
        if (start === -1) {
            const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
            start = norm(bubbleText).indexOf(norm(text));
        }
        if (start === -1) start = 0;
        return { messageId, text, start, end: start + text.length, bubbleText };
    };

    const openLoreCheck = useAppStore(s => s.openLoreCheck);
    const addPinnedExcerpt = useAppStore(s => s.addPinnedExcerpt);
    const openRenameModal = useAppStore(s => s.openRenameModal);
    const armedRoll = useAppStore(s => s.armedRoll);
    const setArmedRoll = useAppStore(s => s.setArmedRoll);
    const openDiceRollModal = useAppStore(s => s.openDiceRollModal);
    const armedLoot = useAppStore(s => s.armedLoot);
    const openLootRollModal = useAppStore(s => s.openLootRollModal);

    const [loreSel, setLoreSel] = useState<SelectionSnapshot | null>(null);
    const [pinSel, setPinSel] = useState<SelectionSnapshot | null>(null);
    const [renameSel, setRenameSel] = useState<SelectionSnapshot | null>(null);
    const [npcSel, setNpcSel] = useState<SelectionSnapshot | null>(null);
    const [npcAdding, setNpcAdding] = useState(false);

    useEffect(() => {
        const handle = () => {
            setLoreSel(captureFromBubble('[data-lore-checkable="true"]'));
            setPinSel(captureFromBubble('[data-message-id]'));
            setRenameSel(captureFromBubble('[data-message-id]'));
            setNpcSel(captureFromBubble('[data-lore-checkable="true"]'));
        };
        document.addEventListener('selectionchange', handle);
        return () => document.removeEventListener('selectionchange', handle);
    }, []);

    const handleLoreCheck = (e: React.MouseEvent | React.TouchEvent) => {
        e.preventDefault();
        const snap = captureFromBubble('[data-lore-checkable="true"]') ?? loreSel;
        if (!snap) {
            toast.info('Highlight text in a GM message first to check lore.');
            return;
        }
        const before = snap.bubbleText.slice(Math.max(0, snap.start - 200), snap.start);
        const after = snap.bubbleText.slice(snap.end, Math.min(snap.bubbleText.length, snap.end + 200));
        openLoreCheck({
            messageId: snap.messageId, selectedText: stripMarkdown(snap.text),
            start: snap.start, end: snap.end,
            surroundingContext: `${before}[[HIGHLIGHTED]]${snap.text}[[/HIGHLIGHTED]]${after}`,
        });
        window.getSelection()?.removeAllRanges();
        setLoreSel(null);
        setPinSel(null);
    };

    const handlePinSelection = (e: React.MouseEvent | React.TouchEvent) => {
        e.preventDefault();
        const snap = captureFromBubble('[data-message-id]') ?? pinSel;
        if (!snap) {
            toast.info('Highlight text in a message first to pin a memory.');
            return;
        }
        const result = addPinnedExcerpt(snap.messageId, snap.text, false);
        if (result.ok) {
            window.getSelection()?.removeAllRanges();
            setPinSel(null);
            setLoreSel(null);
        } else {
            toast.warning(result.reason);
        }
    };

    const handleRenameSelection = (e: React.MouseEvent | React.TouchEvent) => {
        e.preventDefault();
        const snap = captureFromBubble('[data-message-id]') ?? renameSel;
        if (!snap) {
            toast.info('Highlight a name/text in a message first to rename.');
            return;
        }
        openRenameModal(stripMarkdown(snap.text));
        window.getSelection()?.removeAllRanges();
        setRenameSel(null);
        setPinSel(null);
        setLoreSel(null);
    };

    const handleAddNpc = async (e: React.MouseEvent | React.TouchEvent) => {
        e.preventDefault();
        if (npcAdding) return;
        const snap = captureFromBubble('[data-lore-checkable="true"]') ?? npcSel;
        if (!snap) {
            toast.info('Highlight a name in a GM message first to add/update an NPC.');
            return;
        }
        const state = useAppStore.getState();
        const campaignId = state.activeCampaignId;
        if (!campaignId) { toast.warning('No active campaign.'); return; }

        window.getSelection()?.removeAllRanges();
        setNpcSel(null);
        setLoreSel(null);
        setPinSel(null);
        setNpcAdding(true);
        const cleanName = stripMarkdown(snap.text);
        toast.info(`Resolving "${cleanName}"…`);
        try {
            const result = await addNpcFromSelection({
                rawText: cleanName,
                ledger: state.npcLedger ?? [],
                messages: state.messages,
                campaignId,
                storyProvider: state.getActiveStoryEndpoint(),
                updateProvider: state.getActiveSummarizerEndpoint() ?? state.getActiveUtilityEndpoint() ?? state.getActiveStoryEndpoint(),
                addNPC: state.addNPC,
                updateNPC: state.updateNPC,
            });
            if (result.ok) toast.success(result.message);
            else if (result.kind === 'ambiguous') toast.warning(result.message);
            else toast.error(result.message);
        } catch (err) {
            toast.error(`Add NPC failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setNpcAdding(false);
        }
    };

    // Add Place — the manual fallback for rulesets that don't emit the 📍 [Location]
    // scene header. Selection-based like Add NPC, but zero LLM: known place → just set
    // the pointer; unknown → create a manual entry and set it current. The engine stays
    // the sole writer of the ledger; this button is the player's high-trust proposal path.
    const handleAddPlace = (e: React.MouseEvent | React.TouchEvent) => {
        e.preventDefault();
        const snap = captureFromBubble('[data-lore-checkable="true"]') ?? npcSel;
        if (!snap) {
            toast.info('Highlight a place name in a GM message first to add it.');
            return;
        }
        const state = useAppStore.getState();
        if (!state.activeCampaignId) { toast.warning('No active campaign.'); return; }

        window.getSelection()?.removeAllRanges();
        setNpcSel(null);
        setLoreSel(null);
        setPinSel(null);
        const cleanName = stripMarkdown(snap.text).trim();
        if (!cleanName || cleanName.length > 80) {
            toast.info('Couldn’t read a place name from the selection.');
            return;
        }
        const ledger = state.locationLedger ?? [];
        let anchorId = state.context.currentPlaceId ?? null;

        // Recover from older manual-add mistakes that stored an entire location
        // header (for example "📍 Town — Tower Top") as a duplicate place name.
        const currentEntry = anchorId ? ledger.find(l => l.id === anchorId) : undefined;
        if (currentEntry) {
            const canonical = resolveLocationHeader(
                currentEntry.name,
                ledger.filter(l => l.id !== currentEntry.id),
                null,
            );
            if (canonical.kind === 'resolved') anchorId = canonical.placeId;
        }

        const manualHeader = cleanName.includes('📍') ? cleanName : `📍 ${cleanName}`;
        const outcome = resolveLocationHeader(manualHeader, ledger, anchorId);
        const now = String(Date.now());

        if (outcome.kind === 'resolved') {
            const place = ledger.find(l => l.id === outcome.placeId);
            if (!place) return;
            if (outcome.appendFeature && outcome.feature) {
                state.updateLocation(place.id, {
                    features: [...place.features, outcome.feature],
                    lastSeenScene: now,
                });
            }
            state.updateContext({ currentPlaceId: place.id, currentFeature: outcome.feature });
            toast.success(outcome.feature
                ? `Current place: ${place.name} — ${outcome.feature}`
                : `Current place set: ${place.name}`);
            return;
        }

        if (outcome.kind === 'feature-only' && anchorId) {
            const place = ledger.find(l => l.id === anchorId);
            if (!place) return;
            if (outcome.appendFeature) {
                state.updateLocation(place.id, {
                    features: [...place.features, outcome.feature],
                    lastSeenScene: now,
                });
            }
            state.updateContext({ currentPlaceId: place.id, currentFeature: outcome.feature });
            toast.success(`${outcome.appendFeature ? 'Added' : 'Selected'} feature "${outcome.feature}" in ${place.name}.`);
            return;
        }

        const newName = outcome.kind === 'unknown' ? outcome.suggestion.name : cleanName;
        const rawManual = parseLocationHeader(manualHeader) ?? cleanName;
        const suffix = rawManual.toLowerCase().startsWith(newName.toLowerCase())
            ? rawManual.slice(newName.length).replace(/^[\s—–,:-]+/, '').trim()
            : '';
        const initialFeature = isLikelyFeatureLabel(suffix) ? suffix : null;
        const loc = {
            id: `loc_${now}_${Math.random().toString(36).slice(2, 7)}`,
            name: newName,
            aliases: '',
            broadLocation: '',
            features: initialFeature ? [initialFeature] : [],
            connections: [],
            description: '',
            firstSeenScene: now,
            lastSeenScene: now,
            source: 'manual' as const,
        };
        state.addLocation(loc);
        state.updateContext({ currentPlaceId: loc.id, currentFeature: initialFeature });
        state.dismissLocationSuggestion(newName);
        toast.success(initialFeature
            ? `Added "${newName}" with feature "${initialFeature}" and set it current.`
            : `Added "${newName}" and set as current place.`);
        // PRO/MAX: background AI fill (description/region/features/connections).
        // No-ops on lite tier or without a provider; the shell entry stands alone.
        queueLocationEnrichment(loc.id);
    };

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
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    const streamStartRef = useRef<number>(0);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages.length]);

    // WO-NAV — mobile-style message navigation: jump up one message, or snap to the latest.
    const handlePrevMessage = () => {
        const sc = scrollContainerRef.current;
        if (!sc) return;
        // Find the last bubble whose bottom is above the current viewport top (i.e. previous).
        const bubbles = Array.from(sc.querySelectorAll<HTMLElement>('[data-message-id], .chat-bubble-base'));
        const viewTop = sc.scrollTop;
        let target: HTMLElement | null = null;
        for (const b of bubbles) {
            const top = b.offsetTop;
            if (top < viewTop - 4) target = b;
            else break;
        }
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        else sc.scrollTo({ top: 0, behavior: 'smooth' });
    };

    const handleJumpToBottom = () => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

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
            armedRoll: useArmedRoll,
            armedLoot: useArmedLoot,
            armedOneShot: useArmedOneShot,
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
            addNpcSuggestions: storeSnapshot.addNpcSuggestions,
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

    const { editingMessageId, inlineDraft, setInlineDraft, startEditing, cancelEditing, handleEditSubmit, handleRegenerate, handleDeleteOutput } = useMessageEditor({
        messages,
        rollbackArchive: (ts) => rollbackArchiveFrom(archiveDeps, ts),
        deleteMessagesFrom,
        updateMessageContent: (id, content) => useAppStore.getState().updateMessageContent(id, content),
        onAfterEdit: (text) => handleSend(text),
        onAfterRegenerate: (text) => handleSend(text),
        activeCampaignId,
        deleteMessage,
        archiveDeps,
        deleteDivergenceChapter,
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
            handleSend();
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

            <div ref={scrollContainerRef} className="chat-panel flex-1 overflow-y-auto px-2 md:px-4 py-4 space-y-3 relative">
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
                        onDelete={(id) => handleDeleteOutput(id)}
                        toolResult={msg.tool_calls?.[0] ? toolResultById.get(msg.tool_calls[0].id) : undefined}
                        isEditing={editingMessageId === msg.id}
                        inlineDraft={editingMessageId === msg.id ? inlineDraft : undefined}
                        onInlineDraftChange={setInlineDraft}
                        onInlineSubmit={handleEditSubmit}
                        onInlineCancel={cancelEditing}
                        onOpenSwipeSheet={(id) => setSwipeSheetMessageId(id)}
                        onSwipeNavigate={(id, dir) => {
                            if (id !== pendingMessageId) return;
                            if (dir === 'prev') swipe.prevSwipe();
                            else swipe.nextSwipe();
                        }}
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

            <div className="px-2 md:px-4 pb-1 flex gap-2 overflow-x-auto no-scrollbar">
                <button
                    onClick={handleForceSave}
                    disabled={isSaving}
                    className="flex-shrink-0 flex items-center gap-1.5 bg-void border border-emerald-500/30 hover:border-emerald-500 text-emerald-500 text-[10px] sm:text-[11px] uppercase tracking-wider px-3 h-[32px] rounded-sm transition-all hover:bg-emerald-500/5 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                >
                    {isSaving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                    <span className="hidden xs:inline">{isSaving ? 'SAVING...' : 'SAVE CAMPAIGN'}</span>
                    {!isSaving && <span className="inline xs:hidden">SAVE</span>}
                </button>
                <button
                    onClick={triggerCondense}
                    disabled={isStreaming || messages.length < 6}
                    className="flex-shrink-0 flex items-center gap-1.5 bg-void border border-terminal/30 hover:border-terminal text-terminal text-[10px] sm:text-[11px] uppercase tracking-wider px-3 h-[32px] rounded-sm transition-all hover:bg-terminal/5 disabled:opacity-30 disabled:cursor-not-allowed whitespace-nowrap"
                    title="Trim history"
                >
                    <Zap size={13} />
                    Trim
                </button>
                {settings.deepContextSearch && (
                    <button
                        onClick={() => setDeepArmed(!deepArmed)}
                        disabled={isStreaming || !activeCampaignId}
                        className={`flex-shrink-0 flex items-center gap-1.5 bg-void border text-[10px] sm:text-[11px] uppercase tracking-wider px-3 h-[32px] rounded-sm transition-all disabled:opacity-30 disabled:cursor-not-allowed whitespace-nowrap ${deepArmed ? 'border-amber-500 text-amber-500 bg-amber-500/10 hover:bg-amber-500/20' : 'border-amber-500/30 hover:border-amber-500 text-amber-500 hover:bg-amber-500/5'}`}
                        title={deepArmed ? 'Deep Search armed — type to send normally, or Esc to disarm' : 'Arm Deep Archive Search (sends on next Enter)'}
                    >
                        <Search size={13} />
                        <span className="hidden xs:inline">{deepArmed ? 'DEEP SEARCH ARMED' : 'Deep Search'}</span>
                        <span className="inline xs:hidden">{deepArmed ? 'ARMED' : 'Deep'}</span>
                    </button>
                )}

                {/* Dice Me — opens 3-gate roll configurator modal */}
                <button
                    onClick={() => {
                        if (armedRoll) {
                            setArmedRoll(null);
                        } else {
                            openDiceRollModal();
                        }
                    }}
                    disabled={isStreaming || !activeCampaignId}
                    className={`flex-shrink-0 flex items-center gap-1.5 bg-void border text-[10px] sm:text-[11px] uppercase tracking-wider px-3 h-[32px] rounded-sm transition-all disabled:opacity-30 disabled:cursor-not-allowed whitespace-nowrap ${
                        armedRoll
                            ? 'border-amber-500 text-amber-500 bg-amber-500/10 hover:bg-amber-500/20 animate-pulse'
                            : 'border-terminal/30 text-terminal hover:bg-terminal/5'
                    }`}
                    title={armedRoll ? 'Dice armed — click to disarm, or send to roll' : 'Open dice roll configurator'}
                >
                    <Dices size={13} />
                    <span className="hidden xs:inline">{armedRoll ? 'DICE ARMED' : 'Dice Me'}</span>
                    <span className="inline xs:hidden">{armedRoll ? 'ARMED' : 'Dice'}</span>
                </button>

                {/* Loot Engine WO-05: manual loot drop trigger. Mirrors the dice button. */}
                {context?.lootTree && (
                    <button
                        onClick={() => {
                            if (!context?.lootTree) {
                                toast.warning('No loot table for this world');
                                    return;
                            }
                            openLootRollModal();
                        }}
                        className={`flex-shrink-0 flex items-center gap-1.5 bg-void border text-[10px] sm:text-[11px] uppercase tracking-wider px-3 h-[32px] rounded-sm transition-all whitespace-nowrap ${
                            armedLoot
                                ? 'border-amber-500 text-amber-500 bg-amber-500/10 hover:bg-amber-500/20 animate-pulse'
                                : 'border-terminal/30 text-terminal/60 hover:text-terminal hover:bg-terminal/5'
                        }`}
                        title={
                            armedLoot
                                ? `Loot armed (${armedLoot.rolls}) — send to drop`
                                : 'Roll loot — arm a drop, send to resolve'
                        }
                    >
                        <Package size={13} />
                        <span className="hidden xs:inline">{armedLoot ? `LOOT ARMED (${armedLoot.rolls})` : 'Roll Loot'}</span>
                        <span className="inline xs:hidden">{armedLoot ? `ARMED (${armedLoot.rolls})` : 'Loot'}</span>
                    </button>
                )}

                {/* Text Selection Actions - always clickable with adaptive styling and informational toasts */}
                <button
                    onMouseDown={handleLoreCheck}
                    onTouchStart={handleLoreCheck}
                    className={`flex-shrink-0 flex items-center gap-1.5 bg-void border text-[10px] sm:text-[11px] uppercase tracking-wider px-3 h-[32px] rounded-sm transition-all whitespace-nowrap cursor-pointer ${loreSel ? 'border-terminal text-terminal bg-terminal/5 animate-pulse' : 'border-terminal/30 text-terminal/60 hover:text-terminal hover:bg-terminal/5'}`}
                    title="Lore Check selection (highlight text in a GM message first)"
                >
                    <BookCheck size={13} />
                    Lore Check
                </button>

                <button
                    onMouseDown={handlePinSelection}
                    onTouchStart={handlePinSelection}
                    className={`flex-shrink-0 flex items-center gap-1.5 bg-void border text-[10px] sm:text-[11px] uppercase tracking-wider px-3 h-[32px] rounded-sm transition-all whitespace-nowrap cursor-pointer ${pinSel ? 'border-terminal text-terminal bg-terminal/5 animate-pulse' : 'border-terminal/30 text-terminal/60 hover:text-terminal hover:bg-terminal/5'}`}
                    title="Pin selected text as a memory"
                >
                    <Pin size={13} />
                    Pin Memory
                </button>

                <button
                    onMouseDown={handleRenameSelection}
                    onTouchStart={handleRenameSelection}
                    className={`flex-shrink-0 flex items-center gap-1.5 bg-void border text-[10px] sm:text-[11px] uppercase tracking-wider px-3 h-[32px] rounded-sm transition-all whitespace-nowrap cursor-pointer ${renameSel ? 'border-terminal text-terminal bg-terminal/5 animate-pulse' : 'border-terminal/30 text-terminal/60 hover:text-terminal hover:bg-terminal/5'}`}
                    title="Rename selected name everywhere (highlight a name first)"
                >
                    <Replace size={13} />
                    Rename
                </button>

                <button
                    onMouseDown={handleAddNpc}
                    onTouchStart={handleAddNpc}
                    className={`flex-shrink-0 flex items-center gap-1.5 bg-void border text-[10px] sm:text-[11px] uppercase tracking-wider px-3 h-[32px] rounded-sm transition-all whitespace-nowrap cursor-pointer ${npcSel ? 'border-terminal text-terminal bg-terminal/5 animate-pulse' : 'border-terminal/30 text-terminal/60 hover:text-terminal hover:bg-terminal/5'}`}
                    title="Add highlighted name to the NPC ledger (or update if it exists)"
                >
                    {npcAdding ? <Loader2 size={13} className="animate-spin" /> : <UserPlus size={13} />}
                    Add NPC
                </button>

                <button
                    onMouseDown={handleAddPlace}
                    onTouchStart={handleAddPlace}
                    className={`flex-shrink-0 flex items-center gap-1.5 bg-void border text-[10px] sm:text-[11px] uppercase tracking-wider px-3 h-[32px] rounded-sm transition-all whitespace-nowrap cursor-pointer ${npcSel ? 'border-terminal text-terminal bg-terminal/5 animate-pulse' : 'border-terminal/30 text-terminal/60 hover:text-terminal hover:bg-terminal/5'}`}
                    title="Add highlighted place to the location ledger and set it as current (or just set current if it exists)"
                >
                    <MapPin size={13} />
                    Add Place
                </button>

                {activeCampaignId && (
                    <CreateTroubleButton provider={activeProvider} />
                )}
                {activeCampaignId && (
                    <ArcInjectorButton />
                )}
                {activeCampaignId && (
                    <OneShotInjectorButton />
                )}
                <button
                    onClick={handleOpenArchive}
                    disabled={!activeCampaignId}
                    className="flex-shrink-0 flex items-center gap-1.5 bg-void border border-ice/30 hover:border-ice text-ice text-[10px] sm:text-[11px] uppercase tracking-wider px-3 h-[32px] rounded-sm transition-all hover:bg-ice/5 disabled:opacity-30 disabled:cursor-not-allowed ml-auto whitespace-nowrap"
                >
                    <Scroll size={13} />
                    Archive
                </button>
            </div>

            <div className="flex-shrink-0 bg-void border-t border-border">
                <IndexingBanner campaignId={activeCampaignId} />
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
                            placeholder="What do you do?"
                            className="flex-1 bg-transparent px-2 py-2.5 text-sm text-text-primary placeholder:text-text-dim/40 font-mono resize-none border-none outline-none min-h-[40px] leading-5"
                        />
                        <button
                            onClick={isStreaming ? handleStop : () => handleSend()}
                            disabled={!isStreaming && !input.trim()}
                            className={`h-[32px] w-[44px] mb-[4px] rounded transition-all disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center shrink-0 ${isStreaming ? 'text-amber-500 hover:bg-amber-500/10' : 'text-terminal hover:bg-terminal/10'}`}
                        >
                            {isStreaming ? <Square size={16} fill="currentColor" /> : <Send size={16} />}
                        </button>
                    </div>
                </div>
            </div>

            <div className="absolute right-3 bottom-[145px] flex flex-col gap-1.5 z-30 pointer-events-auto">
                <button
                    onClick={handlePrevMessage}
                    className="chat-nav-fab flex items-center justify-center w-9 h-9 rounded-full bg-void-darker border border-text-dim/30 hover:border-text-dim text-text-dim hover:text-text-primary shadow-lg transition-all hover:bg-text-dim/10"
                    title="Jump up one message"
                >
                    <ChevronUp size={16} />
                </button>
                <button
                    onClick={handleJumpToBottom}
                    className="chat-nav-fab flex items-center justify-center w-9 h-9 rounded-full bg-void-darker border border-text-dim/30 hover:border-text-dim text-text-dim hover:text-text-primary shadow-lg transition-all hover:bg-text-dim/10"
                    title="Jump to latest message"
                >
                    <ArrowDown size={16} />
                </button>
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

            <LootRollModal />
            <DiceRollModal />
            <RegenerateSheet
                messageId={swipeSheetMessageId}
                onClose={() => setSwipeSheetMessageId(null)}
                swipeGenLoading={swipe.swipeGenLoading}
                generateSwipe={swipe.generateSwipe}
                nextSwipe={swipe.nextSwipe}
                prevSwipe={swipe.prevSwipe}
                getSessionOffset={swipe.getSessionOffset}
                setSessionOffset={swipe.setSessionOffset}
                getSwipeTemperature={swipe.getSwipeTemperature}
            />
        </div>
    );
}
