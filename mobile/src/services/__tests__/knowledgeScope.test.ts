import { describe, it, expect } from 'vitest';
import {
    normalizeSubjectToken,
    parseKnownByToken,
    isKnownToAnyOnStage,
    compareSceneRef,
    groupDivergencesBySubject,
} from '../campaign-state';
import type { DivergenceEntry } from '../../types';

const makeEntry = (id: string, overrides: Partial<DivergenceEntry> = {}): DivergenceEntry => ({
    id,
    chapterId: 'ch1',
    category: 'misc',
    text: `Fact ${id}`,
    sceneRef: '001',
    npcIds: [],
    pinned: false,
    source: 'auto',
    ...overrides,
});

describe('knowledgeScope — T0 & T3', () => {
    describe('T0 — normalizeSubjectToken', () => {
        const cases = [
            { raw: 'Alex.Status', expected: 'alex.status' },
            { raw: 'alex status', expected: 'alex_status' },
            { raw: '  ', expected: undefined },
            { raw: '', expected: undefined },
            { raw: '  Alex.Status  ', expected: 'alex.status' },
            { raw: 'a-b-c', expected: 'a_b_c' },
            { raw: 'a--b', expected: 'a_b' },
            { raw: 'Alex!!Status', expected: 'alexstatus' },
            { raw: 'alex..status', expected: 'alex.status' },
            { raw: 'alex__status', expected: 'alex_status' },
            { raw: '.alex.status.', expected: 'alex.status' },
            { raw: '_alex_status_', expected: 'alex_status' },
            { raw: 'a'.repeat(50), expected: 'a'.repeat(40) },
            { raw: 'a'.repeat(39) + '.', expected: 'a'.repeat(39) },
            { raw: 'a'.repeat(39) + '_', expected: 'a'.repeat(39) },
        ];

        cases.forEach(({ raw, expected }) => {
            it(`normalizes "${raw}" to ${expected === undefined ? 'undefined' : `"${expected}"`}`, () => {
                expect(normalizeSubjectToken(raw)).toBe(expected);
            });
        });
    });

    describe('T0 — parseKnownByToken', () => {
        const cases = [
            { token: 'player', expected: { kind: 'player' } },
            { token: 'PLAYER', expected: { kind: 'player' } },
            { token: ' player ', expected: { kind: 'player' } },
            { token: 'npc:abc', expected: { kind: 'npc', id: 'abc' } },
            { token: 'npc:  abc ', expected: { kind: 'npc', id: 'abc' } },
            { token: 'npc:', expected: null },
            { token: 'faction:Iron Spire', expected: { kind: 'faction', name: 'iron spire' } },
            { token: 'faction:  Iron   Spire ', expected: { kind: 'faction', name: 'iron spire' } },
            { token: 'faction:', expected: null },
            { token: 'junk', expected: null },
            { token: '', expected: null },
            { token: 'npc_123', expected: null },
        ];

        cases.forEach(({ token, expected }) => {
            it(`parses "${token}" to ${JSON.stringify(expected)}`, () => {
                expect(parseKnownByToken(token)).toEqual(expected);
            });
        });
    });

    describe('T0 — isKnownToAnyOnStage', () => {
        const ledger = [
            { id: 'npc_A', faction: 'Knights of the Round' },
            { id: 'npc_B', faction: 'Iron Spire' },
            { id: 'npc_C' }, // no faction
        ];

        it('returns true when knownBy is undefined (public)', () => {
            expect(isKnownToAnyOnStage(undefined, ['npc_A'], ledger)).toBe(true);
        });

        it('returns false when knownBy is [] (secret)', () => {
            expect(isKnownToAnyOnStage([], ['npc_A'], ledger)).toBe(false);
        });

        it('returns true when knownBy has npc:id and that npc is on stage', () => {
            expect(isKnownToAnyOnStage(['npc:npc_A'], ['npc_A'], ledger)).toBe(true);
        });

        it('returns false when knownBy has npc:id and that npc is off stage', () => {
            expect(isKnownToAnyOnStage(['npc:npc_A'], ['npc_B'], ledger)).toBe(false);
        });

        it('returns true when knownBy has faction:name and an on-stage NPC is in that faction', () => {
            expect(isKnownToAnyOnStage(['faction:knights of the round'], ['npc_A'], ledger)).toBe(true);
        });

        it('returns false when knownBy has faction:name and the on-stage NPC is not in that faction', () => {
            expect(isKnownToAnyOnStage(['faction:knights of the round'], ['npc_B'], ledger)).toBe(false);
        });

        it('returns false when knownBy contains player (player is not an NPC)', () => {
            expect(isKnownToAnyOnStage(['player'], ['npc_A'], ledger)).toBe(false);
        });

        it('handles unrecognized or malformed tokens gracefully by skipping them', () => {
            expect(isKnownToAnyOnStage(['junk', 'npc:npc_A'], ['npc_A'], ledger)).toBe(true);
            expect(isKnownToAnyOnStage(['faction:', 'npc:npc_A'], ['npc_B'], ledger)).toBe(false);
        });
    });

    describe('T3 — groupDivergencesBySubject', () => {
        it('groups facts sharing a subjectToken together, sorting beats by sceneRef ascending', () => {
            const e1 = makeEntry('1', { subjectToken: 'alex.identity', sceneRef: '003' });
            const e2 = makeEntry('2', { subjectToken: 'alex.identity', sceneRef: '001' });
            const e3 = makeEntry('3', { subjectToken: 'bob.secrets', sceneRef: '002' });

            const groups = groupDivergencesBySubject([e1, e2, e3]);

            // Groups with tokens should come first, alphabetical by token.
            // "alex.identity" comes before "bob.secrets".
            expect(groups).toHaveLength(2);
            expect(groups[0].token).toBe('alex.identity');
            expect(groups[0].entries).toHaveLength(2);
            // check sorting by sceneRef ascending
            expect(groups[0].entries[0].id).toBe('2'); // sceneRef 001
            expect(groups[0].entries[1].id).toBe('1'); // sceneRef 003

            expect(groups[1].token).toBe('bob.secrets');
            expect(groups[1].entries).toHaveLength(1);
            expect(groups[1].entries[0].id).toBe('3');
        });

        it('treats undefined-token facts as singletons with key containing entry ID', () => {
            const e1 = makeEntry('1', { subjectToken: undefined, sceneRef: '005' });
            const e2 = makeEntry('2', { subjectToken: undefined, sceneRef: '002' });

            const groups = groupDivergencesBySubject([e1, e2]);

            // Since both are singletons, they form separate groups.
            // Order is determined by sceneRef because they are untokened.
            expect(groups).toHaveLength(2);
            expect(groups[0].token).toBe('__single_2'); // sceneRef 002 comes first
            expect(groups[0].entries).toHaveLength(1);
            expect(groups[0].entries[0].id).toBe('2');

            expect(groups[1].token).toBe('__single_1'); // sceneRef 005 comes second
            expect(groups[1].entries).toHaveLength(1);
            expect(groups[1].entries[0].id).toBe('1');
        });

        it('orders tokened groups first (sorted alpha), then singletons (sorted by sceneRef)', () => {
            const e1 = makeEntry('1', { subjectToken: undefined, sceneRef: '001' });
            const e2 = makeEntry('2', { subjectToken: 'zebra.stripe', sceneRef: '005' });
            const e3 = makeEntry('3', { subjectToken: 'alpha.token', sceneRef: '002' });
            const e4 = makeEntry('4', { subjectToken: undefined, sceneRef: '003' });

            const groups = groupDivergencesBySubject([e1, e2, e3, e4]);

            expect(groups).toHaveLength(4);
            // Tokened alpha sorting: "alpha.token" -> "zebra.stripe"
            expect(groups[0].token).toBe('alpha.token');
            expect(groups[1].token).toBe('zebra.stripe');
            // Singletons sorted by sceneRef: e1 (001) -> e4 (003)
            expect(groups[2].token).toBe('__single_1');
            expect(groups[3].token).toBe('__single_4');
        });
    });

    describe('compareSceneRef', () => {
        it('compares numeric strings ascending', () => {
            expect(compareSceneRef('002', '010')).toBeLessThan(0);
            expect(compareSceneRef('100', '2')).toBeGreaterThan(0);
            expect(compareSceneRef('012', '12')).toBe(0);
        });

        it('falls back to alphabetical string comparison for non-numeric references', () => {
            expect(compareSceneRef('scene_a', 'scene_b')).toBeLessThan(0);
            expect(compareSceneRef('xyz', 'abc')).toBeGreaterThan(0);
            expect(compareSceneRef('abc', 'abc')).toBe(0);
        });
    });
});
