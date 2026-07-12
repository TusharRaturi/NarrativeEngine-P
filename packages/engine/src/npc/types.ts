// NPC personality hex types — structural twins of the app-side types
// (mainApp src/types/character.ts, mobileApp src/types/index.ts).

export type HexAxis = 'drive' | 'diligence' | 'boldness' | 'warmth' | 'empathy' | 'composure';
export type PersonalityHex = Record<HexAxis, number>;
