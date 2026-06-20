import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatArea } from '../ChatArea';
import type { ChatMessage, AppSettings, GameContext, CondenserState } from '../../types';

vi.mock('../../store/useAppStore', () => {
    const state = {
        messages: [] as ChatMessage[],
        condenser: { condensedUpToIndex: -1 } as CondenserState,
        context: {
            loreRaw: '', rulesRaw: '', canonState: '', headerIndex: '',
            starter: '', continuePrompt: '', inventory: '', inventoryLastScene: '',
            characterProfile: '', characterProfileLastScene: '',
            canonStateActive: false, headerIndexActive: false,
            starterActive: false, continuePromptActive: false,
            inventoryActive: false, characterProfileActive: false,
            surpriseEngineActive: false, encounterEngineActive: false,
            worldEngineActive: false, diceFairnessActive: false,
            sceneNote: '', sceneNoteActive: false, sceneNoteDepth: 0,
            worldVibe: '',
            notebook: [], notebookActive: false,
        } as unknown as GameContext,
        activeCampaignId: 'test-campaign',
        settings: {
            presets: [{ id: 'p1', name: 'Test', storyAIProviderId: 'prov1' }],
            providers: [{ id: 'prov1', label: 'Test', endpoint: 'http://test', apiKey: 'k', modelName: 'm' }],
            activePresetId: 'p1',
            contextLimit: 4096,
            debugMode: false,
            showReasoning: true,
            autoCondenseEnabled: true,
            condenseAggressiveness: 'smart' as const,
        } as unknown as AppSettings,
        loreChunks: [],
        npcLedger: [],
        archiveIndex: [],
        chapters: [],
        timeline: [],
        pinnedChapterIds: [],
        bookkeepingTurnCounter: 0,
        autoBookkeepingInterval: 5,
        setArchiveIndex: vi.fn(),
        clearArchive: vi.fn(),
        updateLastAssistant: vi.fn(),
        updateContext: vi.fn(),
        setCondensed: vi.fn(),
        deleteMessage: vi.fn(),
        deleteMessagesFrom: vi.fn(),
        resetCondenser: vi.fn(),
        setTimeline: vi.fn(),
        setChapters: vi.fn(),
        addMessage: vi.fn(),
        updateLastMessage: vi.fn(),
        updateNPC: vi.fn(),
        addNPC: vi.fn(),
        setLastPayloadTrace: vi.fn(),
        setActivePreset: vi.fn(),
        clearPinnedChapters: vi.fn(),
        incrementBookkeepingTurnCounter: vi.fn(() => 1),
        resetBookkeepingTurnCounter: vi.fn(),
        setCondenser: vi.fn(),
        getActiveStoryEndpoint: vi.fn(() => ({ id: 'prov1', label: 'Test', endpoint: 'http://test', apiKey: 'k', modelName: 'm' })),
        getActiveUtilityEndpoint: vi.fn(() => undefined),
        getActiveSummarizerEndpoint: vi.fn(() => undefined),
        getActivePreset: vi.fn(() => undefined),
        setDivergenceRegister: vi.fn(),
        toggleDivergenceChapter: vi.fn(),
        toggleDivergenceCategory: vi.fn(),
        pinDivergenceFact: vi.fn(),
        editDivergenceFact: vi.fn(),
        deleteDivergenceFact: vi.fn(),
        dismissDivergenceReviewFlag: vi.fn(),
        confirmReviewEntry: vi.fn(),
        divergenceRegister: { entries: [], chapterToggles: {}, categoryToggles: {}, lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 2 },
        pipelinePhase: 'idle' as const,
        streamingStats: null,
        setPipelinePhase: vi.fn(),
        setStreamingStats: vi.fn(),
        setStreaming: vi.fn(),
        toggleDrawer: vi.fn(),
        drawerOpen: false,
    };
    const subscribe = vi.fn(() => vi.fn());
    const getState = vi.fn(() => state);
    const useAppStore = Object.assign(
        (selector: any) => {
            const result = selector(state);
            return result;
        },
        { getState, subscribe }
    );
    return { useAppStore };
});

vi.mock('../../services/turnOrchestrator', () => ({
    runTurn: vi.fn(async () => {}),
}));

vi.mock('../../services/condenser', () => ({
    shouldCondense: vi.fn(() => false),
    computeTrimIndex: vi.fn(() => -1),
    getCondenseBudgetRatio: vi.fn(() => 0.75),
}));

vi.mock('../../services/saveFileEngine', () => ({
    runSaveFilePipeline: vi.fn(async () => ({ headerIndex: '', indexSuccess: true })),
    generateChapterSummary: vi.fn(async () => null),
}));

