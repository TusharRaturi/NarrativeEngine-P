// Dice & world-engine types for the shared engine.
//
// These are structural twins of the app-side types (mainApp / mobileApp
// src/types). Apps pass their own types; TypeScript's structural typing
// keeps them compatible. The engine only declares the fields it reads —
// extra app-side fields flow through untouched.

export type OutcomeBand = {
    id: string;
    label: string;
    min: number;      // inclusive
    max: number;      // inclusive
};

export type DieType = {
    id: string;
    name: string;     // "d6", "d20", "d100", ...
    faces: number;
    bands: OutcomeBand[]; // must tile 1..faces with no gaps/overlaps
};

export type RollAggregation = 'pick_one' | 'total_all';
export type RollModifier = 'none' | 'adv' | 'disadv';

export type RollDefinition = {
    modifier: RollModifier;       // Gate 1: None / Advantage / Disadvantage
    count: number;                // Gate 2: number of dice
    aggregation: RollAggregation; // Gate 3: Pick one / Total all
};

export type DiceCategory = {
    id: string;
    name: string;
    dieTypeId: string;
};

export type DiceSystemConfig = {
    dieTypes: DieType[];
    categories: DiceCategory[];
};

export type ManualRollRequest = {
    dieTypeId: string;
    rollDef: RollDefinition;
};

// ── World-engine context (narrow view of the app GameContext) ──────────

export type EngineTierConfig = {
    initialDC?: number;
    dcReduction?: number;
    types?: string[];
    tones?: string[];
};

export type WorldEventConfig = {
    initialDC?: number;
    dcReduction?: number;
    who?: string[];
    what?: string[];
    where?: string[];
    why?: string[];
};

export type LegacyDiceThresholds = {
    catastrophe: number; failure: number; success: number; triumph: number; crit: number;
};

export type EngineRollContext = {
    surpriseDC?: number;
    encounterDC?: number;
    worldEventDC?: number;
    surpriseEngineActive?: boolean;
    encounterEngineActive?: boolean;
    worldEngineActive?: boolean;
    surpriseConfig?: EngineTierConfig;
    encounterConfig?: EngineTierConfig;
    worldEventConfig?: WorldEventConfig;
    diceFairnessActive?: boolean;
    diceSystem?: DiceSystemConfig | null;
    diceConfig?: LegacyDiceThresholds | null;
};

// ── Per-app configuration seam ──────────────────────────────────────────
// The two shells differ ONLY here: the world-tag wording/order and the
// default tag lists (each app ships its own genre-flavoured defaults).

export type WorldTagParts = { who: string; what: string; where: string; why: string };
export type WorldTagFormatter = (parts: WorldTagParts) => string;

export type EngineDefaultLists = {
    surpriseTypes: string[];
    surpriseTones: string[];
    encounterTypes: string[];
    encounterTones: string[];
    worldWho: string[];
    worldWhat: string[];
    worldWhere: string[];
    worldWhy: string[];
};

export type RollEnginesOptions = {
    defaults: EngineDefaultLists;
    formatWorldTag: WorldTagFormatter;
};
