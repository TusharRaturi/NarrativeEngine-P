import { describe, it, expect } from 'vitest';
import { parseCombinedSealOutput } from '../archive/divergenceExtractor';

function makeValidSealJson(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        summary: {
            title: 'Test Chapter',
            summary: 'A test summary.',
            keywords: ['test'],
            npcs: ['Aldric'],
            majorEvents: ['Something happened'],
            unresolvedThreads: [],
            tone: 'mixed',
            themes: ['test'],
        },
        divergences: {
            locations: [],
            npc_events: [],
            promises_debts: [],
            world_state: [],
            party_facts: [],
            rules_lore: [],
            misc: [],
        },
        sceneEvents: {},
        ...overrides,
    });
}

describe('parseCombinedSealOutput — resolvedThreads', () => {
    it('parses valid resolvedThreads and exact-matches against openThreads', () => {
        const json = makeValidSealJson({
            resolvedThreads: ['The missing heir', 'The cursed amulet'],
        });
        const result = parseCombinedSealOutput(json, 'ch01', ['001'], [], ['The missing heir', 'The cursed amulet', 'An open thread']);
        expect(result.resolvedThreads).toEqual(['The missing heir', 'The cursed amulet']);
    });

    it('drops strings not in openThreads', () => {
        const json = makeValidSealJson({
            resolvedThreads: ['The missing heir', 'Invented by LLM'],
        });
        const result = parseCombinedSealOutput(json, 'ch01', ['001'], [], ['The missing heir']);
        expect(result.resolvedThreads).toEqual(['The missing heir']);
    });

    it('ignores non-array junk without error', () => {
        const json = makeValidSealJson({
            resolvedThreads: 'not an array',
        });
        const result = parseCombinedSealOutput(json, 'ch01', ['001'], [], ['The missing heir']);
        expect(result.resolvedThreads).toBeUndefined();
        expect(result.divergenceParseError).toBeUndefined();
    });

    it('returns undefined when key is absent', () => {
        const json = makeValidSealJson();
        const result = parseCombinedSealOutput(json, 'ch01', ['001'], []);
        expect(result.resolvedThreads).toBeUndefined();
    });

    it('filters out non-string entries and trims', () => {
        const json = makeValidSealJson({
            resolvedThreads: ['  The missing heir  ', 42, '', null],
        });
        const result = parseCombinedSealOutput(json, 'ch01', ['001'], [], ['The missing heir']);
        expect(result.resolvedThreads).toEqual(['The missing heir']);
    });

    it('when openThreads is undefined, keeps all valid strings', () => {
        const json = makeValidSealJson({
            resolvedThreads: ['The missing heir', 'Something else'],
        });
        const result = parseCombinedSealOutput(json, 'ch01', ['001'], [], undefined);
        expect(result.resolvedThreads).toEqual(['The missing heir', 'Something else']);
    });
});

