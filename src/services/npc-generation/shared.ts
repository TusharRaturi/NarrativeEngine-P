import type { EndpointConfig, ProviderConfig } from '../../types';
import type { OpenAIMessage } from '../llm/llmService';
import { sendMessage } from '../llm/llmService';
import { extractJson } from '../infrastructure/jsonExtract';

export const RETRY_SUFFIX = '\n\nIMPORTANT: Your previous response was not valid JSON. Respond with ONLY valid JSON. No markdown fences, no comments, no trailing commas, no extra text before or after the JSON.';

export async function sendMessageAndParseJson(
    provider: EndpointConfig | ProviderConfig,
    messages: OpenAIMessage[],
    contextLabel: string
): Promise<{ parsed: any; rawStr: string }> {
    let fullJsonStr = '';

    await sendMessage(
        provider,
        messages,
        (chunk) => { fullJsonStr = chunk; },
        () => { },
        (err) => console.error(`[${contextLabel}] Stream error:`, err)
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
            (err) => console.error(`[${contextLabel}] Retry stream error:`, err)
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
