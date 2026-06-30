import { describe, it, expect } from 'vitest';
import { buildPayload } from '../payload/payloadBuilder';
import { DEFAULT_RULES } from '../rules/defaultRules';
import type {
    GameContext,
    AppSettings,
    LoreChunk,
    NPCEntry,
    ArchiveScene,
    ArchiveIndexEntry,
    TimelineEvent,
    DivergenceRegister,
    ChatMessage,
} from '../../types';

const baseContext = (): GameContext => ({
    loreRaw: '',
    rulesRaw: '',
    canonState: '',
    headerIndex: '',
    starter: '',
    continuePrompt: '',
    inventory: '',
    inventoryLastScene: 'Never',
    characterProfile: '',
    characterProfileLastScene: 'Never',
    surpriseDC: 95,
    encounterDC: 198,
    worldEventDC: 498,
    canonStateActive: false,
    headerIndexActive: false,
    starterActive: false,
    continuePromptActive: false,
    inventoryActive: false,
    characterProfileActive: false,
    surpriseEngineActive: true,
    encounterEngineActive: true,
    worldEngineActive: true,
    diceFairnessActive: true,
    sceneNote: '',
    sceneNoteActive: false,
    sceneNoteDepth: 3,
    diceConfig: { catastrophe: 2, failure: 6, success: 15, triumph: 19, crit: 20 },
    surpriseConfig: { initialDC: 95, dcReduction: 3, types: [], tones: [] },
    encounterConfig: { initialDC: 198, dcReduction: 2, types: [], tones: [] },
    worldVibe: '',
    notebook: [],
    notebookActive: true,
    worldEventConfig: { initialDC: 498, dcReduction: 2, who: [], where: [], why: [], what: [] },
} as GameContext);

const baseSettings = (): AppSettings => ({
    debugMode: true,
    contextLimit: 8192,
} as unknown as AppSettings);

describe('buildPayload — default rules fallback', () => {
    it('injects DEFAULT_RULES when rulesRaw is empty', () => {
        const ctx = baseContext();
        ctx.rulesRaw = '';
        const result = buildPayload(baseSettings(), ctx, [], 'I look around');
        const firstSystem = result.messages.find(m => m.role === 'system');
        expect(firstSystem).toBeDefined();
        expect(firstSystem!.content).toContain('ROLE: Dynamic-Realism GM.');
    });

    it('uses user-provided rulesRaw instead of DEFAULT_RULES', () => {
        const ctx = baseContext();
        ctx.rulesRaw = '# My Custom Rules\nNo magic allowed.';
        const result = buildPayload(baseSettings(), ctx, [], 'I look around');
        const firstSystem = result.messages.find(m => m.role === 'system');
        expect(firstSystem).toBeDefined();
        expect(firstSystem!.content).toContain('My Custom Rules');
        expect(firstSystem!.content).not.toContain(DEFAULT_RULES);
    });

    it('DEFAULT_RULES contains all expected sections', () => {
        expect(DEFAULT_RULES).toContain('### Output Format');
        expect(DEFAULT_RULES).toContain('### NPC Engine');
        expect(DEFAULT_RULES).toContain('### Name Generation');
        expect(DEFAULT_RULES).toContain('### Lore Handling');
        expect(DEFAULT_RULES).toContain('### Action Resolution');
        expect(DEFAULT_RULES).toContain('### Event Protocol');
        expect(DEFAULT_RULES).toContain('### World Pressures');
    });
});

// ─── Characterization tests: pin current buildPayload behaviour ────────────────

// ── Helper fixtures ────────────────────────────────────────────────────────────

function makeMsg(
    role: ChatMessage['role'],
    content: string,
    extras?: Partial<ChatMessage>
): ChatMessage {
    return { id: `msg-${Math.random()}`, role, content, timestamp: Date.now(), ...extras };
}

function makeLoreChunk(overrides: Partial<LoreChunk> & { category: LoreChunk['category'] }): LoreChunk {
    return {
        id: 'lc1',
        header: 'Test Header',
        content: 'Test content',
        tokens: 5,
        alwaysInclude: false,
        triggerKeywords: [],
        scanDepth: 3,
        category: overrides.category,
        linkedEntities: [],
        priority: 1,
        ...overrides,
    };
}

function makeNPC(overrides: Partial<NPCEntry>): NPCEntry {
    return {
        id: 'npc1',
        name: 'TestNPC',
        aliases: '',
        appearance: '',
        faction: '',
        storyRelevance: '',
        disposition: 'neutral',
        status: 'alive',
        goals: '',
        voice: '',
        personality: '',
        exampleOutput: '',
        affinity: 0,
        archived: false,
        ...overrides,
    };
}

function makeArchiveScene(sceneId: string, content: string): ArchiveScene {
    return { sceneId, content, tokens: Math.ceil(content.length / 4) };
}

function makeArchiveIndexEntry(sceneId: string, witnesses: string[]): ArchiveIndexEntry {
    return {
        sceneId,
        timestamp: Date.now(),
        keywords: [],
        npcsMentioned: [],
        witnesses,
        userSnippet: '',
    };
}

function makeTimelineEvent(overrides: Partial<TimelineEvent>): TimelineEvent {
    return {
        id: 'tl_0001',
        sceneId: '001',
        chapterId: 'CH01',
        subject: 'TestSubject',
        predicate: 'status',
        object: 'alive',
        summary: 'Test summary',
        importance: 5,
        source: 'manual',
        ...overrides,
    };
}

function makeDivergenceRegister(text: string): DivergenceRegister {
    return {
        entries: [
            {
                id: 'div1',
                chapterId: 'CH01',
                category: 'world_state',
                text,
                sceneRef: '001',
                npcIds: [],
                pinned: true,
                enabled: true,
                source: 'manual',
            },
        ],
        chapterToggles: {},
        categoryToggles: {},
        lastUpdatedSceneId: '001',
        lastUpdatedAt: Date.now(),
        version: 2,
    };
}

