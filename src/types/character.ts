// ─── Character / NPC Types ────────────────────────────────────────────────

export type InventoryItemCategory = 'weapon' | 'armor' | 'consumable' | 'currency' | 'key' | 'misc' | 'equipped';

export type InventoryItem = {
    id: string;
    name: string;
    qty: number;
    category: InventoryItemCategory;
    keywords: string[];
    equipped: boolean;
    lastUsedScene: string;
    importance: number;
    notes: string;
    status?: string;
};

export type CharacterProfile = {
    name: string;
    race: string;
    class: string;
    level: number;
    hp: { current: number; max: number };
    mp?: { current: number; max: number };
    stats: Record<string, number>;
    skills: string[];
    abilities: string[];
    traits: string[];
    notes: string;
};

export type NPCVisualProfile = {
    race: string;
    gender: string;
    ageRange: string;
    build: string;
    symmetry: string; // ugly / pretty / handsome etc.
    hairStyle: string;
    eyeColor: string;
    skinTone: string;
    gait: string;
    distinctMarks: string;
    clothing: string;
    artStyle: string;
};

export const DEFAULT_VISUAL_PROFILE: NPCVisualProfile = {
    race: '', gender: '', ageRange: '', build: '', symmetry: '',
    hairStyle: '', eyeColor: '', skinTone: '', gait: '', distinctMarks: '', clothing: '', artStyle: 'Anime',
};

export type NPCBehavioralTrigger = {
    keyword: string;
    shift: string;
};

export type NPCPressureHistory = {
    turn: number;
    type: 'ignored' | 'engaged';
    delta: number;
    reason: string;
};

export type NPCDrives = {
    coreWant: string;
    sessionWant: string;
    sceneWant: string;
};

export type NPCPressure = {
    ignored: number;
    engaged: number;
    lastDecayTurn: number;
    lastActiveTurn?: number;
    history: NPCPressureHistory[];
};

export type NPCEntry = {
    id: string;
    name: string;
    aliases: string;
    appearance: string;
    visualProfile?: NPCVisualProfile;
    faction: string;
    storyRelevance: string;
    disposition: string;
    status: string;
    goals: string;
    voice: string;
    personality: string;
    exampleOutput: string;
    affinity: number;
    portrait?: string;
    previousSnapshot?: {
        personality: string;
        voice: string;
        affinity: number;
    };
    shiftNote?: string;
    shiftTurnCount?: number;
    drives?: NPCDrives;
    behavioralTriggers?: NPCBehavioralTrigger[];
    hardBoundaries?: string[];
    softBoundaries?: string[];
    pressure?: NPCPressure;
    archived?: boolean;
    archivedAtTurn?: number;
    archivedReason?: string;
};
