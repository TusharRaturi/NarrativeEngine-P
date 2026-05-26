import type { EndpointConfig, ProviderConfig, ArchiveIndexEntry } from '../types';
import { callLLM } from './callLLM';

export async function runArchivePlanner(
    provider: EndpointConfig | ProviderConfig,
    finalInput: string,
    candidateScenes: ArchiveIndexEntry[],
    timeoutMs: number,
    signal?: AbortSignal,
): Promise<string[]> {
    try {
        const candidateList = candidateScenes
            .filter(s => s.events && s.events.length > 0)
            .map(s => {
                const eventSummaries = s.events!.map(ev => 
                    `- [${ev.eventType}, imp:${ev.importance}] ${ev.text}`
                ).join('\n');
                return `Scene ${s.sceneId}:\n${eventSummaries}`;
            })
            .join('\n\n');

        if (!candidateList) return [];

        const prompt = `You are a TTRPG campaign retrieval ranker. 
Your goal is to look at the GM's current situation (the user query) and a list of candidate scenes with their structured event logs, and rank the candidate scene IDs based on how likely they are to be narrative-relevant or critical for consistency in the next turn.

GM CURRENT SITUATION:
"""
${finalInput}
"""

CANDIDATE SCENES WITH EVENT LOGS:
${candidateList}

OUTPUT FORMAT — respond with a single JSON array of zero-padded scene IDs (e.g., ["014", "012"]), ranked from most relevant to least relevant:
[
  "014",
  "012"
]

RULES:
1. Rank ONLY the scene IDs from the candidates above.
2. Return ONLY highly relevant scenes (max 5 scenes).
3. If no scenes are relevant, return an empty array [].
4. Output a single JSON array of strings only. No markdown formatting, no prose, no reasoning tags, no backticks.`;

        const abortSignal = signal
            ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
            : AbortSignal.timeout(timeoutMs);

        const raw = await callLLM(provider, prompt, {
            temperature: 0.1,
            priority: 'high',
            maxTokens: 300,
            signal: abortSignal,
        });

        let clean = raw.replace(/<think[\s\S]*?<\/think>/gi, '');
        const mdMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (mdMatch) clean = mdMatch[1];

        const bracketStart = clean.indexOf('[');
        const bracketEnd = clean.lastIndexOf(']');
        if (bracketStart === -1 || bracketEnd === -1) return [];

        const parsed = JSON.parse(clean.substring(bracketStart, bracketEnd + 1));
        if (Array.isArray(parsed) && parsed.every((x: unknown) => typeof x === 'string')) {
            console.log(`[ArchivePlanner] Ranked scene IDs from AI: [${parsed.join(', ')}]`);
            return parsed;
        }
        return [];
    } catch (err) {
        console.warn('[ArchivePlanner] Planner failed or timed out:', err);
        return [];
    }
}