// ── Scenario 1: Minimal ────────────────────────────────────────────────────────
describe('buildPayload — scenario 1: minimal', () => {
    it('first message is system and contains stable preamble (rules text)', () => {
        const result = buildPayload(baseSettings(), baseContext(), [], 'Hello world');
        // Minimum: at least a stable system message + final user message.
        expect(result.messages.length).toBeGreaterThanOrEqual(2);
        expect(result.messages[0].role).toBe('system');
        // rules text is in the first system message
        expect(result.messages[0].content).toContain('ROLE: Dynamic-Realism GM.');
    });

    it('the final user message contains the GM REMINDER literal', () => {
        const result = buildPayload(baseSettings(), baseContext(), [], 'Hello world');
        const lastMsg = result.messages[result.messages.length - 1];
        expect(lastMsg.role).toBe('user');
        expect(typeof lastMsg.content === 'string' && lastMsg.content.includes('[GM REMINDER')).toBe(true);
    });

    it('the LAST message is the user message and contains the original user text', () => {
        const result = buildPayload(baseSettings(), baseContext(), [], 'Hello world');
        const last = result.messages[result.messages.length - 1];
        expect(last.role).toBe('user');
        // The final user message now includes the GM REMINDER and any volatile block folded in,
        // so we check it contains the original user text rather than being exactly equal to it.
        expect(typeof last.content === 'string' && last.content.includes('Hello world')).toBe(true);
    });

    it('message ordering: system first, user last (with GM REMINDER folded into final user message)', () => {
        const result = buildPayload(baseSettings(), baseContext(), [], 'Hello world');
        const msgs = result.messages;
        expect(msgs[0].role).toBe('system');
        // GM REMINDER is now folded into the final user message (not a standalone system message).
        const last = msgs[msgs.length - 1];
        expect(last.role).toBe('user');
        expect(typeof last.content === 'string' && last.content.includes('[GM REMINDER')).toBe(true);
        // No standalone system message should contain the GM REMINDER.
        const sysReminderMsg = msgs.find(
            m => m.role === 'system' && typeof m.content === 'string' && m.content.includes('[GM REMINDER')
        );
        expect(sysReminderMsg).toBeUndefined();
    });

    it('returns trace and debugSections when debugMode is true', () => {
        const result = buildPayload(baseSettings(), baseContext(), [], 'Hello world');
        expect(result.trace).toBeDefined();
        expect(result.debugSections).toBeDefined();
    });

    it('does NOT return trace/debugSections when debugMode is false', () => {
        const settings = { ...baseSettings(), debugMode: false } as unknown as AppSettings;
        const result = buildPayload(settings, baseContext(), [], 'Hello world');
        expect(result.trace).toBeUndefined();
        expect(result.debugSections).toBeUndefined();
    });
});

// ── Scenario 2: Full world context ────────────────────────────────────────────
describe('buildPayload — scenario 2: full world context', () => {
    const lore: LoreChunk[] = [
        makeLoreChunk({ id: 'lc_faction', category: 'faction', header: 'Iron Guild', content: 'A powerful trading faction.', tokens: 8 }),
        makeLoreChunk({ id: 'lc_loc', category: 'location', header: 'The Docks', content: 'Busy harbor district.', tokens: 7 }),
    ];
    const npcs: NPCEntry[] = [
        makeNPC({ id: 'npc_a', name: 'Aldric', aliases: '' }),
        makeNPC({ id: 'npc_b', name: 'Bella', aliases: '' }),
    ];
    const archive: ArchiveScene[] = [
        makeArchiveScene('001', 'The party fought goblins near the docks.'),
    ];
    const timeline: TimelineEvent[] = [
        makeTimelineEvent({ id: 'tl1', subject: 'Aldric', predicate: 'status', object: 'injured', summary: 'Aldric was injured in scene 001' }),
    ];
    const divReg = makeDivergenceRegister('The bridge was destroyed in scene 001.');
    const userMsg = 'Aldric and Bella are at the docks. What happens next?';

    it('world lore marker appears in assembled content', () => {
        const result = buildPayload(
            baseSettings(), baseContext(),
            [], userMsg,
            undefined, lore, npcs, archive,
            undefined, undefined, 'Some semantic fact',
            undefined, timeline, undefined, undefined, undefined, divReg
        );
        // worldContent is folded into the final user message (below the cache boundary).
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        expect(allContent).toContain('[WORLD LORE');
    });

    it('FACTIONS section appears when faction lore is provided', () => {
        const result = buildPayload(
            baseSettings(), baseContext(),
            [], userMsg,
            undefined, lore
        );
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        expect(allContent).toContain('[FACTIONS]');
    });

    it('LOCATIONS section appears when location lore is provided', () => {
        const result = buildPayload(
            baseSettings(), baseContext(),
            [], userMsg,
            undefined, lore
        );
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        expect(allContent).toContain('[LOCATIONS]');
    });

    it('archive recall marker appears when archiveRecall is provided', () => {
        const result = buildPayload(
            baseSettings(), baseContext(),
            [], userMsg,
            undefined, undefined, undefined, archive
        );
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        expect(allContent).toContain('[ARCHIVE RECALL');
    });

    it('active NPC context marker appears when matching NPCs are in ledger', () => {
        const result = buildPayload(
            baseSettings(), baseContext(),
            [], userMsg,
            undefined, undefined, npcs
        );
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        expect(allContent).toContain('[ACTIVE NPC CONTEXT]');
    });

    it('semantic fact text is present in assembled content', () => {
        const result = buildPayload(
            baseSettings(), baseContext(),
            [], userMsg,
            undefined, undefined, undefined, undefined,
            undefined, undefined, 'SEMANTIC FACT: the sky is red'
        );
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        expect(allContent).toContain('SEMANTIC FACT: the sky is red');
    });

    it('trace has included:true entries for RAG Lore and Active NPCs', () => {
        const result = buildPayload(
            baseSettings(), baseContext(),
            [], userMsg,
            undefined, lore, npcs
        );
        const traceSourcesIncluded = (result.trace ?? [])
            .filter(t => t.included)
            .map(t => t.source);
        expect(traceSourcesIncluded).toContain('RAG Lore');
        expect(traceSourcesIncluded).toContain('Active NPCs');
    });

    it('trace has included:true entry for Archive Recall when provided', () => {
        const result = buildPayload(
            baseSettings(), baseContext(),
            [], userMsg,
            undefined, undefined, undefined, archive
        );
        const traceSourcesIncluded = (result.trace ?? [])
            .filter(t => t.included)
            .map(t => t.source);
        expect(traceSourcesIncluded).toContain('Archive Recall');
    });
});

