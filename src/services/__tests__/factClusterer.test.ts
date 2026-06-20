import { describe, it, expect } from 'vitest';
import { extractJsonRobust } from '../infrastructure/jsonExtract';

// Validate that factClusterer's {groups} shape works with the shared helper after migration
describe('factClusterer extractJsonRobust migration', () => {
    it('parses a well-formed groups response', () => {
        const raw = '{"groups":[{"name":"Yuki","factIds":["f1","f2"]},{"name":"Bridge","factIds":["f3"]}]}';
        const { value, parseOk } = extractJsonRobust<{ groups: Array<{ name: string; factIds: string[] }> }>(raw, { groups: [] });
        expect(parseOk).toBe(true);
        expect(value.groups).toHaveLength(2);
        expect(value.groups[0].name).toBe('Yuki');
    });

    it('recovers from truncated groups response', () => {
        const raw = '{"groups":[{"name":"Yuki","factIds":["f1","f2"]},{"name":"Bridge","factIds":["f3';
        const { value, parseOk } = extractJsonRobust<{ groups: Array<{ name: string; factIds: string[] }> }>(raw, { groups: [] });
        expect(parseOk).toBe(true);
        expect(value.groups).toHaveLength(1);
        expect(value.groups[0].name).toBe('Yuki');
    });

    it('returns fallback when no JSON object found', () => {
        const raw = 'the AI returned no JSON';
        const { value, parseOk } = extractJsonRobust<{ groups: Array<{ name: string; factIds: string[] }> }>(raw, { groups: [] });
        expect(parseOk).toBe(false);
        expect(value.groups).toHaveLength(0);
    });

    it('handles think blocks before groups JSON', () => {
        const raw = '<think>reasoning about groups</think>{"groups":[{"name":"test","factIds":["1"]}]}';
        const { value, parseOk } = extractJsonRobust<{ groups: Array<{ name: string; factIds: string[] }> }>(raw, { groups: [] });
        expect(parseOk).toBe(true);
        expect(value.groups[0].name).toBe('test');
    });
});