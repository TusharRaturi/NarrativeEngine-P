import type {
    LootTree,
    LootNode,
    LootPickNode,
    LootDrawSpec,
    LootPool,
    LootPoolEntry,
    LootItem,
    LootDropResult,
    ResolveLootOpts,
    LootProfile,
} from './types';

/**
 * Loot Engine — WO-02 walker (01_STRONG_types_contract.md §3).
 *
 * Pure data + dice. ZERO LLM at runtime. Deterministic under an injected `rng`.
 * Sibling of `engineRolls.ts`; `appendToInput` is the SAME shape the
 * orchestrator already concatenates for `rollEngines` / `resolveManualRoll`.
 *
 * The engine emits a BARE `[LOOT DROP: ...]` tag. The fact-assertion wrapper
 * ("this HAPPENED, narrate as fact…") is added by the orchestrator (WO-05),
 * NOT here — mirrors `resolveManualRoll` which also returns a bare tag and lets
 * the orchestrator do the wrapping.
 */

const MAX_STEPS = 32;

/**
 * Pick one option from a weights map by cumulative threshold. Weights need NOT
 * sum to 100 (engine normalizes). Options with weight <= 0 are excluded. If
 * every option is excluded/zero, returns null.
 *
 * Implemented locally rather than reusing `weightedRandomPick` (charIntroEngine)
 * because that one calls `Math.random` internally and doesn't take an injected
 * rng — the invariant here is that ALL randomness goes through `rng`.
 */
function pickOption(weights: Record<string, number>, rng: () => number): string | null {
    const options = Object.keys(weights).filter(k => typeof weights[k] === 'number' && weights[k] > 0);
    if (options.length === 0) return null;
    const total = options.reduce((sum, k) => sum + weights[k], 0);
    if (total <= 0) return null;
    let roll = rng() * total;
    for (const k of options) {
        roll -= weights[k];
        if (roll <= 0) return k;
    }
    return options[options.length - 1];
}

/** Draw one entry from a pool (flat list or filter-axis-keyed map). Returns null on empty/missing. */
function drawEntry(pool: LootPool | undefined, filterKey: string | undefined, rng: () => number): LootPoolEntry | null {
    if (!pool) return null;
    let entries: LootPoolEntry[];
    if (Array.isArray(pool)) {
        entries = pool;
    } else {
        // keyed map — pick the slice for filterKey (or empty if no match)
        entries = filterKey ? (pool[filterKey] ?? []) : [];
    }
    if (entries.length === 0) return null;
    const idx = Math.floor(rng() * entries.length);
    return entries[idx] ?? null;
}

/** Roll an integer in [min, max] inclusive via rng. */
function rollAmount(min: number, max: number, rng: () => number): number {
    const lo = Math.ceil(min);
    const hi = Math.floor(max);
    if (hi < lo) return lo;
    return lo + Math.floor(rng() * (hi - lo + 1));
}

/** Resolve a pool reference to a concrete LootPool from the tree. */
function resolvePool(tree: LootTree, spec: LootDrawSpec): LootPool | undefined {
    return tree.pools?.[spec.pool];
}

/** Fill `{key}` placeholders from bindings; missing keys drop the segment cleanly. */
function fillTemplate(template: string, bindings: Record<string, string>): string {
    return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
        const v = bindings[key];
        return v !== undefined && v !== '' ? v : '';
    }).replace(/\s+/g, ' ').trim();
}

/**
 * Auto-compose fallback (WO-01 §3.4): when a draw/amount node has no `next`,
 * join the present draw bindings in order. Explicit compose nodes override.
 *  - two draw bindings: "{a} of the {b}"
 *  - one draw binding:  "{a}"
 *  - amount:            "{n} {unit}"
 */
function autoComposeLabel(bindings: Record<string, string>, drawBindings: { as: string; text: string }[], amountBinding?: { unit: string; n: number }): string {
    if (amountBinding) {
        return `${amountBinding.n} ${amountBinding.unit}`.trim();
    }
    if (drawBindings.length >= 2) {
        return `${drawBindings[0].text} of the ${drawBindings[1].text}`.trim();
    }
    if (drawBindings.length === 1) {
        return drawBindings[0].text;
    }
    // Nothing bound — fall back to joining whatever non-empty bindings exist, in insertion order.
    const vals = Object.values(bindings).filter(v => v !== undefined && v !== '');
    return vals.join(' ').trim();
}

/**
 * Apply a profile's reweight to a pick node (shallow-merge: override listed
 * options, keep the rest; an option set to 0 is excluded by pickOption).
 * The reweight map is keyed by LootNodeId (WO-01 §2), e.g. { root: { scroll: 0 } }.
 */