// ── Scenario 3: NPC tiered directive (WO-G core+extended) ─────────────────────
describe('buildPayload — scenario 3: NPC tiered directive', () => {
    const highNpc = makeNPC({
        id: 'npc_high',
        name: 'Zorath',
        drives: { coreWant: 'conquer the realm', sessionWant: 'recruit allies', sceneWant: 'intimidate the player' },
        behavioralTriggers: [{ keyword: 'sword', shift: 'becomes aggressive' }],
        hardBoundaries: ['never retreat', 'no mercy'],
        softBoundaries: ['avoids fire'],
        pressure: { ignored: 3, engaged: 1, lastDecayTurn: 0, history: [] },
    });
    const lowNpc = makeNPC({
        id: 'npc_low',
        name: 'Tara',
    });

    // userMessage mentions Zorath multiple times
    const userMsg = 'Zorath steps forward. Zorath raises his sword. What does Zorath say?';

    it('Active NPCs trace reason describes the tiered injection', () => {
        const result = buildPayload(
            baseSettings(), baseContext(),
            [], userMsg,
            undefined, undefined, [highNpc, lowNpc]
        );
        const npcTrace = (result.trace ?? []).find(t => t.source === 'Active NPCs' && t.included);
        expect(npcTrace).toBeDefined();
        expect(npcTrace!.reason).toContain('tiered');
    });

    it('NPC with drives surfaces a WANTS line (legacy drives fallback) in output', () => {
        const result = buildPayload(
            baseSettings(), baseContext(),
            [], userMsg,
            undefined, undefined, [highNpc, lowNpc]
        );
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        // highNpc has drives (not wants) → buildExtendedDirective emits WANTS:.
        expect(allContent).toContain('WANTS:');
    });

    it('NPC triggers surface as ON "keyword": in output', () => {
        const result = buildPayload(
            baseSettings(), baseContext(),
            [], userMsg,
            undefined, undefined, [highNpc, lowNpc]
        );
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        expect(allContent).toContain('ON "sword":');
    });

    it('NPC hard boundaries surface as WON\'T: in output', () => {
        const result = buildPayload(
            baseSettings(), baseContext(),
            [], userMsg,
            undefined, undefined, [highNpc, lowNpc]
        );
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        expect(allContent).toContain('WON\'T:');
    });

    it('NPC without drives does not emit a WANTS line', () => {
        const result = buildPayload(
            baseSettings(), baseContext(),
            [], userMsg,
            undefined, undefined, [highNpc, lowNpc]
        );
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        // lowNpc (Tara) has no drives and no wants — no WANTS line for her.
        // Only highNpc's WANTS line should be present.
        const wantsCount = (allContent.match(/WANTS:/g) ?? []).length;
        expect(wantsCount).toBe(1);
    });
});

// ── Scenario 4: Perceptual archive filter ─────────────────────────────────────
describe('buildPayload — scenario 4: perceptual archive filter', () => {
    const activeNpc = makeNPC({ id: 'active_npc', name: 'Oswin', archived: false });
    const archivedNpc = makeNPC({ id: 'archived_npc', name: 'OldGhost', archived: true });

    const witnessedScene = makeArchiveScene('001', 'Oswin saw the dragon fly over the tower.');
    const unwitnessedScene = makeArchiveScene('002', 'A secret meeting no NPC witnessed.');

    const archiveIndex: ArchiveIndexEntry[] = [
        makeArchiveIndexEntry('001', ['active_npc']),   // witnessed by active NPC
        makeArchiveIndexEntry('002', ['archived_npc']), // only witnessed by archived NPC
    ];

    it('trace shows perceptual filter removed unwitnessed scenes', () => {
        const result = buildPayload(
            baseSettings(), baseContext(),
            [], 'What do you recall?',
            undefined, undefined, [activeNpc, archivedNpc],
            [witnessedScene, unwitnessedScene],
            undefined, undefined, undefined, archiveIndex
        );
        const filterTrace = (result.trace ?? []).find(
            t => t.source === 'Archive Recall' && t.included === false && t.reason.includes('Perceptual filter removed')
        );
        expect(filterTrace).toBeDefined();
    });

    it('unwitnessed scene content is absent from assembled messages', () => {
        const result = buildPayload(
            baseSettings(), baseContext(),
            [], 'What do you recall?',
            undefined, undefined, [activeNpc, archivedNpc],
            [witnessedScene, unwitnessedScene],
            undefined, undefined, undefined, archiveIndex
        );
        const allContent = result.messages
            .map(m => (typeof m.content === 'string' ? m.content : ''))
            .join('\n');
        expect(allContent).not.toContain('A secret meeting no NPC witnessed.');
    });

    it('witnessed scene content IS present in assembled messages', () => {
        const result = buildPayload(
            baseSettings(), baseContext(),
            [], 'What do you recall?',
            undefined, undefined, [activeNpc, archivedNpc],
            [witnessedScene, unwitnessedScene],
            undefined, undefined, undefined, archiveIndex
        );
        const allContent = result.messages
            .map(m => (typeof m.content === 'string' ? m.content : ''))
            .join('\n');
        expect(allContent).toContain('Oswin saw the dragon fly over the tower.');
    });

    it('scene with NO witnesses (broadcast) is always included', () => {
        const broadcastScene = makeArchiveScene('003', 'The whole world heard the announcement.');
        const broadcastIdx = makeArchiveIndexEntry('003', []); // empty witnesses = broadcast
        const result = buildPayload(
            baseSettings(), baseContext(),
            [], 'What happened?',
            undefined, undefined, [activeNpc],
            [broadcastScene],
            undefined, undefined, undefined, [broadcastIdx]
        );
        const allContent = result.messages
            .map(m => (typeof m.content === 'string' ? m.content : ''))
            .join('\n');
        expect(allContent).toContain('The whole world heard the announcement.');
    });
});

