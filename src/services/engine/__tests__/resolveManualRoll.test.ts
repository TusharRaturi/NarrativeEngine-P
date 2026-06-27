import { describe, it, expect } from 'vitest';
import { resolveManualRoll } from '../engineRolls';
import type { DiceConfig } from '../../types';

const CONFIG: DiceConfig = { catastrophe: 2, failure: 6, success: 15, triumph: 19, crit: 20 };

describe('WO-H: resolveManualRoll', () => {
    it('1d20 mode rolls exactly one die and maps it to a tier', () => {
        const r = resolveManualRoll('1d20', CONFIG);
        expect(r.rolls).toHaveLength(1);
        expect(r.faceValue).toBe(r.rolls[0]);
        expect(r.detail).toBe('Roll');
        expect(r.tier).toBeTypeOf('string');
        expect(r.tier.length).toBeGreaterThan(0);
    });

    it('adv mode rolls two dice and takes the higher', () => {
        const r = resolveManualRoll('adv', CONFIG);
        expect(r.rolls).toHaveLength(2);
        expect(r.faceValue).toBe(Math.max(r.rolls[0], r.rolls[1]));
        expect(r.detail).toBe('Advantage');
    });

    it('disadv mode rolls two dice and takes the lower', () => {
        const r = resolveManualRoll('disadv', CONFIG);
        expect(r.rolls).toHaveLength(2);
        expect(r.faceValue).toBe(Math.min(r.rolls[0], r.rolls[1]));
        expect(r.detail).toBe('Disadvantage');
    });

    it('faceValue is always 1..20', () => {
        for (let i = 0; i < 50; i++) {
            const r = resolveManualRoll('1d20', CONFIG);
            expect(r.faceValue).toBeGreaterThanOrEqual(1);
            expect(r.faceValue).toBeLessThanOrEqual(20);
        }
    });

    it('maps a 20 to Narrative Boon (top tier above triumph)', () => {
        // Deterministic: force faceValue 20 by mocking Math.random.
        const orig = Math.random;
        Math.random = () => 0.9999;
        try {
            const r = resolveManualRoll('1d20', CONFIG);
            expect(r.faceValue).toBe(20);
            expect(r.tier).toBe('Narrative Boon');
        } finally {
            Math.random = orig;
        }
    });

    it('maps a 1 to Catastrophe tier', () => {
        const orig = Math.random;
        Math.random = () => 0.0;
        try {
            const r = resolveManualRoll('1d20', CONFIG);
            expect(r.faceValue).toBe(1);
            expect(r.tier).toBe('Catastrophe');
        } finally {
            Math.random = orig;
        }
    });

    it('falls back to default thresholds when diceConfig is undefined', () => {
        const r = resolveManualRoll('1d20', undefined);
        expect(r.tier).toBeTypeOf('string');
        // No throw — default thresholds apply.
    });
});