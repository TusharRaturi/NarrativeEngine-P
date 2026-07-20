import type { GameContext, LoreChunk, InventoryProposal } from '../../types';
import { searchLoreByQuery } from '../lore/loreRetriever';
import { uid } from '../../utils/uid';

// ── Constants ─────────────────────────────────────────────────────────
const MAX_NOTEBOOK_OPS = 5;
const MAX_NOTEBOOK_NOTES = 50;

// ── Types ─────────────────────────────────────────────────────────────

export type ToolContext = {
    loreChunks: LoreChunk[];
    notebook: GameContext['notebook'];
};

export type LoreHandlerResult = {
    toolResult: string;
};

export type NotebookHandlerResult = {
    toolResult: string;
    updatedNotebook: GameContext['notebook'];
};



export type ProposeInventoryHandlerResult = {
    toolResult: string;
    proposal: InventoryProposal;
};

// ── Tool Definitions (JSON schemas for LLM tools array) ───────────────

const BASE_TOOLS = [
    {
        type: 'function' as const,
        function: {
            name: 'query_campaign_lore',
            description: 'Search the Game Master notes for specific lore, rules, characters, or locations. Do NOT call this sequentially or spam it. If no relevant lore is found, immediately proceed with the narrative response. IMPORTANT: You MUST use the standard JSON tool call format. NEVER output raw XML <|DSML|> tags in your response text.',
            parameters: {
                type: 'object' as const,
                properties: { query: { type: 'string' as const, description: 'The specific search query' } },
                required: ['query'],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'update_scene_notebook',
            description: 'Update the scene notebook for tracking temporary state — timers, NPC positions, environmental conditions, combat state. Actions: add (create note), remove (delete by text match), clear (wipe all). Max 50 notes, max 5 actions per call. Use sparingly — only for volatile scene state that changes within a scene.',
            parameters: {
                type: 'object' as const,
                properties: {
                    actions: {
                        type: 'array' as const,
                        items: {
                            type: 'object' as const,
                            properties: {
                                op: { type: 'string' as const, enum: ['add', 'remove', 'clear'] },
                                text: { type: 'string' as const, description: 'Note text (ignored for clear op)' },
                            },
                            required: ['op'],
                        },
                        description: 'Array of notebook actions to perform (max 5)',
                        maxItems: 5,
                    },
                },
                required: ['actions'],
            },
        },
    },
] as const;



const PROPOSE_INVENTORY_TOOL = {
    type: 'function' as const,
    function: {
        name: 'propose_inventory_change',
        description:
            "Propose adding, removing, or equipping an item in the player's inventory when the fiction materially changes their gear (loot found, a weapon gifted/bought/broken, armor donned). This only *proposes* — the player must confirm before anything changes. Supply bounded labels ONLY; the engine sets all numbers (damage dice, bonus, AC). NEVER output damageDice, bonus, hp, or AC. Do NOT call for flavor mentions the player won't use mechanically. Default quality to 'common'; reserve 'rare'+ for clearly special, story-significant items.",
        parameters: {
            type: 'object' as const,
            properties: {
                name:        { type: 'string' as const, description: 'Item name.' },
                op:          { type: 'string' as const, enum: ['grant', 'remove', 'equip'], description: "Operation. Default 'grant'." },
                kind:        { type: 'string' as const, enum: ['weapon', 'armor', 'consumable', 'misc'], description: "Item kind. Default 'misc'." },
                quality:     { type: 'string' as const, enum: ['common', 'uncommon', 'rare', 'epic', 'legendary'], description: "Rarity/quality tier. Default 'common'." },
                scalingStat: { type: 'string' as const, enum: ['PWR', 'SPD', 'WIL'], description: "Scaling stat for weapons. Default 'PWR'." },
                range:       { type: 'string' as const, enum: ['Close', 'Reach', 'Ranged'], description: "Weapon range. Default 'Close'." },
                properties:  { type: 'array' as const, items: { type: 'string' as const }, description: 'Flavor tags, e.g. ["fire","heavy"].' },
                equip:       { type: 'boolean' as const, description: 'Equip on confirm (weapons/armor). Default false.' },
                description: { type: 'string' as const, description: 'Short flavor text.' },
            },
            required: ['name'],
        },
    },
} as const;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function getToolDefinitions(_opts: { allowDiceTool: boolean }): unknown[] {
    const tools: unknown[] = [...BASE_TOOLS];
    // propose_inventory_change is combat-independent — always offered.
    tools.push(PROPOSE_INVENTORY_TOOL);
    return tools;
}

export const TOOL_DEFINITIONS = BASE_TOOLS;

// ── Handlers ──────────────────────────────────────────────────────────

/**
 * Handles `query_campaign_lore` tool calls.
 * Returns the tool result string only — caller handles payload/message dispatch.
 */
export function handleLoreTool(
    toolArguments: string,
    ctx: ToolContext
): LoreHandlerResult {
    let query = '';
    try { query = JSON.parse(toolArguments).query || ''; } catch { /* Ignore */ }

    let toolResult = 'No relevant lore found.';
    if (query) {
        const found = searchLoreByQuery(ctx.loreChunks, query);
        if (found.length > 0) {
            toolResult = found.map(c => `### ${c.header}\n${c.content}`).join('\n\n');
        }
    }

    return { toolResult };
}

/**
 * Handles `update_scene_notebook` tool calls.
 * Returns the tool result string and mutated notebook — caller handles payload/message dispatch.
 */
export function handleNotebookTool(
    toolArguments: string,
    ctx: ToolContext
): NotebookHandlerResult {
    let notebookActions: { op: string; text?: string }[] = [];
    try { notebookActions = JSON.parse(toolArguments).actions || []; } catch { /* Ignore */ }

    const currentNotebook = [...(ctx.notebook ?? [])];
    let opsCount = 0;

    for (const action of notebookActions) {
        if (opsCount >= MAX_NOTEBOOK_OPS) break;
        if (action.op === 'add' && action.text && currentNotebook.length < MAX_NOTEBOOK_NOTES) {
            currentNotebook.push({ id: uid(), text: action.text.trim(), timestamp: Date.now() });
        } else if (action.op === 'remove' && action.text) {
            const searchLower = action.text.toLowerCase().trim();
            const idx = currentNotebook.findIndex(n => n.text.toLowerCase().includes(searchLower));
            if (idx !== -1) currentNotebook.splice(idx, 1);
        } else if (action.op === 'clear') {
            currentNotebook.length = 0;
        }
        opsCount++;
    }

    const toolResult = `Notebook updated. ${currentNotebook.length} notes active.`;
    console.log(`[Notebook] Updated: ${currentNotebook.length} notes active (${opsCount} ops)`);

    return { toolResult, updatedNotebook: currentNotebook };
}

const VALID_OPS = new Set<string>(['grant', 'remove', 'equip']);
const VALID_KINDS = new Set<string>(['weapon', 'armor', 'consumable', 'misc']);
const VALID_QUALITIES = new Set<string>(['common', 'uncommon', 'rare', 'epic', 'legendary']);
const VALID_SCALING_STATS = new Set<string>(['PWR', 'SPD', 'WIL']);
const VALID_RANGES = new Set<string>(['Close', 'Reach', 'Ranged']);

/**
 * Handles `propose_inventory_change` tool calls. Pure parsing + clamping — no LLM
 * call, no mutation. Returns a normalized {@link InventoryProposal} for the caller
 * to stage for user confirmation (the player must confirm before the delta applies).
 * Numeric weapon/armor stats (damageDice, bonus, AC) are intentionally NOT parsed —
 * the engine (Phase 7) owns all numbers; the GM only supplies bounded labels.
 */
export function handleProposeInventoryTool(
    toolArguments: string
): ProposeInventoryHandlerResult {
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(toolArguments); } catch { /* ignore */ }

    const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : 'Unknown Item';

    const rawOp = typeof args.op === 'string' ? args.op : '';
    const op: InventoryProposal['op'] = VALID_OPS.has(rawOp) ? (rawOp as InventoryProposal['op']) : 'grant';

    const rawKind = typeof args.kind === 'string' ? args.kind : '';
    const kind: InventoryProposal['kind'] = VALID_KINDS.has(rawKind) ? (rawKind as InventoryProposal['kind']) : 'misc';

    const rawQuality = typeof args.quality === 'string' ? args.quality : '';
    const quality: InventoryProposal['quality'] = VALID_QUALITIES.has(rawQuality) ? (rawQuality as InventoryProposal['quality']) : 'common';

    const rawScalingStat = typeof args.scalingStat === 'string' ? args.scalingStat : '';
    const scalingStat: InventoryProposal['scalingStat'] = VALID_SCALING_STATS.has(rawScalingStat) ? (rawScalingStat as InventoryProposal['scalingStat']) : 'PWR';

    const rawRange = typeof args.range === 'string' ? args.range : '';
    const range: InventoryProposal['range'] = VALID_RANGES.has(rawRange) ? (rawRange as InventoryProposal['range']) : 'Close';

    let properties: string[] = [];
    if (Array.isArray(args.properties)) {
        properties = args.properties.filter((p: unknown): p is string => typeof p === 'string').map(p => p.trim()).filter(Boolean);
    }

    const equip = typeof args.equip === 'boolean' ? args.equip : false;
    const description = typeof args.description === 'string' ? args.description : '';

    const proposal: InventoryProposal = { name, op, kind, quality, scalingStat, range, properties, equip, description };

    return {
        toolResult: JSON.stringify({ status: 'staged', name, op, kind, quality }),
        proposal,
    };
}