// ── Scenario 5: World-budget trim ─────────────────────────────────────────────
describe('buildPayload — scenario 5: world-budget trim', () => {
    it('trace has included:false entry with reason containing "Exceeds World budget" when budget is tiny', () => {
        const smallSettings = {
            ...baseSettings(),
            contextLimit: 500,
        } as unknown as AppSettings;

        // Build several world blocks to overflow the tiny budget
        const bigLore: LoreChunk[] = [
            makeLoreChunk({
                id: 'lc1', category: 'faction', header: 'Faction One',
                content: 'A'.repeat(300), tokens: 100,
            }),
            makeLoreChunk({
                id: 'lc2', category: 'location', header: 'Location Two',
                content: 'B'.repeat(300), tokens: 100,
            }),
            makeLoreChunk({
                id: 'lc3', category: 'event', header: 'Big Event',
                content: 'C'.repeat(300), tokens: 100,
            }),
        ];

        const archive: ArchiveScene[] = [
            makeArchiveScene('001', 'D'.repeat(400)),
        ];

        const result = buildPayload(
            smallSettings, baseContext(),
            [], 'Hello',
            undefined, bigLore, undefined, archive
        );

        const droppedTrace = (result.trace ?? []).find(
            t => !t.included && typeof t.reason === 'string' && t.reason.includes('Exceeds World budget')
        );
        expect(droppedTrace).toBeDefined();
    });
});

// ── Scenario 6: History fitting + ephemeral cleanup ───────────────────────────
describe('buildPayload — scenario 6: history fitting and ephemeral cleanup', () => {
    it('ephemeral non-last tool message content is blanked to a single space', () => {
        // The code only blanks ephemeral tool messages that are NOT the lastToolIdx.
        // So we need two tool messages: first ephemeral (non-last), second non-ephemeral (last).
        const toolCallId1 = 'tcid_1a';
        const toolCallId2 = 'tcid_1b';
        const history: ChatMessage[] = [
            makeMsg('user', 'Turn 1'),
            makeMsg('assistant', 'Asst A', {
                tool_calls: [{ id: toolCallId1, type: 'function', function: { name: 'roll_dice', arguments: '{}' } }],
            }),
            // ephemeral tool result — this is NOT the last tool message
            makeMsg('tool', 'EPHEMERAL TOOL RESULT CONTENT', {
                tool_call_id: toolCallId1,
                name: 'roll_dice',
                ephemeral: true,
            }),
            makeMsg('assistant', 'Asst B', {
                tool_calls: [{ id: toolCallId2, type: 'function', function: { name: 'roll_dice', arguments: '{}' } }],
            }),
            // Non-ephemeral last tool message
            makeMsg('tool', 'LAST TOOL RESULT', {
                tool_call_id: toolCallId2,
                name: 'roll_dice',
                ephemeral: false,
            }),
            makeMsg('assistant', 'Final assistant'),
            makeMsg('user', 'Last user'),
        ];

        const result = buildPayload(baseSettings(), baseContext(), history, 'Current message');
        const allMsgs = result.messages;
        const firstToolMsg = allMsgs.find(
            m => m.role === 'tool' && m.tool_call_id === toolCallId1
        );
        // The first (ephemeral, non-last) tool message should be blanked to ' '
        if (firstToolMsg) {
            expect(firstToolMsg.content).toBe(' ');
        }
        // The original ephemeral content must not appear verbatim
        const allContent = allMsgs.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n');
        expect(allContent).not.toContain('EPHEMERAL TOOL RESULT CONTENT');
    });

    it('Ephemeral Cleanup trace entry appears when ephemeral non-last tool messages are blanked', () => {
        // Need TWO tool messages so the ephemeral one is not the last
        const toolCallId1 = 'tcid_2a';
        const toolCallId2 = 'tcid_2b';
        const history: ChatMessage[] = [
            makeMsg('user', 'Turn 1'),
            makeMsg('assistant', 'Asst A', {
                tool_calls: [{ id: toolCallId1, type: 'function', function: { name: 'roll_dice', arguments: '{}' } }],
            }),
            makeMsg('tool', 'BIG EPHEMERAL DATA HERE XXXX', {
                tool_call_id: toolCallId1,
                name: 'roll_dice',
                ephemeral: true,
            }),
            makeMsg('assistant', 'Asst B', {
                tool_calls: [{ id: toolCallId2, type: 'function', function: { name: 'roll_dice', arguments: '{}' } }],
            }),
            makeMsg('tool', 'LAST TOOL RESULT', {
                tool_call_id: toolCallId2,
                name: 'roll_dice',
                ephemeral: false,
            }),
            makeMsg('assistant', 'Final assistant'),
            makeMsg('user', 'Turn 2'),
        ];

        const result = buildPayload(baseSettings(), baseContext(), history, 'Turn 3');
        const ephemeralTrace = (result.trace ?? []).find(t => t.source === 'Ephemeral Cleanup');
        expect(ephemeralTrace).toBeDefined();
    });

    it('orphaned leading tool messages are stripped from fitted history', () => {
        const history: ChatMessage[] = [
            // Starts with a tool message (orphaned — no assistant with tool_calls before it in fitted window)
            makeMsg('tool', 'Orphaned tool result', { tool_call_id: 'orphan_tc', name: 'roll_dice' }),
            makeMsg('user', 'Next user message'),
            makeMsg('assistant', 'Assistant reply'),
        ];

        const result = buildPayload(baseSettings(), baseContext(), history, 'Current message');
        // The overall first message in messages is system; confirm no tool at position 0 of history slice
        const firstFittedRole = result.messages.find(
            m => m.role !== 'system'
        )?.role;
        // After orphan stripping, the first non-system message should NOT be 'tool'
        expect(firstFittedRole).not.toBe('tool');
    });
});

