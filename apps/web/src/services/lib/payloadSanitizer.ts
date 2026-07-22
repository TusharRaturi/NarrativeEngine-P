/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Strips invalid or disallowed tool-related messages from an OpenAI-format payload.
 *
 * Handles:
 * - Removes tool_calls from assistant messages when tools are disabled
 * - Removes assistant messages whose tool_calls are all invalid (no id / no function.name)
 * - Removes orphan tool messages (no matching open call_id in the assistant turn above)
 */
// Models that require reasoning_content to be echoed back on every assistant message that had tool_calls.
const THINKING_MODEL_RE = /deepseek-r|deepseek-v[34]|deepseek.*think|qwq|qwen.*think|r1/i;

import type { OpenAIMessage } from '../llm/llmService';

export const sanitizePayloadForApi = (rawPayload: unknown[], allowTools: boolean, modelName?: string, isGemini?: boolean): OpenAIMessage[] => {
    const isThinkingModel = modelName ? THINKING_MODEL_RE.test(modelName) : false;

    const cleaned: OpenAIMessage[] = [];
    const openToolCalls = new Set<string>();

    for (const rawMsg of rawPayload) {
        if (!rawMsg || typeof rawMsg !== 'object') continue;
        const msg = rawMsg as any;

        if (msg.role === 'assistant') {
            const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;

            if (isThinkingModel && hasToolCalls && !msg.reasoning_content) {
                console.warn('[Sanitizer] Thinking-model: stripping tool_calls from assistant missing reasoning_content — would cause 400. ids:', msg.tool_calls.map((tc: { id: string }) => tc.id));
                const stripped = { ...msg };
                delete stripped.tool_calls;
                cleaned.push(stripped as OpenAIMessage);
                continue;
            }

            if (isGemini && hasToolCalls) {
                const missingSignature = msg.tool_calls.some((tc: { thoughtSignature?: string }) => !tc?.thoughtSignature);
                if (missingSignature) {
                    const stripped = { ...msg };
                    delete stripped.tool_calls;
                    cleaned.push(stripped as OpenAIMessage);
                    continue;
                }
            }

            if (!allowTools || !hasToolCalls) {
                if (allowTools && Array.isArray(msg.tool_calls)) {
                    console.warn('[Payload] Stripped empty tool_calls from assistant message');
                } else if (!allowTools && hasToolCalls) {
                    console.warn('[Payload] Stripped tool_calls from assistant message (tools disabled)');
                }
                const assistantNoTools = { ...msg };
                delete assistantNoTools.tool_calls;
                cleaned.push(assistantNoTools as OpenAIMessage);
                continue;
            }

            const validCalls = msg.tool_calls.filter((tc: { type?: string, id?: string, function?: { name?: string, arguments?: string } }) => {
                if (!tc || tc.type !== 'function' || typeof tc.id !== 'string') return false;
                if (!tc.function || typeof tc.function.name !== 'string') return false;
                if (typeof tc.function.arguments === 'string' && tc.function.arguments.trim()) {
                    try { JSON.parse(tc.function.arguments); } catch {
                        console.warn('[Payload] Dropping tool_call with invalid JSON arguments:', tc.function.name, tc.id);
                        return false;
                    }
                }
                return true;
            });

            if (validCalls.length === 0) {
                console.warn('[Payload] All tool_calls invalid for assistant message, stripping', msg.tool_calls?.length, 'calls');
                const assistantNoTools = { ...msg };
                delete assistantNoTools.tool_calls;
                cleaned.push(assistantNoTools as OpenAIMessage);
                continue;
            }

            cleaned.push({ ...msg, tool_calls: validCalls } as OpenAIMessage);
            for (const tc of validCalls) openToolCalls.add(tc.id);
            continue;
        }

        if (msg.role === 'tool') {
            if (!allowTools) continue;

            const callId = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : '';
            if (!callId || !openToolCalls.has(callId)) {
                continue;
            }

            openToolCalls.delete(callId);
            cleaned.push(msg as OpenAIMessage);
            continue;
        }

        cleaned.push(msg as OpenAIMessage);
    }

    const resolvedCallIds = new Set(
        cleaned.filter(m => m.role === 'tool' && typeof m.tool_call_id === 'string')
               .map(m => m.tool_call_id as string)
    );
    const result = cleaned.map(msg => {
        const m = msg as any;
        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
            const resolved = m.tool_calls.filter((tc: { id: string }) => resolvedCallIds.has(tc.id));
            if (resolved.length !== m.tool_calls.length) {
                console.warn('[Payload] Stripping unresolved tool_calls from assistant message to prevent 400');
                const rest = { ...m };
                delete rest.tool_calls;
                return (resolved.length > 0 ? { ...rest, tool_calls: resolved } : rest) as OpenAIMessage;
            }
        }
        return msg;
    });

    return result;
};
