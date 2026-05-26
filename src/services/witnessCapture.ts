import type { NPCEntry, EndpointConfig } from '../types';
import { callLLM } from './callLLM';
import { extractJson } from './payloadBuilder';

export function extractNpcIdsFromBody(text: string, npcLedger: NPCEntry[]): string[] {
    const lower = text.toLowerCase();
    return npcLedger
        .filter(npc => {
            if (!npc.name) return false;
            const patterns = [npc.name.toLowerCase()];
            if (npc.aliases) {
                npc.aliases.split(',').map(a => a.trim().toLowerCase()).filter(Boolean)
                    .forEach(a => patterns.push(a));
            }
            return patterns.some(p => {
                const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                return new RegExp('\\b' + escaped + '\\b', 'i').test(lower);
            });
        })
        .map(npc => npc.id);
}

export async function auxWitnessFallback(
    gmText: string,
    npcLedger: NPCEntry[],
    provider: EndpointConfig
): Promise<string[]> {
    const npcList = npcLedger.map(n => `- ${n.name} (id: ${n.id})`).join('\n');
    const prompt = `You are a system that analyzes text to identify which NPCs are present in a scene. Return ONLY a JSON array of NPC IDs.

Given this scene narration, which NPCs from the list below are physically present?

NARRATION:
${gmText.slice(0, 2000)}

NPC LIST:
${npcList}

Return a JSON array of NPC IDs only: ["id1", "id2"]`;

    try {
        const response = await callLLM(provider, prompt, { temperature: 0, maxTokens: 200, priority: 'low' as const });

        const jsonStr = extractJson(response);
        const ids = JSON.parse(jsonStr);
        return Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : [];
    } catch {
        console.warn('[WitnessCapture] auxWitnessFallback failed, returning empty');
        return [];
    }
}