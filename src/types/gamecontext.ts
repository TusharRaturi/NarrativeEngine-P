// ─── Game Context / Pipeline / Session Types ─────────────────────────────

import type { InventoryItem, CharacterProfile, InventoryItemCategory, SceneStakes } from './character';
export type { SceneStakes };
import type { LoreChunk, RuleChunkMeta } from './lore';
import type { ArcRecord } from './arc';
export type { ArcRecord };

export type PipelinePhase =
    | 'idle'
    | 'rolling-dice'
    | 'gathering-context'
    | 'building-prompt'
    | 'generating'
    | 'checking-notes'
    | 'post-processing';

export type StreamingStats = {
    tokens: number;
    elapsed: number;
    speed: number;
};

export type LoreCheckCategory = 'wrong-fact' | 'contradicts-lore' | 'wrong-entity' | 'tone-voice' | 'out-of-character';
export type LoreCheckVerdict = 'consistent' | 'unsupported' | 'contradicts';
export type LoreCheckCitation = { ref: string; label: string };
export type LoreCheckResult = {
    verdict: LoreCheckVerdict;
    issues: string[];
    citations: LoreCheckCitation[];
    suggestedRewrite: string | null;
    originalText: string;
    rawResponse?: string;
};
export type LoreCheckSelection = {
    messageId: string;
    selectedText: string;
    start: number;
    end: number;
    surroundingContext: string;
};

export type CondenserState = {
    condensedUpToIndex: number;
};

export type DiceConfig = {
    catastrophe: number; // e.g. 2 (1-2 is catastrophe)
    failure: number;     // e.g. 6 (3-6 is failure)
    success: number;     // e.g. 15 (7-15 is success)
    triumph: number;     // e.g. 19 (16-19 is triumph)
    crit: number;        // e.g. 20 (20 is crit)
};

export type SurpriseConfig = {
    initialDC: number;
    dcReduction: number;
    types: string[];
    tones: string[];
};

export type EncounterConfig = {
    initialDC: number;
    dcReduction: number;
    types: string[];
    tones: string[];
};

export type CharacterIntroEntry = {
    name: string;
    type: 'wandering' | 'location';
    location?: string;          // only for type === 'location'
    boostKeywords?: string[];   // if present in last 3 assistant msgs → 3x weight
    weight?: number;            // base draw weight (default 1)
};

export type NpcIntroConfig = {
    characters: CharacterIntroEntry[];
    initialDC: number;
    dcReduction: number;
};

export type WorldEventConfig = {
    initialDC: number; // Starting DC (default: 498)
    dcReduction: number; // Amount DC drops per turn (default: 2)
    who?: string[]; // The custom 'who' table
    where?: string[]; // The custom 'where' table
    why?: string[]; // The custom 'why' table
    what?: string[]; // The custom 'what' table
};

export type NotebookNote = {
    id: string;
    text: string;
    timestamp: number;
};

export type GameContext = {
    loreRaw: string;
    rulesRaw: string;
    canonState: string;
    headerIndex: string;
    starter: string;
    continuePrompt: string;
    inventory: string; // @deprecated — legacy plain-text. Prefer inventoryItems.
    inventoryLastScene: string;
    characterProfile: string; // @deprecated — legacy plain-text. Prefer characterProfileData.
    characterProfileLastScene: string;
    // --- Structured replacements ---
    inventoryItems: InventoryItem[];
    characterProfileData: CharacterProfile;
    // --- Smart injection toggle ---
    smartBookkeepingActive: boolean;
    surpriseDC?: number;
    encounterDC?: number;
    worldEventDC?: number;
    diceConfig?: DiceConfig;
    worldEventConfig?: WorldEventConfig;
    // Toggles: whether each field is appended to context
    canonStateActive: boolean;
    headerIndexActive: boolean;
    starterActive: boolean;
    continuePromptActive: boolean;
    inventoryActive: boolean;
    characterProfileActive: boolean;
    surpriseEngineActive: boolean;
    encounterEngineActive: boolean;
    worldEngineActive: boolean;
    diceFairnessActive: boolean;
    sceneNote: string;
    sceneNoteActive: boolean;
    sceneNoteDepth: number;
    surpriseConfig?: SurpriseConfig;
    encounterConfig?: EncounterConfig;
    worldVibe: string;
    notebook: NotebookNote[];
    notebookActive: boolean;
    // NPC Intro Engine
    npcIntroEngineActive?: boolean;         // master toggle
    npcIntroDC?: number;                    // current DC (decays on failed rolls)
    npcIntroConfig?: NpcIntroConfig;        // config block
    rulesChunkMeta?: Record<string, RuleChunkMeta>;
    rulesChunks?: LoreChunk[];
    // ---- NPC Agency & Combat / Tier contexts ----
    agencyTick?: number;          // monotonic tick counter (heartbeat/timeskip advance it)
    agencyHeartbeatDC?: number;   // escalating-DC pity timer (mirrors surpriseDC)
    lastSceneStakes?: SceneStakes;     // last parsed/fallback scene stakes
    agencyDigest?: string;             // player-visible tick digest, folded into next GM call
    arcDigest?: string;                // Arc Engine: current-rung surface line, folded into next GM call
    arcs?: ArcRecord[];                // Arc Engine (System 2): active + retired arcs for this campaign
    combatModeActive?: boolean;        // combat master switch (Phase 7 wiring; type-only now)
    combatConfig?: {                   // combat tuning knobs (Phase 7 wiring; type-only now)
        mookJitterRange?: number;
        defaultWeaponDie?: number;
        recoveryBands?: Record<'healthy' | 'wounded' | 'critical', number>;
        combatAutoDetect?: boolean;
        autoEnterThreshold?: number;
        askThreshold?: number;
        confirmOnBorderline?: boolean;
        combatKeywords?: string[];
    };
    statLabelMap?: Record<string, string>;
};

