import { describe, it, expect } from 'vitest';
import { deriveSubjectTokenUpdates } from '../campaign-state/factClusterer';
import type { DivergenceRegister, DivergenceEntry, TopicClusters } from '../../types';
import { EMPTY_REGISTER } from '../campaign-state';

const entry = (id: string, overrides: Partial<DivergenceEntry> = {}): DivergenceEntry => ({
    id,
    chapterId: 'CH01',
    category: 'misc',
    text: `fact ${id}`,
    sceneRef: '001',
    npcIds: [],
    pinned: false,
    source: 'auto',
    ...overrides,
});

const reg = (entries: DivergenceEntry[]): DivergenceRegister => ({ ...EMPTY_REGISTER, entries });

const clusters = (groups: Array<{ name: string; factIds: string[] }>): TopicClusters => ({
    groups: groups.map((g, i) => ({
        id: `cluster-${i}`,
        name: g.name,
        factIds: g.factIds,
    })),
    generatedAt: '2026-06-18T00:00:00.000Z',
    generatedFromFactCount: 0,
});

describe('deriveSubjectTokenUpdates — WO4', () => {
    it('WO4 acceptance: two untokened facts about Alex get the SAME token after grouping', () => {
        const r = reg([
            entry('d30', { text: 'Alex is the Sentinel', subjectToken: undefined }),
            entry('d80', { text: 'Alex is dead', subjectToken: undefined }),
        ]);
        const c = clusters([{ name: 'Alex', factIds: ['d30', 'd80'] }]);
        const updates = deriveSubjectTokenUpdates(r, c);
        expect(updates).toHaveLength(2);
        const tokens = updates.map(u => u.subjectToken);
        expect(tokens[0]).toBe(tokens[1]);
        expect(tokens[0]).toBe('alex');
    });

    it('reuses the most common existing token among members (drift repair)', () => {
        // 3 facts: two already share "alex.identity", one drifted to "alex_chen.identity".
        const r = reg([
            entry('d1', { subjectToken: 'alex.identity' }),
            entry('d2', { subjectToken: 'alex.identity' }),
            entry('d3', { subjectToken: 'alex_chen.identity' }),
        ]);
        const c = clusters([{ name: 'Alex', factIds: ['d1', 'd2', 'd3'] }]);
        const updates = deriveSubjectTokenUpdates(r, c);
        // d1 and d2 already have the canonical token — no update. d3 gets repaired to alex.identity.
        const upd3 = updates.find(u => u.id === 'd3');
        expect(upd3?.subjectToken).toBe('alex.identity');
        expect(updates.find(u => u.id === 'd1')).toBeUndefined();
        expect(updates.find(u => u.id === 'd2')).toBeUndefined();
    });

    it('synthesizes a token from the cluster name when no member has one', () => {
        const r = reg([
            entry('d1', { text: 'The Ruby of Doom was stolen' }),
            entry('d2', { text: 'The Ruby of Doom is cursed' }),
        ]);
        const c = clusters([{ name: 'Ruby of Doom', factIds: ['d1', 'd2'] }]);
        const updates = deriveSubjectTokenUpdates(r, c);
        expect(updates).toHaveLength(2);
        expect(updates.every(u => u.subjectToken === 'ruby_of_doom')).toBe(true);
    });

    it('leaves singleton clusters untouched (existing token kept, undefined stays undefined)', () => {
        const r = reg([
            entry('d1', { subjectToken: 'solo.token' }),
            entry('d2', { subjectToken: undefined }),
        ]);
        // Two singleton groups.
        const c = clusters([
            { name: 'd1 thing', factIds: ['d1'] },
            { name: 'd2 thing', factIds: ['d2'] },
        ]);
        const updates = deriveSubjectTokenUpdates(r, c);
        expect(updates).toEqual([]);
    });

    it('NEVER disables or deletes — only emits subjectToken updates (invariant)', () => {
        const r = reg([
            entry('d1', { enabled: false, pinned: true, text: 'keep', subjectToken: undefined }),
            entry('d2', { enabled: true, pinned: false, text: 'also keep', subjectToken: 'old' }),
            entry('d3', { enabled: true, pinned: false, text: 'third', subjectToken: undefined }),
        ]);
        const c = clusters([{ name: 'Alex', factIds: ['d1', 'd2', 'd3'] }]);
        const updates = deriveSubjectTokenUpdates(r, c);
        // Every update only carries id + subjectToken — no enabled/pinned/text fields exist on the update shape.
        for (const u of updates) {
            expect(Object.keys(u).sort()).toEqual(['id', 'subjectToken']);
        }
        // The register entries' enabled/pinned/text are NOT mutated by this pure function.
        expect(r.entries.find(e => e.id === 'd1')!.enabled).toBe(false);
        expect(r.entries.find(e => e.id === 'd1')!.pinned).toBe(true);
        expect(r.entries.find(e => e.id === 'd1')!.text).toBe('keep');
    });

    it('skips updates where the token would not change', () => {
        const r = reg([
            entry('d1', { subjectToken: 'alex.identity' }),
            entry('d2', { subjectToken: 'alex.identity' }),
        ]);
        const c = clusters([{ name: 'Alex', factIds: ['d1', 'd2'] }]);
        const updates = deriveSubjectTokenUpdates(r, c);
        expect(updates).toEqual([]);
    });

    it('handles empty register / empty clusters', () => {
        expect(deriveSubjectTokenUpdates(reg([]), clusters([]))).toEqual([]);
        expect(deriveSubjectTokenUpdates(reg([entry('d1')]), clusters([]))).toEqual([]);
    });

    it('normalizes a synthesized token (cluster name with spaces/caps)', () => {
        const r = reg([
            entry('d1', { subjectToken: undefined }),
            entry('d2', { subjectToken: undefined }),
        ]);
        const c = clusters([{ name: 'Count Von Bracken', factIds: ['d1', 'd2'] }]);
        const updates = deriveSubjectTokenUpdates(r, c);
        expect(updates[0].subjectToken).toBe('count_von_bracken');
    });
});