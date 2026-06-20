import type { StateCreator } from 'zustand';
import type { ArchiveIndexEntry, ChatMessage, CondenserState, GameContext, DivergenceRegister, DivergenceEntry, DivergenceCategory, TopicClusters, PinnedExcerpt } from '../../types';
import { debouncedSaveCampaignState } from './campaignSlice';
import { uid } from '../../utils/uid';
import { countTokens } from '../../services/infrastructure/tokenizer';

const PINNED_EXCERPTS_TOKEN_CAP = 3000;

// ── Slice type ─────────────────────────────────────────────────────────

export type ChatSlice = {
    messages: ChatMessage[];
    isStreaming: boolean;
    addMessage: (msg: ChatMessage) => void;
    updateLastAssistant: (content: string) => void;
    updateLastMessage: (patch: Partial<ChatMessage>) => void;
    updateMessageContent: (id: string, content: string) => void;
    replaceMessageText: (messageId: string, oldText: string, newText: string) => void;
    deleteMessage: (id: string) => void;
    deleteMessagesFrom: (id: string) => void;
    setStreaming: (v: boolean) => void;
    clearChat: () => void;
    clearArchive: () => void;

    condenser: CondenserState;
    setCondensed: (upToIndex: number) => void;
    resetCondenser: () => void;
    setCondenser: (state: CondenserState) => void;

    divergenceRegister: DivergenceRegister;
    setDivergenceRegister: (register: DivergenceRegister) => void;
    toggleDivergenceChapter: (chapterId: string, on: boolean) => void;
    toggleDivergenceCategory: (chapterId: string, category: DivergenceCategory, on: boolean) => void;
    pinDivergenceFact: (entryId: string) => void;
    editDivergenceFact: (entryId: string, text: string) => void;
    deleteDivergenceFact: (entryId: string) => void;
    addDivergenceEntry: (entry: DivergenceEntry) => void;
    dismissDivergenceReviewFlag: (entryId: string) => void;
    confirmReviewEntry: (id: string) => void;
    toggleDivergenceFact: (factId: string) => void;
    deleteDivergenceChapter: (sceneId: string) => void;
    resetDivergenceRegister: () => void;
    updateMessageDivergence: (messageId: string, divergenceIds: string[]) => void;
    deleteReviewedEntry: (id: string) => void;
    setTopicClusters: (clusters: TopicClusters) => void;
    setManyFactsEnabled: (updates: Array<{ id: string; enabled: boolean }>) => void;

    pinnedExcerpts: PinnedExcerpt[];
    addPinnedExcerpt: (sourceMessageId: string, text: string, isFullMessage: boolean) => { ok: true } | { ok: false; reason: string };
    removePinnedExcerpt: (id: string) => void;
    clearPinnedExcerpts: () => void;

    renameModalOpen: boolean;
    renameModalText: string;
    openRenameModal: (text: string) => void;
    closeRenameModal: () => void;
    renameAcrossMessages: (from: string, to: string) => number;
};

// ── Cross-slice dependencies ───────────────────────────────────────────

type ChatDeps = ChatSlice & {
    activeCampaignId: string | null;
    context: GameContext;
    archiveIndex: ArchiveIndexEntry[];
};

// ── Slice creator ──────────────────────────────────────────────────────

