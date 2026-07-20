import type { ProviderConfig, EndpointConfig, DivergenceEntry } from '../../types';
import { extractJson } from '../infrastructure/jsonExtract';
import { llmCall } from '../../utils/llmCall';
import { AI_CALL_TIMEOUT_MS } from '../llm/timeouts';
import { DIVERGENCE_CATEGORIES, CATEGORY_DEFINITIONS } from '../campaign-state/divergenceRegister';
import { uid } from '../../utils/uid';

export async function extractTurnDivergences(
    provider: ProviderConfig | EndpointConfig,
    userText: string,
    gmText: string,
    sceneId: string,
    chapterId: string,
    npcLedger: { id: string; name: string; aliases: string }[],
    importanceGate: number,
    messageId?: string
): Promise<DivergenceEntry[]> {
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

    const divergenceSlots = DIVERGENCE_CATEGORIES.filter(c => c !== 'misc').map(c =>
        `### ${c.toUpperCase()}\nDefinition: ${CATEGORY_DEFINITIONS[c]}\nOutput: JSON array for this slot, or [] if empty.`
    ).join('\n\n');

    const prompt = `You are a TTRPG campaign archivist. Extract established facts from the latest scene that would BREAK A FUTURE SCENE if the AI contradicted them.

Only extract facts that have a narrative importance of ${importanceGate} or higher on a 1-10 scale (where 1 is trivial and 10 is world-changing). If the scene is less important than this, or no major facts occurred, output empty arrays.

SCENE ID: ${sceneId}

NPC LEDGER (resolve names to IDs):
${npcList || '(no NPCs in ledger)'}

LATEST SCENE CONTENT:
User: ${userText}
GM: ${gmText}

OUTPUT FORMAT — a single JSON object with one key per category slot. Each value is an array of fact objects, or [] if empty. Example:
{
    "locations": [
        { "text": "Eastern gate destroyed by siege", "sceneRef": "${sceneId}", "npcIds": [], "knownBy": [], "unrecognizedNpcNames": [], "locations": ["Eastern Gate"], "items": [], "theme": "destruction" }
    ],
    "npc_events": [
        { "text": "Grak allied with the player", "sceneRef": "${sceneId}", "npcIds": ["npc_42"], "knownBy": ["npc_42"], "unrecognizedNpcNames": [], "locations": [], "items": [], "theme": "alliance" }
    ],
    "promises_debts": [],
    "world_state": [],
    "party_facts": [],
    "rules_lore": [],
    "misc": []
}

Category definitions:

${divergenceSlots}

### MISC
Definition: ${CATEGORY_DEFINITIONS.misc}
Output: JSON array for this slot, or [] if empty.

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
        return [];
    }

    const entries: DivergenceEntry[] = [];
    // The JSON output might wrap things in 'divergences', or it might be the top-level object
    const divObj = (parsed.divergences && typeof parsed.divergences === 'object') ? parsed.divergences as Record<string, unknown[]> : parsed as Record<string, unknown[]>;

    for (const category of DIVERGENCE_CATEGORIES) {
        const slotArr = divObj[category];
        if (!Array.isArray(slotArr)) continue;

        for (const item of slotArr) {
            if (!item || typeof item !== 'object') continue;
            const rawItem = item as Record<string, unknown>;
            const text = typeof rawItem.text === 'string' ? rawItem.text.trim() : '';
            if (!text) continue;

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

            entries.push({
                id: 'div_' + uid(),
                chapterId,
                category,
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
            });
        }
    }

    return entries;
}