function applyReweight(nodeId: string, node: LootPickNode, profile: LootProfile | undefined): Record<string, number> {
    if (!profile?.reweight) return node.weights;
    const override = profile.reweight[nodeId];
    if (!override) return node.weights;
    return { ...node.weights, ...override };
}

/**
 * Walk the loot tree once, producing a single LootItem. Caps at MAX_STEPS node
 * visits per item to guard against hand-authored cycles.
 */
function walkOnce(tree: LootTree, opts: ResolveLootOpts, rng: () => number): { item: LootItem | null; trace: string[] } {
    const trace: string[] = [];
    const bindings: Record<string, string> = {};
    const drawBindings: { as: string; text: string }[] = [];
    let amountBinding: { unit: string; n: number } | undefined;
    let cursor: string | undefined = opts.profile?.entryNode ?? tree.root;
    let steps = 0;

    while (cursor && steps < MAX_STEPS) {
        steps++;
        const node: LootNode | undefined = tree.nodes[cursor];
        if (!node) {
            trace.push(`${cursor} (missing node — stop)`);
            break;
        }

        if (node.kind === 'pick') {
            const weights = applyReweight(cursor, node, opts.profile);
            const option = pickOption(weights, rng);
            if (!option) {
                trace.push(`${cursor}/pick[${node.axis}] (no eligible options — stop)`);
                break;
            }
            bindings[node.axis] = option;
            trace.push(`${cursor}/pick[${node.axis}]→${option}`);
            cursor = node.branches[option];
            if (cursor === undefined) {
                // Missing branch → stop, compose what we have (WO-01 §3.3).
                break;
            }
            continue;
        }

        if (node.kind === 'draw') {
            trace.push(`${cursor}/draw`);
            for (const spec of node.draws) {
                const filterKey = spec.filterBy ? bindings[spec.filterBy] : undefined;
                const pool = resolvePool(tree, spec);
                const entry = drawEntry(pool, filterKey, rng);
                if (entry) {
                    bindings[spec.as] = entry.text;
                    drawBindings.push({ as: spec.as, text: entry.text });
                    trace.push(`  ${spec.pool}${filterKey ? `[${filterKey}]` : ''}→${entry.text}`);
                } else {
                    trace.push(`  ${spec.pool}${filterKey ? `[${filterKey}]` : ''}→(empty)`);
                }
            }
            cursor = node.next;
            if (cursor === undefined) {
                // Auto-compose fallback.
                const label = autoComposeLabel(bindings, drawBindings, amountBinding);
                return { item: { label, parts: { ...bindings } }, trace };
            }
            continue;
        }

        if (node.kind === 'amount') {
            const n = rollAmount(node.min, node.max, rng);
            bindings[node.unit] = String(n);
            amountBinding = { unit: node.unit, n };
            trace.push(`${cursor}/amount[${node.unit}]→${n}`);
            cursor = node.next;
            if (cursor === undefined) {
                const label = autoComposeLabel(bindings, drawBindings, amountBinding);
                return { item: { label, parts: { ...bindings } }, trace };
            }
            continue;
        }

        if (node.kind === 'compose') {
            trace.push(`${cursor}/compose`);
            const label = fillTemplate(node.template, bindings);
            return { item: { label, parts: { ...bindings } }, trace };
        }

        // Unknown node kind — defensive; treat as terminal.
        trace.push(`${cursor} (unknown kind — stop)`);
        break;
    }

    if (steps >= MAX_STEPS) {
        trace.push(`(MAX_STEPS=${MAX_STEPS} hit — composing what's bound)`);
    }
    const label = autoComposeLabel(bindings, drawBindings, amountBinding);
    return { item: { label, parts: { ...bindings } }, trace };
}

/**
 * Resolve a player-triggered loot drop. Walks the world-declared loot tree
 * `rolls` times and composes one `[LOOT DROP: ...]` tag for the GM turn.
 *
 * Returns a BARE tag — the orchestrator (WO-05) adds the fact-assertion wrapper,
 * exactly as it does for `resolveManualRoll`. Do NOT bake narration instructions
 * into the engine output.
 */
export function resolveLootDrop(tree: LootTree, opts?: ResolveLootOpts): LootDropResult {
    const rng = opts?.rng ?? Math.random;
    let rolls = opts?.rolls;
    if (rolls === undefined || rolls < 1) {
        rolls = 1;
    }

    const items: LootItem[] = [];
    const trace: string[] = [];

    for (let i = 0; i < rolls; i++) {
        trace.push(`— item ${i + 1} —`);
        const { item, trace: itemTrace } = walkOnce(tree, opts ?? {}, rng);
        if (item && item.label) {
            items.push(item);
        }
        for (const t of itemTrace) trace.push(t);
    }

    const appendToInput = items.length > 0
        ? `\n[LOOT DROP: ${items.map(i => i.label).join(', ')}]`
        : '';

    return { appendToInput, items, trace };
}