vi.mock('../../services/llm/apiClient', () => ({
    api: {
        archive: {
            open: vi.fn(async () => {}),
            clear: vi.fn(async () => {}),
            getIndex: vi.fn(async () => []),
            deleteFrom: vi.fn(async () => {}),
            fetchScenes: vi.fn(async () => []),
        },
        chapters: {
            seal: vi.fn(async () => null),
            list: vi.fn(async () => []),
            update: vi.fn(async () => {}),
        },
        timeline: {
            get: vi.fn(async () => []),
        },
    },
}));

vi.mock('../../lib/apiBase', () => ({
    API_BASE: 'http://localhost:3001',
}));

vi.mock('idb-keyval', () => ({
    set: vi.fn(async () => {}),
}));

vi.mock('../Toast', () => ({
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('../../services/archiveChapterEngine', () => ({
    shouldAutoSeal: vi.fn(() => ({ shouldSeal: false, reason: '' })),
}));

import { useAppStore } from '../../store/useAppStore';
import { runTurn } from '../../services/turnOrchestrator';

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
    return {
        id: `msg-${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        content: 'Hello',
        timestamp: Date.now(),
        ...overrides,
    };
}

describe('ChatArea', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        const state = useAppStore.getState();
        state.messages = [];
        state.condenser = { condensedUpToIndex: -1 };
        state.activeCampaignId = 'test-campaign';
        state.archiveIndex = [];
        state.chapters = [];
    });

    it('renders empty state when no messages', () => {
        render(<ChatArea />);
        expect(screen.getByText('Awaiting transmission...')).toBeInTheDocument();
    });

    it('renders message list with user and assistant messages', () => {
        const state = useAppStore.getState();
        state.messages = [
            makeMessage({ role: 'user', content: 'I attack the dragon' }),
            makeMessage({ role: 'assistant', content: 'The dragon roars!' }),
        ];
        render(<ChatArea />);
        expect(screen.getByText('I attack the dragon')).toBeInTheDocument();
        expect(screen.getByText('The dragon roars!')).toBeInTheDocument();
    });

    it('sends message on button click', async () => {
        const user = userEvent.setup();
        render(<ChatArea />);
        const textarea = screen.getByPlaceholderText('What do you do?');
        await user.type(textarea, 'Hello world');
        const sendBtn = screen.getByPlaceholderText('What do you do?')
            .closest('.flex')?.querySelector('button:last-child') as HTMLElement;
        await user.click(sendBtn);
        expect(runTurn).toHaveBeenCalled();
        const [turnState] = (runTurn as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(turnState.input).toBe('Hello world');
    });

    it('sends message on Enter key', async () => {
        const user = userEvent.setup();
        render(<ChatArea />);
        const textarea = screen.getByPlaceholderText('What do you do?');
        await user.type(textarea, 'Testing enter{Enter}');
        expect(runTurn).toHaveBeenCalled();
    });

    it('does not send on Shift+Enter', async () => {
        const user = userEvent.setup();
        render(<ChatArea />);
        const textarea = screen.getByPlaceholderText('What do you do?');
        await user.type(textarea, 'No send{Shift>}{Enter}');
        expect(runTurn).not.toHaveBeenCalled();
    });

    it('enters edit mode when edit button clicked', async () => {
        const user = userEvent.setup();
        const state = useAppStore.getState();
        state.messages = [
            makeMessage({ role: 'user', content: 'Editable message' }),
        ];
        render(<ChatArea />);
        const editBtn = screen.getByTitle('Edit');
        await user.click(editBtn);
        expect(screen.getByText('Editing Message')).toBeInTheDocument();
    });

    it('shows streaming indicator when isStreaming is true', () => {
        const state = useAppStore.getState();
        state.messages = [makeMessage({ role: 'user', content: 'Hi' })];
        (runTurn as ReturnType<typeof vi.fn>).mockImplementation(async (_s: any, _c: any, _ac: any) => {
            state.messages.push(makeMessage({ role: 'assistant', content: 'streaming...' }));
        });
        render(<ChatArea />);
    });

    it('force save writes to IndexedDB', async () => {
        const user = userEvent.setup();
        render(<ChatArea />);
        const saveBtn = screen.getByText(/SAVE CAMPAIGN/i).closest('button')!;
        await user.click(saveBtn);
    });

    it('shows load more button when messages exceed visibleCount', () => {
        const state = useAppStore.getState();
        state.messages = Array.from({ length: 20 }, (_, i) =>
            makeMessage({ role: 'user', content: `Message ${i}` })
        );
        render(<ChatArea />);
        expect(screen.getByText(/Load older messages/i)).toBeInTheDocument();
    });
});