export type OpenAITool = {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: {
            type: 'object';
            properties: Record<string, unknown>;
            required?: string[];
        };
    };
};

export type ContextSourceClassification = 'stable_truth' | 'summary' | 'world_context' | 'volatile_state' | 'scene_local';

export type DebugSection = {
    label: string;
    role: string;
    tokens?: number;
    content: string;
    classification?: ContextSourceClassification;
};

export type PayloadTrace = {
    source: string;
    classification: ContextSourceClassification;
    tokens: number;
    reason: string;
    preview?: string;
    included: boolean;
    position?: string;
};

// ─── Bookkeeping Defaults & Migration ──────────────────────────────────

export const DEFAULT_CHARACTER_PROFILE: CharacterProfile = {
    name: '',
    race: '',
    class: '',
    level: 1,
    hp: { current: 20, max: 20 },
    stats: {},
    skills: [],
    abilities: [],
    traits: [],
    notes: '',
};

export const DEFAULT_INVENTORY: InventoryItem[] = [];

function parsePlainInventory(text: string): InventoryItem[] {
    const items: InventoryItem[] = [];
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
        const clean = line.replace(/^[-*•]\s*/, '').replace(/^\d+\.\s*/, '');
        if (!clean) continue;
        const nameMatch = clean.match(/^(.*?)(?:\s*\((\d+)\s*x\s*(.+)\))?\s*$/i);
        const name = nameMatch ? nameMatch[1].trim() : clean;
        const qtyMatch = clean.match(/(?:x\s*(\d+))|(\d+)x/i);
        const qty = qtyMatch ? parseInt(qtyMatch[1] || qtyMatch[2], 10) : 1;
        const lower = name.toLowerCase();
        let category: InventoryItemCategory = 'misc';
        if (lower.includes('gold') || lower.includes('coin') || lower.includes('silver') || lower.includes('copper')) category = 'currency';
        else if (lower.includes('potion') || lower.includes('elixir') || lower.includes('antidote')) category = 'consumable';
        else if (lower.includes('sword') || lower.includes('dagger') || lower.includes('bow') || lower.includes('axe') || lower.includes('mace') || lower.includes('staff') || lower.includes('blade')) category = 'weapon';
        else if (lower.includes('armor') || lower.includes('shield') || lower.includes('helm') || lower.includes('gauntlet') || lower.includes('boot') || lower.includes('plate')) category = 'armor';
        else if (lower.includes('key') || lower.includes('seal') || lower.includes('tome')) category = 'key';
        items.push({
            id: `inv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            name,
            qty,
            category,
            keywords: name.toLowerCase().split(/\s+/).filter(w => w.length > 2),
            equipped: false,
            lastUsedScene: '000',
            importance: 5,
            notes: '',
        });
    }
    return items;
}

function extractHp(str: string): { current: number; max: number } | undefined {
    const m = str.match(/HP[:\s]*?(\d+)\s*[\/]\s*(\d+)/i);
    if (m) return { current: parseInt(m[1], 10), max: parseInt(m[2], 10) };
    return undefined;
}

function extractStat(str: string, label: string): number | undefined {
    const r = new RegExp(`${label}[:\s]*?(\\d+)`, 'i');
    const m = str.match(r);
    if (m) return parseInt(m[1], 10);
    return undefined;
}

function extractList(str: string, header: string): string[] {
    const idx = str.toLowerCase().indexOf(header.toLowerCase());
    if (idx === -1) return [];
    const block = str.slice(idx + header.length);
    const endIdx = block.search(/\n\n|^[A-Z][\w\s]+:/m);
    const sub = endIdx !== -1 ? block.slice(0, endIdx) : block;
    return sub
        .split('\n')
        .map(l => l.trim().replace(/^[-*•]+\s*/, ''))
        .filter(Boolean);
}

export function migrateLegacyContext(ctx: Partial<GameContext>): GameContext {
    // Note: Agency fields (agencyTick, agencyHeartbeatDC, lastSceneStakes, agencyDigest, arcDigest, etc.)
    // are not initialized here; they are lazy-migrated in Phase 2.
    const base: GameContext = {
        loreRaw: '',
        rulesRaw: '',
        rulesChunkMeta: {},
        rulesChunks: [],
        canonState: '',
        headerIndex: '',
        starter: '',
        continuePrompt: '',
        inventory: '',
        inventoryLastScene: 'Never',
        characterProfile: '',
        characterProfileLastScene: 'Never',
        inventoryItems: DEFAULT_INVENTORY,
        characterProfileData: DEFAULT_CHARACTER_PROFILE,
        smartBookkeepingActive: true,
        canonStateActive: false,
        headerIndexActive: false,
        starterActive: false,
        continuePromptActive: false,
        inventoryActive: false,
        characterProfileActive: false,
        surpriseEngineActive: false,
        encounterEngineActive: true,
        worldEngineActive: true,
        diceFairnessActive: true,
        sceneNote: '',
        sceneNoteActive: false,
        sceneNoteDepth: 3,
        notebook: [],
        notebookActive: true,
        worldVibe: '',
        worldEventConfig: {
            initialDC: 498,
            dcReduction: 2,
            who: [],
            where: [],
            why: [],
            what: [],
        },
    };
    const merged: GameContext = { ...base, ...ctx };
    if (!merged.inventoryItems || merged.inventoryItems.length === 0) {
        if (merged.inventory && merged.inventory.trim()) {
            merged.inventoryItems = parsePlainInventory(merged.inventory);
        } else {
            merged.inventoryItems = DEFAULT_INVENTORY;
        }
    }
    if (!merged.characterProfileData || !merged.characterProfileData.name) {
        if (merged.characterProfile && merged.characterProfile.trim()) {
            const prof = merged.characterProfile;
            merged.characterProfileData = {
                ...DEFAULT_CHARACTER_PROFILE,
                name: (prof.match(/Name[:\s]*(.+)/i)?.[1] || '').trim(),
                race: (prof.match(/Race[:\s]*(.+)/i)?.[1] || '').trim(),
                class: (prof.match(/Class[:\s]*(.+)/i)?.[1] || '').trim(),
                level: parseInt(prof.match(/Level[:\s]*(\d+)/i)?.[1] || '1', 10),
                hp: extractHp(prof) || merged.characterProfileData.hp,
                stats: {
                    str: extractStat(prof, 'str') ?? extractStat(prof, 'strength') ?? merged.characterProfileData.stats.str,
                    dex: extractStat(prof, 'dex') ?? extractStat(prof, 'dexterity') ?? merged.characterProfileData.stats.dex,
                    con: extractStat(prof, 'con') ?? extractStat(prof, 'constitution') ?? merged.characterProfileData.stats.con,
                    int: extractStat(prof, 'int') ?? extractStat(prof, 'intelligence') ?? merged.characterProfileData.stats.int,
                    wis: extractStat(prof, 'wis') ?? extractStat(prof, 'wisdom') ?? merged.characterProfileData.stats.wis,
                    cha: extractStat(prof, 'cha') ?? extractStat(prof, 'charisma') ?? merged.characterProfileData.stats.cha,
                },
                skills: extractList(prof, 'skills'),
                abilities: extractList(prof, 'abilities'),
                traits: extractList(prof, 'traits'),
                notes: prof,
            };
        } else {
            merged.characterProfileData = DEFAULT_CHARACTER_PROFILE;
        }
    }
    return merged;
}