// ── Scenario 7: Scene-note depth splice ───────────────────────────────────────
describe('buildPayload — scenario 7: scene note depth splice', () => {
    it('scene note is spliced into history and trace has Scene Note (Depth) entry', () => {
        const ctx = {
            ...baseContext(),
            sceneNoteActive: true,
            sceneNote: 'Remember: Aldric is hiding in the shadows.',
            sceneNoteDepth: 2,
        } as GameContext;

        const history: ChatMessage[] = [
            makeMsg('user', 'Turn 1'),
            makeMsg('assistant', 'GM reply 1'),
            makeMsg('user', 'Turn 2'),
            makeMsg('assistant', 'GM reply 2'),
        ];

        const result = buildPayload(baseSettings(), ctx, history, 'What happens next?');

        // A system message with [SCENE NOTE should be in messages
        const noteMsg = result.messages.find(
            m => m.role === 'system' && typeof m.content === 'string' && m.content.includes('[SCENE NOTE')
        );
        expect(noteMsg).toBeDefined();

        // Trace entry for Scene Note (Depth) should be present
        const noteTrace = (result.trace ?? []).find(t => t.source === 'Scene Note (Depth)');
        expect(noteTrace).toBeDefined();
        expect(noteTrace!.included).toBe(true);
    });

    it('scene note falls back to end of history block when no history is provided', () => {
        const ctx = {
            ...baseContext(),
            sceneNoteActive: true,
            sceneNote: 'The tavern is on fire.',
            sceneNoteDepth: 3,
        } as GameContext;

        const result = buildPayload(baseSettings(), ctx, [], 'What do I see?');

        // With empty history, fallback is used
        const fallbackTrace = (result.trace ?? []).find(t => t.source === 'Scene Note (Fallback)');
        expect(fallbackTrace).toBeDefined();
        expect(fallbackTrace!.included).toBe(true);

        // The note message still appears
        const noteMsg = result.messages.find(
            m => m.role === 'system' && typeof m.content === 'string' && m.content.includes('[SCENE NOTE')
        );
        expect(noteMsg).toBeDefined();
    });
});

// ── Scenario 8: Reasoning-model + tool-mode ───────────────────────────────────
describe('buildPayload — scenario 8: reasoning model and tool mode', () => {
    it('thinking-block reminder text appears in stable content when model matches deepseek-r pattern', () => {
        const reasoningSettings = {
            ...baseSettings(),
            activePresetId: 'preset_reasoning',
            providers: [{ id: 'prov_reasoning', modelName: 'deepseek-r1-distill-llama-70b' }],
            presets: [
                {
                    id: 'preset_reasoning',
                    storyAIProviderId: 'prov_reasoning',
                },
            ],
        } as unknown as AppSettings;

        const result = buildPayload(reasoningSettings, baseContext(), [], 'Hello');
        const firstSystem = result.messages[0];
        expect(typeof firstSystem.content).toBe('string');
        expect(firstSystem.content as string).toContain('thinking');
    });

    it('thinking-block reminder appears for qwq model name pattern', () => {
        const reasoningSettings = {
            ...baseSettings(),
            activePresetId: 'preset_qwq',
            providers: [{ id: 'prov_qwq', modelName: 'QwQ-32B-Preview' }],
            presets: [
                {
                    id: 'preset_qwq',
                    storyAIProviderId: 'prov_qwq',
                },
            ],
        } as unknown as AppSettings;

        const result = buildPayload(reasoningSettings, baseContext(), [], 'Hello');
        const firstSystem = result.messages[0];
        expect(firstSystem.content as string).toContain('thinking');
    });

    it('tool-mode swaps ACTION RESOLUTION to use roll_dice tool wording when diceFairnessActive is false', () => {
        const ctx = {
            ...baseContext(),
            diceFairnessActive: false,
            rulesRaw: DEFAULT_RULES,
        } as GameContext;

        const result = buildPayload(baseSettings(), ctx, [], 'I attack the guard');
        const firstSystem = result.messages[0];
        expect(firstSystem.content as string).toContain('roll_dice');
    });

    it('default (pool) mode does NOT inject roll_dice tool wording when diceFairnessActive is true', () => {
        const ctx = {
            ...baseContext(),
            diceFairnessActive: true,
            rulesRaw: DEFAULT_RULES,
        } as GameContext;

        const result = buildPayload(baseSettings(), ctx, [], 'I attack the guard');
        const firstSystem = result.messages[0];
        // The original ACTION RESOLUTION section should NOT contain the CALL the `roll_dice` tool phrasing
        // (that's the tool-mode specific text)
        expect(firstSystem.content as string).not.toContain('CALL the `roll_dice` tool BEFORE narrating');
    });
});

