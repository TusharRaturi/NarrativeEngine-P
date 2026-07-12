import { describe, it, expect } from 'vitest';
import { extractJson, extractJsonRobust } from '../jsonExtract';

describe('extractJsonRobust', () => {
    it('parses clean JSON objects', () => {
        expect(extractJsonRobust('{"a": 1}', null)).toEqual({ value: { a: 1 }, parseOk: true });
    });

    it('parses array roots (desktop-contributed behavior)', () => {
        expect(extractJsonRobust('here you go: [1, 2, 3]', null)).toEqual({ value: [1, 2, 3], parseOk: true });
    });

    it('strips closed think blocks and markdown fences', () => {
        const raw = '<think>hmm {not: json}</think>\n```json\n{"a": 1}\n```';
        expect(extractJsonRobust(raw, null)).toEqual({ value: { a: 1 }, parseOk: true });
    });

    it('strips UNCLOSED think blocks (mobile-contributed behavior)', () => {
        const raw = '<think>reasoning that never closes... {"decoy": true} nope\nActual answer: {"a": 1}';
        const r = extractJsonRobust<{ a?: number; decoy?: boolean }>(raw, {});
        expect(r.parseOk).toBe(true);
    });

    it('recovers truncated objects by closing open brackets', () => {
        const truncated = '{"items": [{"id": 1}, {"id": 2}, {"id": 3, "na';
        const r = extractJsonRobust<{ items: { id: number }[] }>(truncated, { items: [] });
        expect(r.parseOk).toBe(true);
        expect(r.value.items.length).toBeGreaterThanOrEqual(2);
    });

    it('returns the fallback when nothing is recoverable', () => {
        expect(extractJsonRobust('no json here at all', 'FB')).toEqual({ value: 'FB', parseOk: false });
    });
});

describe('extractJson', () => {
    it('extracts the JSON substring from chatter', () => {
        expect(extractJson('Sure! Here it is: {"a": 1} Hope that helps.')).toBe('{"a": 1}');
    });

    it('leaves valid JSON byte-identical — including // inside string values', () => {
        const valid = '{"url": "https://example.com/x", "note": "a//b"}';
        expect(extractJson(`prefix ${valid} suffix`)).toBe(valid);
        expect(JSON.parse(extractJson(valid))).toEqual(JSON.parse(valid));
    });

    it('repairs trailing commas', () => {
        expect(JSON.parse(extractJson('{"a": 1, "b": [1, 2,],}'))).toEqual({ a: 1, b: [1, 2] });
    });

    it('repairs // and /* */ comments in broken JSON', () => {
        const noisy = '{\n  "a": 1, // inline note\n  /* block */ "b": 2,\n}';
        expect(JSON.parse(extractJson(noisy))).toEqual({ a: 1, b: 2 });
    });

    it('repairs single-quoted values', () => {
        expect(JSON.parse(extractJson("{\"name\": 'Kael', \"job\": 'smith',}"))).toEqual({ name: 'Kael', job: 'smith' });
    });

    it('escapes raw newlines inside broken-JSON strings', () => {
        const broken = '{"text": "line one\nline two",}';
        expect(JSON.parse(extractJson(broken))).toEqual({ text: 'line one\nline two' });
    });

    it('handles unclosed think blocks before the payload', () => {
        expect(extractJson('<think>endless pondering\n{"a": 1}')).toBe('{"a": 1}');
    });
});
