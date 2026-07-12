import { describe, it, expect, vi, afterEach } from 'vitest';
import { rollEngines, rollDiceFairness, resolveManualRoll, executeGateRoll, parseDiceExpr } from '../engineRolls';
import { mapTier, validateBands } from '../diceTier';
import type { DieType, EngineDefaultLists, EngineRollContext, RollEnginesOptions } from '../types';

const stubRandom = (v: number) => vi.spyOn(Math, 'random').mockReturnValue(v);

afterEach(() => {
    vi.restoreAllMocks();
});

const DEFAULTS: EngineDefaultLists = {
    surpriseTypes: ['S0', 'S1', 'S2', 'S3'],
    surpriseTones: ['sT0', 'sT1', 'sT2', 'sT3'],
    encounterTypes: ['EN0', 'EN1', 'EN2', 'EN3'],
    encounterTones: ['eT0', 'eT1', 'eT2', 'eT3'],
    worldWho: ['dWho0', 'dWho1', 'dWho2', 'dWho3'],
    worldWhat: ['dWhat0', 'dWhat1', 'dWhat2', 'dWhat3'],
    worldWhere: ['dWhere0', 'dWhere1', 'dWhere2', 'dWhere3'],
    worldWhy: ['dWhy0', 'dWhy1', 'dWhy2', 'dWhy3'],
};

const OPTS: RollEnginesOptions = {
    defaults: DEFAULTS,
    formatWorldTag: ({ who, what, where, why }) => `[WORLD: ${who}|${what}|${where}|${why}]`,
};

const ctx = (overrides: Partial<EngineRollContext>): EngineRollContext => ({
    surpriseEngineActive: true,
    encounterEngineActive: true,
    worldEngineActive: true,
    ...overrides,
});

describe('rollEngines', () => {
    it('triggers all three engines with custom tag lists and the injected formatter', () => {
        stubRandom(0.5);
        const result = rollEngines(ctx({
            surpriseDC: 1, encounterDC: 1, worldEventDC: 1,
            surpriseConfig: { initialDC: 77, dcReduction: 3, types: ['T0', 'T1', 'T2', 'T3'], tones: ['N0', 'N1', 'N2', 'N3'] },
            encounterConfig: { initialDC: 155, dcReduction: 2, types: ['E0', 'E1', 'E2', 'E3'], tones: ['O0', 'O1', 'O2', 'O3'] },
            worldEventConfig: { initialDC: 444, dcReduction: 2, who: ['W0', 'W1', 'W2', 'W3'], what: ['A0', 'A1', 'A2', 'A3'], where: ['R0', 'R1', 'R2', 'R3'], why: ['Y0', 'Y1', 'Y2', 'Y3'] },
        }), OPTS);
        expect(result.appendToInput).toBe(
            '\n[SURPRISE EVENT: T2 (N2)]' +
            '\n[ENCOUNTER EVENT: E2 (O2)]' +
            '\n[WORLD: W2|A2|R2|Y2]'
        );
        expect(result.updatedDCs).toEqual({ surpriseDC: 77, encounterDC: 155, worldEventDC: 444 });
    });

    it('falls back to the injected default lists when no custom tags are configured', () => {
        stubRandom(0.5);
        const result = rollEngines(ctx({
            surpriseDC: 1, encounterDC: 1, worldEventDC: 1,
        }), OPTS);
        expect(result.appendToInput).toBe(
            '\n[SURPRISE EVENT: S2 (sT2)]' +
            '\n[ENCOUNTER EVENT: EN2 (eT2)]' +
            '\n[WORLD: dWho2|dWhat2|dWhere2|dWhy2]'
        );
        expect(result.updatedDCs).toEqual({ surpriseDC: 95, encounterDC: 198, worldEventDC: 498 });
    });

    it('decrements DCs by default reductions (3/2/2) when nothing triggers', () => {
        stubRandom(0);
        const result = rollEngines(ctx({ surpriseDC: 95, encounterDC: 198, worldEventDC: 498 }), OPTS);
        expect(result.appendToInput).toBe('');
        expect(result.updatedDCs).toEqual({ surpriseDC: 92, encounterDC: 196, worldEventDC: 496 });
    });

    it('skips disabled engines entirely', () => {
        stubRandom(0.99);
        const result = rollEngines(ctx({
            surpriseEngineActive: false, encounterEngineActive: false, worldEngineActive: false,
            surpriseDC: 1, encounterDC: 1, worldEventDC: 1,
        }), OPTS);
        expect(result.appendToInput).toBe('');
        expect(result.updatedDCs).toEqual({ surpriseDC: 1, encounterDC: 1, worldEventDC: 1 });
    });

    it('clamps DC decrements at the floor of 5', () => {
        stubRandom(0);
        const result = rollEngines(ctx({ surpriseDC: 6, encounterDC: 6, worldEventDC: 6 }), OPTS);
        expect(result.updatedDCs).toEqual({ surpriseDC: 5, encounterDC: 5, worldEventDC: 5 });
    });
});