// ── Scenario 9: Smart bookkeeping vs legacy ───────────────────────────────────
describe('buildPayload — scenario 9: smart bookkeeping vs legacy', () => {
    it('smart bookkeeping: [CHARACTER] block appears when smartBookkeepingActive and characterProfileData has a name', () => {
        const ctx = {
            ...baseContext(),
            smartBookkeepingActive: true,
            characterProfileData: {
                name: 'Gareth',
                race: 'Human',
                class: 'Fighter',
                level: 5,
                hp: { current: 40, max: 50 },
                stats: {},
                skills: [],
                abilities: [],
                traits: [],
                notes: '',
            },
            inventoryItems: [],
        } as unknown as GameContext;

        const result = buildPayload(baseSettings(), ctx, [], 'What do I have?');
        // volatile blocks are folded into the final user message.
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        expect(allContent).toContain('[CHARACTER]');
    });

    it('smart bookkeeping: [INVENTORY] block appears when inventoryCategories provided and items exist', () => {
        const ctx = {
            ...baseContext(),
            smartBookkeepingActive: true,
            characterProfileData: {
                name: 'Gareth',
                race: 'Human',
                class: 'Fighter',
                level: 5,
                hp: { current: 40, max: 50 },
                stats: {},
                skills: [],
                abilities: [],
                traits: [],
                notes: '',
            },
            inventoryItems: [
                {
                    id: 'item1',
                    name: 'Iron Sword',
                    qty: 1,
                    category: 'weapon' as const,
                    keywords: ['sword'],
                    equipped: true,
                    lastUsedScene: '001',
                    importance: 7,
                    notes: '',
                },
            ],
        } as unknown as GameContext;

        const result = buildPayload(
            baseSettings(), ctx,
            [], 'What weapons do I have?',
            undefined, undefined, undefined, undefined,
            undefined, undefined, undefined, undefined, undefined,
            ['weapon', 'equipped']
        );
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        expect(allContent).toContain('[INVENTORY]');
    });

    it('smart bookkeeping: [PROFILE] block appears when profileFields provided', () => {
        const ctx = {
            ...baseContext(),
            smartBookkeepingActive: true,
            characterProfileData: {
                name: 'Gareth',
                race: 'Human',
                class: 'Fighter',
                level: 5,
                hp: { current: 40, max: 50 },
                stats: { str: 16 },
                skills: ['Athletics'],
                abilities: [],
                traits: [],
                notes: 'Veteran soldier',
            },
            inventoryItems: [],
        } as unknown as GameContext;

        const result = buildPayload(
            baseSettings(), ctx,
            [], 'What are my stats?',
            undefined, undefined, undefined, undefined,
            undefined, undefined, undefined, undefined, undefined,
            undefined, ['name', 'class', 'level']
        );
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        expect(allContent).toContain('[PROFILE]');
    });

    it('legacy: [CHARACTER PROFILE block appears with staleness tag when characterProfileActive and no smartBookkeeping', () => {
        const ctx = {
            ...baseContext(),
            smartBookkeepingActive: false,
            characterProfileActive: true,
            characterProfile: {
                identity: { name: 'Gareth', class: 'Fighter', level: 5 },
                activeTraits: [{
                    id: 't1', subject: 'Gareth', category: 'party_facts', text: 'A seasoned fighter',
                    importance: 7, eventTags: ['other'], sceneEstablished: '', superseded: false, source: 'seed',
                }],
            },
            characterProfileLastScene: '003',
        } as unknown as GameContext;

        const result = buildPayload(baseSettings(), ctx, [], 'Who am I?');
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        expect(allContent).toContain('[CHARACTER PROFILE');
        // should include the last scene reference
        expect(allContent).toContain('003');
    });

    it('legacy: structured profile injects [CHARACTER PROFILE] when characterProfileActive and traits exist', () => {
        const ctx = {
            ...baseContext(),
            smartBookkeepingActive: false,
            characterProfileActive: true,
            characterProfile: {
                identity: { name: 'Gareth', class: 'Fighter', level: 5 },
                activeTraits: [{
                    id: 't1', subject: 'Gareth', category: 'party_facts', text: 'A seasoned fighter',
                    importance: 7, eventTags: ['other'], sceneEstablished: '', superseded: false, source: 'seed',
                }],
            },
            characterProfileLastScene: 'Never',
        } as unknown as GameContext;

        const result = buildPayload(baseSettings(), ctx, [], 'Who am I?');
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        expect(allContent).toContain('[CHARACTER PROFILE]');
        expect(allContent).toContain('Gareth');
    });
});