export const createChatSlice: StateCreator<ChatDeps, [], [], ChatSlice> = (set) => ({
    // Condenser defaults
    condenser: {
        condensedUpToIndex: -1,
    },
    setCondensed: (upToIndex) =>
        set((s) => {
            const newCondenser = { ...s.condenser, condensedUpToIndex: upToIndex };
            debouncedSaveCampaignState();
            return { condenser: newCondenser };
        }),
    resetCondenser: () =>
        set(() => {
            const newCondenser = { condensedUpToIndex: -1 };
            debouncedSaveCampaignState();
            return { condenser: newCondenser };
        }),
    setCondenser: (state) =>
        set((_s) => {
            debouncedSaveCampaignState();
            return { condenser: state };
        }),

    divergenceRegister: { entries: [], chapterToggles: {}, categoryToggles: {}, lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 2 },
    setDivergenceRegister: (register) =>
        set((_s) => {
            debouncedSaveCampaignState();
            return { divergenceRegister: register };
        }),
    toggleDivergenceChapter: (chapterId, on) =>
        set((s) => {
            const chapterToggles = { ...s.divergenceRegister.chapterToggles, [chapterId]: on };
            debouncedSaveCampaignState();
            return { divergenceRegister: { ...s.divergenceRegister, chapterToggles, lastUpdatedAt: Date.now() } };
        }),
    toggleDivergenceCategory: (chapterId, category, on) => {
        set((s) => {
            const existing = s.divergenceRegister.categoryToggles[chapterId] ?? {};
            const categoryToggles = {
                ...s.divergenceRegister.categoryToggles,
                [chapterId]: { ...existing, [category]: on },
            };
            debouncedSaveCampaignState();
            return { divergenceRegister: { ...s.divergenceRegister, categoryToggles, lastUpdatedAt: Date.now() } };
        });
    },
    pinDivergenceFact: (entryId) =>
        set((s) => {
            const entries = s.divergenceRegister.entries.map(e =>
                e.id === entryId ? { ...e, pinned: !e.pinned } : e
            );
            debouncedSaveCampaignState();
            return { divergenceRegister: { ...s.divergenceRegister, entries, lastUpdatedAt: Date.now() } };
        }),
    editDivergenceFact: (entryId, text) =>
        set((s) => {
            const entries = s.divergenceRegister.entries.map(e =>
                e.id === entryId ? { ...e, text, source: 'manual' as const } : e
            );
            debouncedSaveCampaignState();
            return { divergenceRegister: { ...s.divergenceRegister, entries, lastUpdatedAt: Date.now() } };
        }),
    deleteDivergenceFact: (entryId) =>
        set((s) => {
            const entries = s.divergenceRegister.entries.filter(e => e.id !== entryId);
            let topicClusters = s.divergenceRegister.topicClusters;
            if (topicClusters) {
                const groups = topicClusters.groups.map(g => ({
                    ...g,
                    factIds: g.factIds.filter(id => id !== entryId),
                })).filter(g => g.factIds.length > 0);
                topicClusters = { ...topicClusters, groups };
            }
            debouncedSaveCampaignState();
            return { divergenceRegister: { ...s.divergenceRegister, entries, topicClusters, lastUpdatedAt: Date.now() } };
        }),
    addDivergenceEntry: (entry) =>
        set((s) => {
            const entries = [...s.divergenceRegister.entries, entry];
            debouncedSaveCampaignState();
            return { divergenceRegister: { ...s.divergenceRegister, entries, lastUpdatedAt: Date.now() } };
        }),
    dismissDivergenceReviewFlag: (entryId) =>
        set((s) => {
            const entries = s.divergenceRegister.entries.map(e =>
                e.id === entryId ? { ...e, reviewFlag: undefined, unrecognizedNpcNames: undefined } : e
            );
            debouncedSaveCampaignState();
            return { divergenceRegister: { ...s.divergenceRegister, entries, lastUpdatedAt: Date.now() } };
        }),
    confirmReviewEntry: (id) =>
        set((s) => {
            const entries = s.divergenceRegister.entries.map(e =>
                e.id === id ? { ...e, reviewFlag: undefined, unrecognizedNpcNames: undefined } : e
            );
            debouncedSaveCampaignState();
            return { divergenceRegister: { ...s.divergenceRegister, entries, lastUpdatedAt: Date.now() } };
        }),
    toggleDivergenceFact: (factId) =>
        set((s) => {
            const entries = s.divergenceRegister.entries.map(e =>
                e.id === factId ? { ...e, enabled: !(e.enabled !== false) } : e
            );
            debouncedSaveCampaignState();
            return { divergenceRegister: { ...s.divergenceRegister, entries, lastUpdatedAt: Date.now() } };
        }),
    deleteDivergenceChapter: (sceneId) =>
        set((s) => {
            const entries = s.divergenceRegister.entries.filter(
                e => e.sceneRef !== sceneId || e.source === 'manual'
            );
            const chapterToggles = { ...s.divergenceRegister.chapterToggles };
            delete chapterToggles[sceneId];
            debouncedSaveCampaignState();
            return { divergenceRegister: { ...s.divergenceRegister, entries, chapterToggles, lastUpdatedAt: Date.now() } };
        }),
    resetDivergenceRegister: () =>
        set(() => {
            debouncedSaveCampaignState();
            return { divergenceRegister: { entries: [], chapterToggles: {}, categoryToggles: {}, prunedLog: [], lastUpdatedSceneId: '', lastUpdatedAt: Date.now(), version: 2 } };
        }),
    updateMessageDivergence: (messageId, divergenceIds) =>
        set((s) => {
            const messages = s.messages.map(msg =>
                msg.id === messageId ? { ...msg, divergenceIds } : msg
            );
            debouncedSaveCampaignState();
            return { messages };
        }),
    deleteReviewedEntry: (id) =>
        set((s) => {
            const entries = s.divergenceRegister.entries.filter(e => e.id !== id);
            const prunedLog = (s.divergenceRegister.prunedLog ?? []).filter(e => e.id !== id);
            debouncedSaveCampaignState();
            return { divergenceRegister: { ...s.divergenceRegister, entries, prunedLog, lastUpdatedAt: Date.now() } };
        }),
    setTopicClusters: (clusters) =>
        set((s) => {
            debouncedSaveCampaignState();
            return { divergenceRegister: { ...s.divergenceRegister, topicClusters: clusters, lastUpdatedAt: Date.now() } };
        }),
    setManyFactsEnabled: (updates) =>
        set((s) => {
            const updateMap = new Map(updates.map(u => [u.id, u.enabled]));
            const entries = s.divergenceRegister.entries.map(e => {
                const enabled = updateMap.get(e.id);
                return enabled !== undefined ? { ...e, enabled } : e;
            });
            debouncedSaveCampaignState();
            return { divergenceRegister: { ...s.divergenceRegister, entries, lastUpdatedAt: Date.now() } };
        }),

    // Chat defaults
    messages: [],
    isStreaming: false,
    addMessage: (msg) =>
        set((s) => ({ messages: [...s.messages, msg] })),
    updateLastAssistant: (content) =>
        set((s) => {
            const msgs = [...s.messages];
            for (let i = msgs.length - 1; i >= 0; i--) {
                if (msgs[i].role === 'assistant') {
                    msgs[i] = { ...msgs[i], content };
                    return { messages: msgs };
                }
            }
            return { messages: msgs };
        }),
    updateLastMessage: (patch) =>
        set((s) => {
            const msgs = [...s.messages];
            const lastIdx = msgs.length - 1;
            if (lastIdx >= 0) {
                msgs[lastIdx] = { ...msgs[lastIdx], ...patch };
            }
            return { messages: msgs };
        }),
    updateMessageContent: (id, content) =>
        set((s) => {
            const msgs = s.messages.map(m => m.id === id ? { ...m, content } : m);
            debouncedSaveCampaignState();
            return { messages: msgs };
        }),
    replaceMessageText: (messageId, oldText, newText) =>
        set((s) => {
            const msgs = s.messages.map(msg => {
                if (msg.id !== messageId) return msg;
                const content = typeof msg.content === 'string'
                    ? msg.content.replace(oldText, newText)
                    : msg.content;
                return { ...msg, content };
            });
            debouncedSaveCampaignState();
            return { messages: msgs };
        }),
    deleteMessage: (id) =>
        set((s) => {
            const msgs = s.messages.filter(m => m.id !== id);
            debouncedSaveCampaignState();
            return { messages: msgs };
        }),
    deleteMessagesFrom: (id) =>
        set((s) => {
            const index = s.messages.findIndex(m => m.id === id);
            if (index === -1) return { messages: s.messages };
            const msgs = s.messages.slice(0, index);
            debouncedSaveCampaignState();
            return { messages: msgs };
        }),
    setStreaming: (v) => set({ isStreaming: v } as Partial<ChatDeps>),
    clearChat: () => set((_s) => {
        const newCondenser = { condensedUpToIndex: -1 };
        const newDivReg = { entries: [], chapterToggles: {}, categoryToggles: {}, lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 2 };
        debouncedSaveCampaignState();
        return { messages: [], condenser: newCondenser, divergenceRegister: newDivReg, context: { ..._s.context, notebook: [] } } as Partial<ChatDeps>;
    }),
    clearArchive: () => set({ archiveIndex: [] } as Partial<ChatDeps>),

    pinnedExcerpts: [],
    addPinnedExcerpt: (sourceMessageId, text, isFullMessage) => {
        let result: { ok: true } | { ok: false; reason: string } = { ok: true };
        set((s) => {
            const newTokens = countTokens(text);
            const currentTotal = s.pinnedExcerpts.reduce((sum, e) => sum + countTokens(e.text), 0);
            if (currentTotal + newTokens > PINNED_EXCERPTS_TOKEN_CAP) {
                result = { ok: false, reason: 'Pinned memories full — unpin something first' };
                return s;
            }
            const excerpt: PinnedExcerpt = {
                id: `pin_${uid()}`,
                sourceMessageId,
                text,
                createdAt: Date.now(),
                isFullMessage,
            };
            const pinnedExcerpts = [...s.pinnedExcerpts, excerpt];
            debouncedSaveCampaignState();
            return { pinnedExcerpts };
        });
        return result;
    },
    removePinnedExcerpt: (id) =>
        set((s) => {
            const pinnedExcerpts = s.pinnedExcerpts.filter(e => e.id !== id);
            debouncedSaveCampaignState();
            return { pinnedExcerpts };
        }),
    clearPinnedExcerpts: () =>
        set(() => {
            debouncedSaveCampaignState();
            return { pinnedExcerpts: [] };
        }),

    renameModalOpen: false,
    renameModalText: '',
    openRenameModal: (text) => set({ renameModalOpen: true, renameModalText: text }),
    closeRenameModal: () => set({ renameModalOpen: false, renameModalText: '' }),
    renameAcrossMessages: (from, to) => {
        const fromTrim = from.trim();
        if (!fromTrim || !to.trim()) return 0;
        const pat = `\\b${fromTrim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`;
        let changed = 0;
        set((s) => {
            const msgs = s.messages.map(m => {
                const next = { ...m };
                let touched = false;
                if (typeof m.content === 'string') {
                    const rep = m.content.replace(new RegExp(pat, 'gi'), to);
                    if (rep !== m.content) { next.content = rep; touched = true; }
                }
                if (typeof m.displayContent === 'string') {
                    const rep = m.displayContent.replace(new RegExp(pat, 'gi'), to);
                    if (rep !== m.displayContent) { next.displayContent = rep; touched = true; }
                }
                if (touched) changed++;
                return next;
            });
            if (changed === 0) return {};
            debouncedSaveCampaignState();
            return { messages: msgs };
        });
        return changed;
    },
});