describe('parseCombinedSealOutput — existing seal parse still works', () => {
    it('parses summary and divergences as before', () => {
        const json = makeValidSealJson();
        const result = parseCombinedSealOutput(json, 'ch01', ['001'], []);
        expect(result.summary).not.toBeNull();
        expect(result.summary!.title).toBe('Test Chapter');
        expect(result.divergences).toEqual([]);
        expect(result.divergenceParseError).toBeUndefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────
// WO2 — Extraction: subjectToken + inverted knownBy default
// ─────────────────────────────────────────────────────────────────────────

const WO2_LEDGER = [
    { id: 'npc_7', name: 'Aldric', aliases: '' },
    { id: 'npc_42', name: 'Grak', aliases: 'The Orc' },
];
const WO2_SCENES = ['001', '002', '003'];
const WO2_INDEX = [
    { sceneId: '002', npcsWitnessed: ['npc_7'] },
];

function wo2Summary() {
    return {
        title: 'T', summary: 's', keywords: [], npcs: [], majorEvents: [],
        unresolvedThreads: [], tone: 'mixed', themes: [],
    };
}

describe('parseCombinedSealOutput — WO2 subjectToken', () => {
    it('normalizes a CamelCase subjectToken to lowercase snake_case', () => {
        const json = JSON.stringify({
            summary: wo2Summary(),
            divergences: {
                locations: [],
                npc_events: [{
                    text: 'Aldric bowed', sceneRef: '002', npcIds: ['npc_7'],
                    unrecognizedNpcNames: [], subjectToken: 'Aldric.Identity',
                }],
                promises_debts: [], world_state: [], party_facts: [], rules_lore: [], misc: [],
            },
        });
        const result = parseCombinedSealOutput(json, 'ch01', WO2_SCENES, WO2_LEDGER, undefined, WO2_INDEX);
        const e = result.divergences.find(d => d.text === 'Aldric bowed');
        expect(e).toBeDefined();
        expect(e!.subjectToken).toBe('aldric.identity');
    });

    it('leaves subjectToken undefined when missing', () => {
        const json = JSON.stringify({
            summary: wo2Summary(),
            divergences: {
                locations: [], npc_events: [{
                    text: 'Aldric bowed', sceneRef: '002', npcIds: ['npc_7'], unrecognizedNpcNames: [],
                }],
                promises_debts: [], world_state: [], party_facts: [], rules_lore: [], misc: [],
            },
        });
        const result = parseCombinedSealOutput(json, 'ch01', WO2_SCENES, WO2_LEDGER, undefined, WO2_INDEX);
        const e = result.divergences.find(d => d.text === 'Aldric bowed');
        expect(e!.subjectToken).toBeUndefined();
    });

    it('leaves subjectToken undefined for malformed/whitespace token, no throw', () => {
        const json = JSON.stringify({
            summary: wo2Summary(),
            divergences: {
                locations: [], npc_events: [{
                    text: 'Aldric bowed', sceneRef: '002', npcIds: ['npc_7'],
                    unrecognizedNpcNames: [], subjectToken: '   ',
                }],
                promises_debts: [], world_state: [], party_facts: [], rules_lore: [], misc: [],
            },
        });
        const result = parseCombinedSealOutput(json, 'ch01', WO2_SCENES, WO2_LEDGER, undefined, WO2_INDEX);
        const e = result.divergences.find(d => d.text === 'Aldric bowed');
        expect(e!.subjectToken).toBeUndefined();
    });
});

describe('parseCombinedSealOutput — WO2 inverted knownBy default', () => {
    it('seeds knownBy from scene witnesses for a party_facts fact when LLM omitted knownBy', () => {
        const json = JSON.stringify({
            summary: wo2Summary(),
            divergences: {
                locations: [],
                npc_events: [],
                promises_debts: [],
                world_state: [],
                party_facts: [{
                    text: 'Player is Alex Chen', sceneRef: '002', npcIds: [], unrecognizedNpcNames: [],
                }],
                rules_lore: [], misc: [],
            },
        });
        const result = parseCombinedSealOutput(json, 'ch01', WO2_SCENES, WO2_LEDGER, undefined, WO2_INDEX);
        const e = result.divergences.find(d => d.text === 'Player is Alex Chen');
        expect(e).toBeDefined();
        expect(e!.knownBy).toEqual(['npc:npc_7']);
    });

    it('keeps knownBy undefined for a rules_lore fact even with witnesses present', () => {
        const json = JSON.stringify({
            summary: wo2Summary(),
            divergences: {
                locations: [],
                npc_events: [], promises_debts: [], world_state: [], party_facts: [],
                rules_lore: [{
                    text: 'Magic requires a focus', sceneRef: '002', npcIds: [], unrecognizedNpcNames: [],
                }],
                misc: [],
            },
        });
        const result = parseCombinedSealOutput(json, 'ch01', WO2_SCENES, WO2_LEDGER, undefined, WO2_INDEX);
        const e = result.divergences.find(d => d.text === 'Magic requires a focus');
        expect(e!.knownBy).toBeUndefined();
    });

    it('keeps knownBy undefined for a locations fact', () => {
        const json = JSON.stringify({
            summary: wo2Summary(),
            divergences: {
                locations: [{
                    text: 'Eastern gate fell', sceneRef: '002', npcIds: [], unrecognizedNpcNames: [],
                    knownBy: ['npc:npc_7'],
                }],
                npc_events: [], promises_debts: [], world_state: [], party_facts: [], rules_lore: [], misc: [],
            },
        });
        const result = parseCombinedSealOutput(json, 'ch01', WO2_SCENES, WO2_LEDGER, undefined, WO2_INDEX);
        const e = result.divergences.find(d => d.text === 'Eastern gate fell');
        expect(e!.knownBy).toBeUndefined();
    });

    it('resolves "npc:npc_42" token-form knownBy from the LLM', () => {
        const json = JSON.stringify({
            summary: wo2Summary(),
            divergences: {
                locations: [],
                npc_events: [{
                    text: 'Grak allied with the player', sceneRef: '002', npcIds: ['npc_42'],
                    knownBy: ['npc:npc_42', 'npc:npc_7'], unrecognizedNpcNames: [],
                }],
                promises_debts: [], world_state: [], party_facts: [], rules_lore: [], misc: [],
            },
        });
        const result = parseCombinedSealOutput(json, 'ch01', WO2_SCENES, WO2_LEDGER, undefined, WO2_INDEX);
        const e = result.divergences.find(d => d.text === 'Grak allied with the player');
        expect(e!.knownBy).toEqual(['npc:npc_42', 'npc:npc_7']);
    });

    it('accepts "player" token and a faction token', () => {
        const json = JSON.stringify({
            summary: wo2Summary(),
            divergences: {
                locations: [],
                npc_events: [{
                    text: 'Sentinel identity leaked', sceneRef: '002', npcIds: [],
                    knownBy: ['player', 'faction:Ironspire Knights'], unrecognizedNpcNames: [],
                }],
                promises_debts: [], world_state: [], party_facts: [], rules_lore: [], misc: [],
            },
        });
        const result = parseCombinedSealOutput(json, 'ch01', WO2_SCENES, WO2_LEDGER, undefined, WO2_INDEX);
        const e = result.divergences.find(d => d.text === 'Sentinel identity leaked');
        expect(e!.knownBy).toEqual(['player', 'faction:ironspire knights']);
    });

    it('preserves explicit "[]" knownBy as secret (empty array)', () => {
        const json = JSON.stringify({
            summary: wo2Summary(),
            divergences: {
                locations: [],
                npc_events: [{
                    text: 'Hidden ritual', sceneRef: '002', npcIds: [],
                    knownBy: [], unrecognizedNpcNames: [],
                }],
                promises_debts: [], world_state: [], party_facts: [], rules_lore: [], misc: [],
            },
        });
        const result = parseCombinedSealOutput(json, 'ch01', WO2_SCENES, WO2_LEDGER, undefined, WO2_INDEX);
        const e = result.divergences.find(d => d.text === 'Hidden ritual');
        expect(e!.knownBy).toEqual([]);
    });

    it('does NOT seed knownBy when the source scene had no recorded witnesses', () => {
        const json = JSON.stringify({
            summary: wo2Summary(),
            divergences: {
                locations: [],
                npc_events: [{
                    text: 'A whisper in the dark', sceneRef: '003', npcIds: [], unrecognizedNpcNames: [],
                }],
                promises_debts: [], world_state: [], party_facts: [], rules_lore: [], misc: [],
            },
        });
        const result = parseCombinedSealOutput(json, 'ch01', WO2_SCENES, WO2_LEDGER, undefined, WO2_INDEX);
        const e = result.divergences.find(d => d.text === 'A whisper in the dark');
        expect(e!.knownBy).toBeUndefined();
    });
});