// ── Scenario 10: cache_control: ephemeral markers ──────────────────────────────
describe('buildPayload — cache_control: ephemeral markers', () => {
    it('stable content system message has cache_control: ephemeral', () => {
        const result = buildPayload(baseSettings(), baseContext(), [], 'Hello world');
        const stableMsg = result.messages.find(
            m => m.role === 'system' && typeof m.content === 'string' && m.content.includes('ROLE: Dynamic-Realism GM.')
        );
        expect(stableMsg).toBeDefined();
        expect((stableMsg as any).cache_control).toEqual({ type: 'ephemeral' });
    });

    it('divergence content system message has cache_control: ephemeral when divergence is present', () => {
        const divReg = makeDivergenceRegister('The bridge was destroyed in scene 001.');
        const result = buildPayload(
            baseSettings(), baseContext(),
            [], 'What happened?',
            undefined, undefined, undefined, undefined,
            undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, divReg
        );
        const divMsg = result.messages.find(
            m => m.role === 'system' && typeof m.content === 'string' && m.content.includes('The bridge was destroyed')
        );
        expect(divMsg).toBeDefined();
        expect((divMsg as any).cache_control).toEqual({ type: 'ephemeral' });
    });

    it('world/volatile content is folded into the final user message (no standalone world system message)', () => {
        const lore: LoreChunk[] = [
            makeLoreChunk({ id: 'lc1', category: 'faction', header: 'Guild', content: 'A guild.', tokens: 5 }),
        ];
        const result = buildPayload(
            baseSettings(), baseContext(),
            [], 'Hello',
            undefined, lore
        );
        // worldContent is now in the final user message, not a system message.
        const worldSysMsg = result.messages.find(
            m => m.role === 'system' && typeof m.content === 'string' && m.content.includes('[WORLD LORE')
        );
        expect(worldSysMsg).toBeUndefined();
        // It should appear in the final user message instead.
        const lastMsg = result.messages[result.messages.length - 1];
        expect(lastMsg.role).toBe('user');
        expect(typeof lastMsg.content === 'string' && lastMsg.content.includes('[WORLD LORE')).toBe(true);
    });

    it('GM REMINDER is folded into the final user message (no standalone GM REMINDER system message)', () => {
        const result = buildPayload(baseSettings(), baseContext(), [], 'Hello');
        // No system message should carry the GM REMINDER.
        const sysReminderMsg = result.messages.find(
            m => m.role === 'system' && typeof m.content === 'string' && m.content.includes('[GM REMINDER')
        );
        expect(sysReminderMsg).toBeUndefined();
        // It should be in the final user message.
        const lastMsg = result.messages[result.messages.length - 1];
        expect(lastMsg.role).toBe('user');
        expect(typeof lastMsg.content === 'string' && lastMsg.content.includes('[GM REMINDER')).toBe(true);
    });

    it('final user message does NOT have cache_control (cache boundary is on last history message)', () => {
        const result = buildPayload(baseSettings(), baseContext(), [], 'Hello');
        const lastMsg = result.messages[result.messages.length - 1];
        expect(lastMsg.role).toBe('user');
        expect((lastMsg as any).cache_control).toBeUndefined();
    });

    it('history system messages (scene notes) do NOT have cache_control', () => {
        const ctx = {
            ...baseContext(),
            sceneNoteActive: true,
            sceneNote: 'The shadows grow longer.',
            sceneNoteDepth: 1,
        } as GameContext;
        const history: ChatMessage[] = [
            makeMsg('user', 'Turn 1'),
            makeMsg('assistant', 'GM reply'),
        ];
        const result = buildPayload(baseSettings(), ctx, history, 'What next?');
        const sceneNoteMsg = result.messages.find(
            m => m.role === 'system' && typeof m.content === 'string' && m.content.includes('[SCENE NOTE')
        );
        expect(sceneNoteMsg).toBeDefined();
        expect((sceneNoteMsg as any).cache_control).toBeUndefined();
    });
});

// ── Scenario 11: Recent Scene Events rendering ──────────────────────────────
describe('buildPayload — Scenario 11: Recent Scene Events rendering', () => {
    it('Recent Scene Events block is absent when there are no events in the recent scenes', () => {
        const archive = [makeArchiveScene('001', 'Scene content')];
        const archiveIndex = [makeArchiveIndexEntry('001', [])];
        const result = buildPayload(
            baseSettings(), baseContext(),
            [], 'Hello',
            undefined, undefined, undefined, archive,
            undefined, undefined, undefined, archiveIndex
        );
        // worldContent is folded into the final user message; check all content.
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        expect(allContent).not.toContain('Recent Scene Events');
    });

    it('Recent Scene Events block is present when recent scenes have events', () => {
        const archive = [makeArchiveScene('001', 'Scene content')];
        const archiveIndex: ArchiveIndexEntry[] = [{
            sceneId: '001',
            timestamp: Date.now(),
            keywords: [],
            npcsMentioned: [],
            witnesses: [],
            userSnippet: '',
            events: [
                { eventType: 'combat', importance: 5, text: 'Fought goblins', cause: 'ambush', result: 'won' }
            ]
        }];
        const result = buildPayload(
            baseSettings(), baseContext(),
            [], 'Hello',
            undefined, undefined, undefined, archive,
            undefined, undefined, undefined, archiveIndex
        );
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        expect(allContent).toContain('[combat] Fought goblins (ambush → won)');
    });

    it('Recent Scene Events are sorted by importance descending in output', () => {
        const archive = [makeArchiveScene('001', 'Scene content')];
        const archiveIndex: ArchiveIndexEntry[] = [{
            sceneId: '001',
            timestamp: Date.now(),
            keywords: [],
            npcsMentioned: [],
            witnesses: [],
            userSnippet: '',
            events: [
                { eventType: 'combat', importance: 3, text: 'Low importance event' },
                { eventType: 'discovery', importance: 8, text: 'High importance event' },
                { eventType: 'item_acquired', importance: 5, text: 'Medium importance event' }
            ]
        }];
        const result = buildPayload(
            baseSettings(), baseContext(),
            [], 'Hello',
            undefined, undefined, undefined, archive,
            undefined, undefined, undefined, archiveIndex
        );
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        const firstIdx = allContent.indexOf('High importance event');
        const secondIdx = allContent.indexOf('Medium importance event');
        const thirdIdx = allContent.indexOf('Low importance event');
        expect(firstIdx).toBeLessThan(secondIdx);
        expect(secondIdx).toBeLessThan(thirdIdx);
    });

    it('correctly renders cause/result combinations (cause only, result only, both, none)', () => {
        const archive = [makeArchiveScene('001', 'Scene content')];
        const archiveIndex: ArchiveIndexEntry[] = [{
            sceneId: '001',
            timestamp: Date.now(),
            keywords: [],
            npcsMentioned: [],
            witnesses: [],
            userSnippet: '',
            events: [
                { eventType: 'combat', importance: 8, text: 'Both present', cause: 'ambush', result: 'won' },
                { eventType: 'combat', importance: 7, text: 'Cause only', cause: 'ambush' },
                { eventType: 'combat', importance: 6, text: 'Result only', result: 'won' },
                { eventType: 'combat', importance: 5, text: 'Neither' }
            ]
        }];
        const result = buildPayload(
            baseSettings(), baseContext(),
            [], 'Hello',
            undefined, undefined, undefined, archive,
            undefined, undefined, undefined, archiveIndex
        );
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');
        expect(allContent).toContain('[combat] Both present (ambush → won)');
        expect(allContent).toContain('[combat] Cause only (cause: ambush)');
        expect(allContent).toContain('[combat] Result only (result: won)');
        expect(allContent).toContain('[combat] Neither');
        expect(allContent).not.toContain('importance:');
    });

    it('respects token budget by dropping lowest-importance events', () => {
        const archive = [makeArchiveScene('001', 'Scene content')];
        const events = Array.from({ length: 10 }, (_, i) => ({
            eventType: 'combat' as const,
            importance: i + 1, // 1 to 10
            text: 'Long event description '.repeat(20) + ` index ${i}` // ~40 tokens each
        }));
        const archiveIndex: ArchiveIndexEntry[] = [{
            sceneId: '001',
            timestamp: Date.now(),
            keywords: [],
            npcsMentioned: [],
            witnesses: [],
            userSnippet: '',
            events
        }];
        const result = buildPayload(
            baseSettings(), baseContext(),
            [], 'Hello',
            undefined, undefined, undefined, archive,
            undefined, undefined, undefined, archiveIndex
        );
        const allContent = result.messages
            .map(m => m.content as string)
            .join('\n');

        expect(allContent).toContain('index 9');
        expect(allContent).toContain('index 8');
        expect(allContent).not.toContain('index 0');
    });
});

