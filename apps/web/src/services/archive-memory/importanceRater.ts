import type { ChatMessage, ProviderConfig, EndpointConfig } from '../../types';
import { llmCall } from '../../utils/llmCall';
import { AI_CALL_TIMEOUT_MS } from '../llm/timeouts';

const IMPORTANCE_PROMPT = `Rate the narrative importance of the scene below on a 1-10 scale based on HOW THE NARRATIVE WOULD BREAK if the facts established here were forgotten.

CRITERIA:
1-2 — Trivial: Forgetting this would not break the narrative at all (e.g., passing greeting, mundane travel, minor purchases, small talk, minor spat).
3-4 — Minor: Forgetting this might cause minor confusion but no plot holes (e.g., atmospheric details, minor NPC introductions, routine conversation).
5-6 — Notable: Forgetting this would cause noticeable continuity errors (e.g., relationship shifts, new locations explored).
7-8 — Significant: Forgetting this would cause major plot holes (e.g., combat resolutions, major reveals, quest milestones).
9-10 — Critical: Catastrophic narrative breakage if forgotten (e.g., character death, major betrayal, world-changing events, irreversible consequences).

RULES:
- Output ONLY a single number (from 1 to 10), nothing else
- When uncertain, round DOWN (prefer lower importance)

RECENT CONTEXT:
{context}

SCENE TO RATE:
User: {userText}
GM: {gmText}`;

export async function rateImportance(
    provider: ProviderConfig | EndpointConfig,
    userText: string,
    gmText: string,
    recentMessages?: ChatMessage[],
): Promise<number> {
    const contextLines = recentMessages
        ?.slice(-4)
        .map(m => `[${m.role.toUpperCase()}]: ${m.content.slice(0, 200)}`)
        .join('\n') ?? '';

    const prompt = IMPORTANCE_PROMPT
        .replace('{context}', contextLines)
        .replace('{userText}', userText.slice(0, 600))
        .replace('{gmText}', gmText.slice(0, 1200));

    try {
        const raw = await llmCall(provider, prompt, { priority: 'low', trackingLabel: 'importance-rating', timeoutMs: AI_CALL_TIMEOUT_MS });
        const match = raw.trim().match(/\b([1-9]|10)\b/);
        if (match) return parseInt(match[1], 10);
    } catch (err) {
        console.warn('[ImportanceRater] LLM call failed, using fallback:', err);
    }
    return 1;
}
