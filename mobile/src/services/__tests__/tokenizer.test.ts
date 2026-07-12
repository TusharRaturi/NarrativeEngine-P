import { describe, it, expect } from 'vitest';
import { countTokens } from '../infrastructure';

describe('countTokens', () => {
    it('returns 0 for empty string', () => {
        expect(countTokens('')).toBe(0);
    });

    it('counts tokens for plain English text', () => {
        const tokens = countTokens('Hello, world!');
        expect(tokens).toBeGreaterThan(0);
        expect(tokens).toBeLessThan(10);
    });

    it('counts more tokens for longer text', () => {
        const short = countTokens('Hello');
        const long = countTokens('Hello, this is a much longer sentence with many more words.');
        expect(long).toBeGreaterThan(short);
    });

    it('handles special characters', () => {
        const tokens = countTokens('*** DICE ROLL: d20 = 15 ***');
        expect(tokens).toBeGreaterThan(0);
    });

    it('handles newlines', () => {
        const tokens = countTokens('line1\nline2\nline3');
        expect(tokens).toBeGreaterThan(0);
    });
});