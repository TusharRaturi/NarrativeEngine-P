import type { DivergenceRegister, TopicClusters, TopicCluster, EndpointConfig, ProviderConfig } from '../types';
import { llmCall } from '../utils/llmCall';
import { countTokens } from './tokenizer';

/**
 * Robustly extract a JSON object from a potentially truncated LLM response.
 * Handles cut-off JSON by closing any open structure before parsing.
 */
function extractJsonRobust(raw: string): { groups: Array<{ name: string; factIds: string[] }> } {
    let clean = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
    const mdMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (mdMatch) clean = mdMatch[1];

    const start = clean.indexOf('{');
    if (start === -1) throw new Error('No JSON object found in response');

    let text = clean.slice(start);

    try {
        return JSON.parse(text);
    } catch {
        // Truncated response — recover by finding last complete group object
        let depth = 0;
        let inString = false;
        let escape = false;
        let lastCompleteGroupEnd = -1;

        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (escape) { escape = false; continue; }
            if (ch === '\\' && inString) { escape = true; continue; }
            if (ch === '"') { inString = !inString; continue; }
            if (inString) continue;
            if (ch === '{' || ch === '[') depth++;
            if (ch === '}' || ch === ']') {
                depth--;
                if (depth === 2) lastCompleteGroupEnd = i;
            }
        }

        if (lastCompleteGroupEnd > 0) {
            text = text.slice(0, lastCompleteGroupEnd + 1) + ']}';
            try {
                return JSON.parse(text);
            } catch { /* fall through */ }
        }

        throw new Error('Response was truncated and could not be recovered. Try a model with a larger output limit.');
    }
}

export type ClusteringCancelled = { cancelled: boolean };

export async function runFactClustering(
    register: DivergenceRegister,
    utilityProvider: EndpointConfig | ProviderConfig,
    contextLimit: number = 8192,
    cancel: ClusteringCancelled = { cancelled: false },
    onStatus: (msg: string) => void = () => {},
): Promise<TopicClusters> {
    const entries = register.entries;
    if (entries.length === 0) {
        return { groups: [], generatedAt: new Date().toISOString(), generatedFromFactCount: 0 };
    }

    const textLimit = entries.length > 150 ? 80 : 120;
    const factLines = entries
        .map(e => `${e.id}|${e.chapterId}|${e.text.slice(0, textLimit)}`)
        .join('\n');

    const prompt = `You are organizing campaign facts for a TTRPG. Group the facts below by recurring entity or theme — a specific NPC, a location, an ongoing storyline, a faction, or a concept that appears across multiple facts.

FACTS (id|chapter|text):
${factLines}

RULES:
- Each fact must appear in exactly one group.
- Aim for 8–20 groups. Prefer specific names (e.g. "Yuki", "The Bridge District") over generic labels.
- IMPORTANT: Include ALL ${entries.length} fact IDs across your groups — do not omit any.
- Return ONLY valid complete JSON, no prose, no truncation:
{"groups":[{"name":"Yuki","factIds":["id1","id2"]},{"name":"Reaper Contract","factIds":["id3"]}]}`;

    const promptTokens = countTokens(prompt);
    const maxTokens = Math.floor(contextLimit * 0.75);

    const modelName = (utilityProvider as EndpointConfig).modelName || utilityProvider.endpoint;
    console.log(
        `[FactClusterer] ${entries.length} facts · prompt: ${promptTokens} tkns · maxResponse: ${maxTokens} tkns · model: ${modelName}`
    );
    onStatus(`Sending ${promptTokens.toLocaleString()} tokens to model…`);

    const raw = await llmCall(utilityProvider, prompt, {
        temperature: 0.2,
        maxTokens,
        // 24 h sentinel — native readTimeout is 600 s; this just keeps the tracker alive.
        // Real "stop" is the cancel flag checked after the call.
        timeoutMs: 24 * 60 * 60 * 1000,
        trackingLabel: 'fact-clusterer',
    });

    if (cancel.cancelled) throw new Error('Clustering cancelled.');

    onStatus(`Parsing response (${raw.length.toLocaleString()} chars)…`);
    console.log(`[FactClusterer] Response: ${raw.length} chars`);

    const parsed = extractJsonRobust(raw);

    if (!Array.isArray(parsed.groups)) {
        throw new Error('AI response missing "groups" array.');
    }

    const knownIds = new Set(entries.map(e => e.id));
    const assignedIds = new Set<string>();

    const groups: TopicCluster[] = parsed.groups
        .filter(g => g.name && Array.isArray(g.factIds))
        .map((g, i) => {
            const validIds = g.factIds.filter(id => knownIds.has(id) && !assignedIds.has(id));
            validIds.forEach(id => assignedIds.add(id));
            return {
                id: `cluster-${i}-${g.name.toLowerCase().replace(/\s+/g, '-').slice(0, 20)}`,
                name: g.name,
                factIds: validIds,
            };
        })
        .filter(g => g.factIds.length > 0);

    // Any facts the AI omitted → Uncategorized
    const unassigned = entries.map(e => e.id).filter(id => !assignedIds.has(id));
    if (unassigned.length > 0) {
        groups.push({
            id: 'cluster-uncategorized',
            name: 'Uncategorized',
            factIds: unassigned,
        });
    }

    const result: TopicClusters = {
        groups,
        generatedAt: new Date().toISOString(),
        generatedFromFactCount: entries.length,
    };

    console.log(`[FactClusterer] Done — ${groups.length} groups, ${assignedIds.size} assigned, ${unassigned.length} uncategorized`);
    return result;
}
