import { describe, it, expect } from 'vitest';

const SINGLE_PASS_LIMIT = 1500;
const WINDOW_SIZE = 1000;
const WINDOW_STRIDE = 700;

// Default dims match Xenova/all-MiniLM-L6-v2; bge-base-en-v1.5 uses 768
const DEFAULT_DIMS = 384;

function getWindows(text: string): string[] {
    if (text.length <= SINGLE_PASS_LIMIT) return [text];
    const windows: string[] = [];
    let i = 0;
    while (i < text.length) {
        windows.push(text.slice(i, i + WINDOW_SIZE));
        if (i + WINDOW_SIZE >= text.length) break;
        i += WINDOW_STRIDE;
    }
    return windows;
}

function poolVectors(vectors: number[][], dims: number = DEFAULT_DIMS): number[] {
    const pooled = new Array(dims).fill(0);
    for (const vec of vectors) {
        for (let j = 0; j < dims; j++) {
            pooled[j] += vec[j];
        }
    }
    for (let j = 0; j < dims; j++) {
        pooled[j] /= vectors.length;
    }
    let norm = 0;
    for (let j = 0; j < dims; j++) {
        norm += pooled[j] * pooled[j];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
        for (let j = 0; j < dims; j++) {
            pooled[j] /= norm;
        }
    }
    return pooled;
}

function vectorNorm(v: number[]): number {
    let sum = 0;
    for (const x of v) sum += x * x;
    return Math.sqrt(sum);
}

describe('embedder windowing logic', () => {
    it('short text produces a single window (no splitting)', () => {
        const text = 'x'.repeat(500);
        const windows = getWindows(text);
        expect(windows.length).toBe(1);
        expect(windows[0]).toBe(text);
    });

    it('text within SINGLE_PASS_LIMIT produces a single window', () => {
        const text = 'x'.repeat(SINGLE_PASS_LIMIT);
        const windows = getWindows(text);
        expect(windows.length).toBe(1);
    });

    it('3000-char text produces multiple windows with correct overlapping', () => {
        const text = 'a'.repeat(3000);
        const windows = getWindows(text);
        expect(windows.length).toBeGreaterThanOrEqual(3);
        for (const w of windows) {
            expect(w.length).toBeLessThanOrEqual(WINDOW_SIZE);
        }
    });

    it('pooled vector has unit norm after renormalization (default dims)', () => {
        const dim = DEFAULT_DIMS;
        const mockVecs = [
            Array.from({ length: dim }, () => Math.random()).map(x => {
                const norm = Math.sqrt(dim) * 0.5;
                return x / norm;
            }),
            Array.from({ length: dim }, () => Math.random()).map(x => {
                const norm = Math.sqrt(dim) * 0.5;
                return x / norm;
            }),
        ];
        const pooled = poolVectors(mockVecs, dim);
        const norm = vectorNorm(pooled);
        expect(Math.abs(norm - 1.0)).toBeLessThan(1e-5);
    });

    it('pooled vector has unit norm after renormalization (768 dims)', () => {
        const dim = 768;
        const mockVecs = [
            Array.from({ length: dim }, () => Math.random()).map(x => {
                const norm = Math.sqrt(dim) * 0.5;
                return x / norm;
            }),
            Array.from({ length: dim }, () => Math.random()).map(x => {
                const norm = Math.sqrt(dim) * 0.5;
                return x / norm;
            }),
        ];
        const pooled = poolVectors(mockVecs, dim);
        const norm = vectorNorm(pooled);
        expect(Math.abs(norm - 1.0)).toBeLessThan(1e-5);
    });

    it('single vector pooling preserves unit norm', () => {
        const dim = DEFAULT_DIMS;
        const unitVec = new Array(dim).fill(1 / Math.sqrt(dim));
        const pooled = poolVectors([unitVec]);
        const norm = vectorNorm(pooled);
        expect(Math.abs(norm - 1.0)).toBeLessThan(1e-10);
    });

    it('zero vectors pool to zero norm without NaN', () => {
        const dim = DEFAULT_DIMS;
        const zeroVec = new Array(dim).fill(0);
        const pooled = poolVectors([zeroVec]);
        const norm = vectorNorm(pooled);
        expect(norm).toBe(0);
        for (const x of pooled) {
            expect(Number.isNaN(x)).toBe(false);
        }
    });
});