// ── Scenario 12: volatile notebook budget (regression — dead budget bug) ────────
describe('buildPayload — volatile notebook budget', () => {
    it('trims an oversized notebook so the volatile block respects its budget', () => {
        // budgetMap.volatile = floor((limit - rulesBudget) * 0.10). With a small limit the
        // notebook (the only unbounded volatile source) must be trimmed, not emitted wholesale.
        const smallSettings = { ...baseSettings(), contextLimit: 600 } as unknown as AppSettings;
        const ctx = baseContext();
        ctx.notebookActive = true;
        ctx.notebook = Array.from({ length: 50 }, (_, i) => ({
            id: `n${i}`,
            text: `Notebook entry number ${i} with some filler words to consume tokens here.`,
            timestamp: 1_000 + i,
        }));

        const result = buildPayload(smallSettings, ctx, [], 'Hello');

        // [SCENE NOTEBOOK] is part of volatileContent, folded into the final user message.
        const lastMsg = result.messages[result.messages.length - 1];
        const notebookContent = lastMsg.role === 'user' && typeof lastMsg.content === 'string' && lastMsg.content.includes('[SCENE NOTEBOOK')
            ? lastMsg.content : null;
        // A trim trace must be recorded proving the budget was enforced.
        const trimTrace = (result.trace ?? []).find(
            t => t.source === 'Scene Notebook' && !t.included && typeof t.reason === 'string' && t.reason.includes('Trimmed')
        );
        expect(trimTrace).toBeDefined();
        // The newest entries are kept; the oldest are dropped.
        if (notebookContent) {
            expect(notebookContent).toContain('entry number 49');
            expect(notebookContent).not.toContain('entry number 0 ');
        }
    });

    it('emits the full notebook unchanged when it fits the budget (characterization)', () => {
        const ctx = baseContext();
        ctx.notebookActive = true;
        ctx.notebook = [
            { id: 'n1', text: 'A short note.', timestamp: 2 },
            { id: 'n2', text: 'Another short note.', timestamp: 1 },
        ];
        const result = buildPayload(baseSettings(), ctx, [], 'Hello');
        // [SCENE NOTEBOOK] is part of volatileContent, folded into the final user message.
        const lastMsg = result.messages[result.messages.length - 1];
        expect(lastMsg.role).toBe('user');
        expect(typeof lastMsg.content === 'string' && lastMsg.content.includes('[SCENE NOTEBOOK')).toBe(true);
        expect(lastMsg.content as string).toContain('A short note.');
        expect(lastMsg.content as string).toContain('Another short note.');
        // No trim trace when everything fits.
        const trimTrace = (result.trace ?? []).find(
            t => t.source === 'Scene Notebook' && !t.included
        );
        expect(trimTrace).toBeUndefined();
    });
});

// ── Scenario 13: divergence reserved in world budget (regression) ───────────────
describe('buildPayload — divergence reserved in world budget', () => {
    it('drops more world blocks when divergence consumes part of the world budget', () => {
        const smallSettings = { ...baseSettings(), contextLimit: 700 } as unknown as AppSettings;
        const lore: LoreChunk[] = [
            makeLoreChunk({ id: 'lc1', category: 'faction', header: 'Faction One', content: 'A'.repeat(300), tokens: 60 }),
            makeLoreChunk({ id: 'lc2', category: 'location', header: 'Location Two', content: 'B'.repeat(300), tokens: 60 }),
        ];

        // A large divergence register that eats into the world allocation.
        const bigDiv = makeDivergenceRegister('The capital fell. '.repeat(80));

        const withDiv = buildPayload(
            smallSettings, baseContext(), [], 'Hello',
            undefined, lore, undefined, undefined,
            undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, bigDiv
        );
        const withoutDiv = buildPayload(
            smallSettings, baseContext(), [], 'Hello',
            undefined, lore
        );

        const droppedWith = (withDiv.trace ?? []).filter(
            t => !t.included && typeof t.reason === 'string' && t.reason.includes('World budget')
        ).length;
        const droppedWithout = (withoutDiv.trace ?? []).filter(
            t => !t.included && typeof t.reason === 'string' && t.reason.includes('World budget')
        ).length;

        // Reserving divergence tokens means at least as many world blocks are dropped as without it.
        expect(droppedWith).toBeGreaterThanOrEqual(droppedWithout);
        // And the drop reason now mentions the divergence reserve.
        const reserveTrace = (withDiv.trace ?? []).find(
            t => !t.included && typeof t.reason === 'string' && t.reason.includes('divergence reserve')
        );
        expect(reserveTrace).toBeDefined();
    });
});