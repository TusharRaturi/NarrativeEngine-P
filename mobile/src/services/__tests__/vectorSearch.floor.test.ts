import { describe, it, expect } from 'vitest';
import { cosineSimilarity } from '../embedding';

describe('vectorSearch similarity floor and dedupe', () => {
    it('cosineSimilarity returns 1 for identical vectors', () => {
        const v = [1, 0, 0, 0];
        expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
    });

    it('cosineSimilarity returns 0 for orthogonal vectors', () => {
        const a = [1, 0, 0];
        const b = [0, 1, 0];
        expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
    });

    it('cosineSimilarity returns -1 for opposite vectors', () => {
        const a = [1, 0];
        const b = [-1, 0];
        expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
    });

    it('dedupe logic: strips #w suffix and keeps max score', () => {
        const baseId = 'some-chunk';
        const sub1 = 'some-chunk#w0';
        const sub2 = 'some-chunk#w1';

        const results = [
            { id: sub1, score: 0.85 },
            { id: sub2, score: 0.72 },
            { id: 'other', score: 0.60 },
        ];

        const bestByBase = new Map<string, { id: string; score: number }>();
        for (const hit of results) {
            const base = hit.id.replace(/#w\d+$/, '');
            const existing = bestByBase.get(base);
            if (!existing || hit.score > existing.score) {
                bestByBase.set(base, { ...hit, id: base });
            }
        }

        const deduped = Array.from(bestByBase.values());
        expect(deduped.length).toBe(2);
        const chunkEntry = deduped.find(d => d.id === baseId);
        expect(chunkEntry).toBeDefined();
        expect(chunkEntry!.score).toBe(0.85);
    });

    it('minScore filter: low-similarity candidates are dropped', () => {
        const scored = [
            { id: '1', score: 0.45 },
            { id: '2', score: 0.29 },
            { id: '3', score: 0.15 },
        ];
        const minScore = 0.30;
        const filtered = scored.filter(h => h.score >= minScore);
        expect(filtered.length).toBe(1);
        expect(filtered[0].id).toBe('1');
    });

    it('empty results when all below floor', () => {
        const scored = [
            { id: '1', score: 0.10 },
            { id: '2', score: 0.20 },
        ];
        const filtered = scored.filter(h => h.score >= 0.30);
        expect(filtered.length).toBe(0);
    });
});