describe('rollDiceFairness', () => {
    it('legacy d20 pool (no diceSystem) produces the exact 7-category block', () => {
        stubRandom(0.5); // every d20 roll = 11 → 'Success' band
        const result = rollDiceFairness({
            diceFairnessActive: true,
            diceConfig: { catastrophe: 2, failure: 6, success: 15, triumph: 19, crit: 20 },
        });
        const pool = 'Disadvantage: Success, Normal: Success, Advantage: Success';
        expect(result).toBe(
            `\n[DICE OUTCOMES: COMBAT=(${pool}) | PERCEPTION=(${pool}) | STEALTH=(${pool}) | SOCIAL=(${pool}) | MOVEMENT=(${pool}) | KNOWLEDGE=(${pool}) | MUNDANE=(Narrative Boon)]`
        );
    });

    it('generalized pool rolls each category die and maps its band', () => {
        stubRandom(0.5); // d10 roll = 6 → 'Mid'
        const result = rollDiceFairness({
            diceFairnessActive: true,
            diceSystem: {
                dieTypes: [{
                    id: 'd10', name: 'd10', faces: 10,
                    bands: [
                        { id: 'b1', label: 'Low', min: 1, max: 3 },
                        { id: 'b2', label: 'Mid', min: 4, max: 7 },
                        { id: 'b3', label: 'High', min: 8, max: 10 },
                    ],
                }],
                categories: [{ id: 'c1', name: 'Combat', dieTypeId: 'd10' }],
            },
        });
        expect(result).toBe('\n[DICE OUTCOMES: COMBAT=(6 → Mid)]');
    });

    it('returns empty string when dice fairness is off', () => {
        expect(rollDiceFairness({ diceFairnessActive: false })).toBe('');
    });

    it('skips categories whose die type is missing', () => {
        stubRandom(0.5);
        const result = rollDiceFairness({
            diceFairnessActive: true,
            diceSystem: { dieTypes: [], categories: [{ id: 'c1', name: 'Combat', dieTypeId: 'ghost' }] },
        });
        expect(result).toBe('\n[DICE OUTCOMES: ]');
    });
});

describe('gate rolls and manual rolls', () => {
    const d20: DieType = {
        id: 'd20', name: 'd20', faces: 20,
        bands: [
            { id: 'l1', label: 'Catastrophe', min: 1, max: 2 },
            { id: 'l2', label: 'Failure', min: 3, max: 6 },
            { id: 'l3', label: 'Success', min: 7, max: 15 },
            { id: 'l4', label: 'Triumph', min: 16, max: 19 },
            { id: 'l5', label: 'Narrative Boon', min: 20, max: 20 },
        ],
    };

    it('executeGateRoll: advantage pick_one keeps highest with detail label', () => {
        stubRandom(0.5);
        const r = executeGateRoll(d20, { modifier: 'adv', count: 3, aggregation: 'pick_one' });
        expect(r).toEqual({ value: 11, rolls: [11, 11, 11], detail: '3d20 advantage (highest)' });
    });

    it('executeGateRoll: total_all sums every die', () => {
        stubRandom(0.5);
        const r = executeGateRoll(d20, { modifier: 'none', count: 2, aggregation: 'total_all' });
        expect(r).toEqual({ value: 22, rolls: [11, 11], detail: '2d20 total' });
    });

    it('executeGateRoll: count is clamped to at least 1', () => {
        stubRandom(0.5);
        const r = executeGateRoll(d20, { modifier: 'none', count: 0, aggregation: 'pick_one' });
        expect(r.rolls).toHaveLength(1);
    });

    it('resolveManualRoll: legacy adv string migrates to a 2-die d20 roll', () => {
        stubRandom(0.5);
        const r = resolveManualRoll('adv', null);
        expect(r).toEqual({ tier: 'Success', faceValue: 11, detail: 'Advantage', rolls: [11, 11] });
    });

    it('resolveManualRoll: unknown dieTypeId falls back to the first die type', () => {
        stubRandom(0.5);
        const sys = { dieTypes: [d20], categories: [] };
        const r = resolveManualRoll({ dieTypeId: 'ghost', rollDef: { modifier: 'none', count: 1, aggregation: 'pick_one' } }, sys);
        expect(r.tier).toBe('Success');
        expect(r.faceValue).toBe(11);
    });

    it('resolveManualRoll: empty system returns the no-die sentinel', () => {
        const r = resolveManualRoll({ dieTypeId: 'x', rollDef: { modifier: 'none', count: 1, aggregation: 'pick_one' } }, { dieTypes: [], categories: [] });
        expect(r).toEqual({ tier: null, faceValue: 0, detail: 'No die type', rolls: [] });
    });

    it('parseDiceExpr round-trips 2d6+1, caps count at 100, rejects junk', () => {
        expect(parseDiceExpr('2d6+1')).toEqual({ count: 2, faces: 6, modifier: 1 });
        expect(parseDiceExpr('999d6')).toEqual({ count: 100, faces: 6, modifier: 0 });
        expect(parseDiceExpr('not dice')).toBeNull();
    });
});

describe('diceTier', () => {
    it('mapTier maps values into their band and returns null when uncovered', () => {
        const die: DieType = { id: 'd4', name: 'd4', faces: 4, bands: [{ id: 'b', label: 'Only', min: 1, max: 3 }] };
        expect(mapTier(2, die)).toBe('Only');
        expect(mapTier(4, die)).toBeNull();
        expect(mapTier(2, null)).toBeNull();
    });

    it('validateBands rejects gaps, overlaps, and bad edges', () => {
        expect(validateBands([{ id: 'a', label: 'A', min: 1, max: 4 }], 4).valid).toBe(true);
        expect(validateBands([{ id: 'a', label: 'A', min: 2, max: 4 }], 4).valid).toBe(false);
        expect(validateBands([
            { id: 'a', label: 'A', min: 1, max: 2 },
            { id: 'b', label: 'B', min: 4, max: 4 },
        ], 4).valid).toBe(false);
        expect(validateBands([], 4).valid).toBe(false);
    });
});
