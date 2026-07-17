import type { EndpointConfig, ProviderConfig, NPCSignatureKit } from '../../types';
import type { OpenAIMessage } from '../llm/llmService';
import { sendMessage } from '../llm/llmService';
import { extractJson } from '../infrastructure/jsonExtract';

export const RETRY_SUFFIX = '\n\nIMPORTANT: Your previous response was not valid JSON. Respond with ONLY valid JSON. No markdown fences, no comments, no trailing commas, no extra text before or after the JSON.';

const KIT_MAX_ENTRIES = 4;
const KIT_ENTRY_MAXLEN = 48;
const KIT_ELEMENT_MAXLEN = 20;

function cleanEntries(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .map(x => String(x).replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .map(s => s.length > KIT_ENTRY_MAXLEN ? s.slice(0, KIT_ENTRY_MAXLEN).trim() : s)
        .slice(0, KIT_MAX_ENTRIES);
}

/**
 * Sanitize a raw signatureKit from the LLM into a bounded, safe kit.
 * - `mergeInto` (optional): shallow-merge onto an existing kit so a partial update
 *   ("gained a new sword") does not wipe the other channel. Arrays REPLACE per-channel
 *   when present (supersession); absent channels keep the existing value.
 * Returns undefined if the result is empty (nothing to store).
 */
export function sanitizeSignatureKit(
    raw: unknown,
    mergeInto?: NPCSignatureKit,
): NPCSignatureKit | undefined {
    if (!raw || typeof raw !== 'object') return mergeInto;
    const r = raw as Record<string, unknown>;
    const base: NPCSignatureKit = mergeInto
        ? { equipment: [...mergeInto.equipment], abilities: [...mergeInto.abilities], element: mergeInto.element }
        : { equipment: [], abilities: [] };

    if ('equipment' in r) base.equipment = cleanEntries(r.equipment);
    if ('abilities' in r) base.abilities = cleanEntries(r.abilities);
    if ('element' in r) {
        const el = String(r.element ?? '').replace(/\s+/g, ' ').trim();
        base.element = el ? el.slice(0, KIT_ELEMENT_MAXLEN) : undefined;
    }

    if (base.equipment.length === 0 && base.abilities.length === 0 && !base.element) return undefined;
    return base;
}

export async function sendMessageAndParseJson(
    provider: EndpointConfig | ProviderConfig,
    messages: OpenAIMessage[],
    contextLabel: string,
    trackingLabel?: string,
): Promise<{ parsed: any; rawStr: string }> {
    let fullJsonStr = '';

    await sendMessage(
        provider,
        messages,
        (chunk) => { fullJsonStr = chunk; },
        () => { },
        (err) => console.error(`[${contextLabel}] Stream error:`, err),
        undefined,
        undefined,
        undefined,
        undefined,
        trackingLabel,
    );

    if (!fullJsonStr) throw new Error(`[${contextLabel}] Empty response from LLM`);

    const cleanStr = extractJson(fullJsonStr);

    try {
        return { parsed: JSON.parse(cleanStr), rawStr: cleanStr };
    } catch (firstErr) {
        console.warn(`[${contextLabel}] First parse failed, retrying with stricter prompt...`, firstErr);
        console.warn(`[${contextLabel}] Raw JSON was:`, cleanStr);

        const retryMessages: OpenAIMessage[] = [
            ...messages,
            { role: 'assistant', content: fullJsonStr },
            { role: 'user', content: RETRY_SUFFIX }
        ];

        let retryStr = '';
        await sendMessage(
            provider,
            retryMessages,
            (chunk) => { retryStr = chunk; },
            () => { },
            (err) => console.error(`[${contextLabel}] Retry stream error:`, err),
            undefined,
            undefined,
            undefined,
            undefined,
            trackingLabel,
        );

        if (!retryStr) throw new Error(`[${contextLabel}] Empty retry response`);

        const retryClean = extractJson(retryStr);
        try {
            return { parsed: JSON.parse(retryClean), rawStr: retryClean };
        } catch (retryErr) {
            console.error(`[${contextLabel}] Retry parse also failed:`, retryErr);
            console.error(`[${contextLabel}] Retry raw JSON:`, retryClean);
            throw retryErr;
        }
    }
}
