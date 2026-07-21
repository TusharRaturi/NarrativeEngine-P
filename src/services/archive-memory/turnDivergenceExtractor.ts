import type { ProviderConfig, EndpointConfig, DivergenceEntry } from '../../types';
import { extractJson } from '../infrastructure/jsonExtract';
import { llmCall } from '../../utils/llmCall';
import { AI_CALL_TIMEOUT_MS } from '../llm/timeouts';
import { DIVERGENCE_CATEGORIES, CATEGORY_DEFINITIONS, coerceCategory } from '../campaign-state/divergenceRegister';
import type { ExtractedDivergences } from '../campaign-state/divergenceRegister';
import { uid } from '../../utils/uid';
import { extractContextEntities } from '../retrieval/semanticMemory';

export async function extractTurnDivergences(
    provider: ProviderConfig | EndpointConfig,
    userText: string,
    gmText: string,
    sceneId: string,
    chapterId: string,
    npcLedger: { id: string; name: string; aliases: string }[],
    importanceGate: number,
    activeDivergences: DivergenceEntry[],
    messageId?: string
): Promise<ExtractedDivergences> {
    const npcList = npcLedger.map(n =>
        `- ${n.name} (id: ${n.id}${n.aliases ? ', also known as: ' + n.aliases : ''})`
    ).join('\n');

    const npcNameMap = new Map<string, string>();
    for (const npc of npcLedger) {
        npcNameMap.set(npc.name.toLowerCase(), npc.id);
        if (npc.aliases) {
            for (const alias of npc.aliases.split(',')) {
                npcNameMap.set(alias.trim().toLowerCase(), npc.id);
            }
        }
    }

    const entities = extractContextEntities(userText + '\n' + gmText, [], npcLedger.map(n => ({ id: n.id, name: n.name, aliases: n.aliases, tags: [], summary: '' })) as unknown as import('../../types').NPCEntry[]);
    const scoredDivergences = activeDivergences.map(div => {
        let score = 0;
        const textLower = div.text.toLowerCase();
        for (const entity of entities) {
            if (textLower.includes(entity)) score += 1;
        }
        return { div, score };
    });
    const relevantFacts = scoredDivergences
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 20)
        .map(s => s.div);

    const relevantFactsText = relevantFacts.length > 0 
        ? relevantFacts.map(f => `[ID: ${f.id}] [Category: ${f.category}] ${f.text}`).join('\n')
        : '(no relevant historical facts)';

    const divergenceSlots = DIVERGENCE_CATEGORIES.filter(c => c !== 'misc').map(c =>
        `### ${c.toUpperCase()}\nDefinition: ${CATEGORY_DEFINITIONS[c]}`
    ).join('\n\n');

    const prompt = `You are a TTRPG campaign archivist. Extract established facts from the latest scene that would BREAK A FUTURE SCENE if the AI contradicted them.

Extract NEW facts only if their narrative importance is ${importanceGate} or higher on a 1-10 scale (where 1 is trivial and 10 is world-changing).
However, if an event in the scene contradicts, resolves, or updates one of the CURRENT RELEVANT FACTS provided below, you MUST extract it as an updated_fact or invalidated_fact, regardless of its standalone importance.

SCENE ID: ${sceneId}

NPC LEDGER (resolve names to IDs):
${npcList || '(no NPCs in ledger)'}

CURRENT RELEVANT FACTS:
${relevantFactsText}

LATEST SCENE CONTENT:
User: ${userText}
GM: ${gmText}

OUTPUT FORMAT — a single JSON object with three keys: new_facts, updated_facts, and invalidated_facts.
{
    "new_facts": {
        "locations": [
            { "text": "Eastern gate destroyed by siege", "sceneRef": "${sceneId}", "npcIds": [], "knownBy": [], "unrecognizedNpcNames": [], "locations": ["Eastern Gate"], "items": [], "theme": "destruction" }
        ],
        "npc_events": [],
        "promises_debts": [],
        "world_state": [],
        "party_facts": [],
        "rules_lore": [],
        "misc": []
    },
    "updated_facts": [
        {
            "target_fact_id": "div_abc123",
            "new_fact": { "category": "npc_events", "text": "Grak is now hostile", "sceneRef": "${sceneId}", "npcIds": ["npc_42"], "knownBy": [], "unrecognizedNpcNames": [], "locations": [], "items": [], "theme": "hostility" }
        }
    ],
    "invalidated_facts": ["div_xyz987"]
}

Category definitions for 'new_facts' slots and the 'category' field in updated facts:
${divergenceSlots}

### MISC
Definition: ${CATEGORY_DEFINITIONS.misc}

DIVERGENCE EXTRACTION RULES:
- Each fact is ONE SHORT SENTENCE, max 15 words. No compound sentences, no explanations.
- sceneRef must be: ${sceneId}
- npcIds: list the NPC ledger IDs mentioned. If a name appears that is NOT in the ledger, put it in unrecognizedNpcNames instead.
- knownBy: list the NPC ledger IDs of witnesses who SAW or PARTICIPATED in this event. Only include NPCs who were present when the fact happened. Omit this field for rules_lore and locations (those are broadcast knowledge). If unsure, omit knownBy.
- locations: list specific, named places where this fact occurred or that are mentioned. Format in Title Case with spaces (e.g. "Eastern Gate", "Lower Ward"). Omit prefixes like "The" (e.g. "Sunken Warren"). DO NOT include minor sub-rooms or generic areas. Empty array if none.
- items: list specific, named objects or artifacts mentioned (e.g. "amulet_of_fire"). Empty array if none.
- theme: provide exactly ONE descriptive lowercase word categorizing the fact (e.g. "combat", "betrayal", "discovery").
- DO NOT include NPC names in the 'locations', 'items', or 'theme' fields.
- Focus on: permanent changes, new information, relationship shifts, acquisitions, losses, oaths, regime changes.
- Skip transient details, emotional narration, momentary states, and anything the archive would already surface.
- If a slot is empty, output [] for that slot.

Respond with valid JSON only.`;

    const raw = await llmCall(provider, prompt, { priority: 'low', trackingLabel: 'turn-divergence-extract', timeoutMs: AI_CALL_TIMEOUT_MS });
    const cleaned = extractJson(raw);
    
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(cleaned);
    } catch {
        console.warn('[TurnDivergenceExtractor] JSON parse failed', cleaned);
        return { newEntries: [], updates: [], invalidations: [] };
    }

    const result: ExtractedDivergences = { newEntries: [], updates: [], invalidations: [] };

    const parseFactItem = (item: unknown, forceCategory?: string): DivergenceEntry | null => {
        if (!item || typeof item !== 'object') return null;
        const rawItem = item as Record<string, unknown>;
        const text = typeof rawItem.text === 'string' ? rawItem.text.trim() : '';
        if (!text) return null;

        const sceneRef = typeof rawItem.sceneRef === 'string' ? rawItem.sceneRef : sceneId;
        const rawNpcIds: string[] = Array.isArray(rawItem.npcIds) ? rawItem.npcIds.filter((id): id is string => typeof id === 'string') : [];
        const resolvedNpcIds: string[] = [];
        const unrecognized: string[] = Array.isArray(rawItem.unrecognizedNpcNames)
            ? rawItem.unrecognizedNpcNames.filter((n): n is string => typeof n === 'string')
            : [];

        for (const id of rawNpcIds) {
            if (npcLedger.some(n => n.id === id)) {
                resolvedNpcIds.push(id);
            } else {
                unrecognized.push(id);
            }
        }

        const stillUnrecognized: string[] = [];
        for (const name of unrecognized) {
            const matched = npcNameMap.get(name.toLowerCase());
            if (matched && !resolvedNpcIds.includes(matched)) {
                resolvedNpcIds.push(matched);
            } else {
                stillUnrecognized.push(name);
            }
        }

        let knownBy: string[] | undefined = undefined;
        if (Array.isArray(rawItem.knownBy)) {
            knownBy = rawItem.knownBy.filter((k): k is string => typeof k === 'string');
        }

        const locations: string[] | undefined = Array.isArray(rawItem.locations) && rawItem.locations.length > 0 
            ? rawItem.locations.filter((l): l is string => typeof l === 'string') 
            : undefined;
            
        const items: string[] | undefined = Array.isArray(rawItem.items) && rawItem.items.length > 0
            ? rawItem.items.filter((i): i is string => typeof i === 'string')
            : undefined;
            
        const theme: string | undefined = typeof rawItem.theme === 'string' && rawItem.theme.trim() !== ''
            ? rawItem.theme.trim()
            : undefined;

        const category = forceCategory || (typeof rawItem.category === 'string' ? coerceCategory(rawItem.category) : 'misc');

        return {
            id: 'div_' + uid(),
            chapterId,
            category: category as ExtractedDivergences['newEntries'][0]['category'],
            text,
            sceneRef,
            npcIds: resolvedNpcIds,
            knownBy,
            pinned: false,
            source: 'auto',
            unrecognizedNpcNames: stillUnrecognized.length > 0 ? stillUnrecognized : undefined,
            reviewFlag: stillUnrecognized.length > 0 ? true : undefined,
            messageId,
            locations,
            items,
            theme,
            isActive: true
        };
    };

    if (parsed.new_facts && typeof parsed.new_facts === 'object') {
        for (const category of DIVERGENCE_CATEGORIES) {
            const slotArr = (parsed.new_facts as Record<string, unknown>)[category];
            if (!Array.isArray(slotArr)) continue;
            for (const item of slotArr) {
                const fact = parseFactItem(item, category);
                if (fact) result.newEntries.push(fact);
            }
        }
    }

    if (Array.isArray(parsed.updated_facts)) {
        for (const update of parsed.updated_facts) {
            if (!update || typeof update !== 'object') continue;
            const targetId = update.target_fact_id;
            if (typeof targetId !== 'string') continue;
            const fact = parseFactItem(update.new_fact);
            if (fact) {
                result.updates.push({ targetId, newEntry: fact });
            }
        }
    }

    if (Array.isArray(parsed.invalidated_facts)) {
        for (const inv of parsed.invalidated_facts) {
            if (typeof inv === 'string') {
                result.invalidations.push(inv);
            }
        }
    }

    return result;
}
