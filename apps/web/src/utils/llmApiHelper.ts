import type { EndpointConfig, ProviderConfig, ApiFormat, SamplingConfig, ThinkingEffort } from '../types';

type AnyProvider = EndpointConfig | ProviderConfig;

type ClaudeSystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

// WO-09c: local content-block type for Claude text/tool_use/tool_result blocks
// carrying an optional cache_control marker. Kept local so unrelated public
// types are not widened.
type ClaudeContentBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
    | { type: 'tool_use'; id: string; name: string; input: unknown; cache_control?: { type: 'ephemeral' } }
    | { type: 'tool_result'; tool_use_id: string; content: string; cache_control?: { type: 'ephemeral' } };

const OPENAI_EFFORT_MAP: Record<ThinkingEffort, string | undefined> = {
    off: undefined, low: 'low', medium: 'medium', high: 'high', max: 'high'
};
const DEEPSEEK_EFFORT_MAP: Record<ThinkingEffort, string | undefined> = {
    off: undefined, low: 'low', medium: 'medium', high: 'high', max: 'high'
};
const CLAUDE_BUDGET_MAP: Record<ThinkingEffort, number | undefined> = {
    off: undefined, low: 1024, medium: 4096, high: 8192, max: 16384
};
const GEMINI_LEVEL_MAP: Record<ThinkingEffort, number | undefined> = {
    off: undefined, low: 512, medium: 2048, high: 4096, max: 8192
};

export function getApiFormat(provider: AnyProvider): ApiFormat {
    return (provider as EndpointConfig).apiFormat || 'openai';
}

function isBareHost(url: string): boolean {
    try {
        return new URL(url).pathname.replace(/\/+$/, '') === '';
    } catch {
        const pathPart = url.replace(/^https?:\/\/[^/]+/, '').replace(/\/+$/, '');
        return pathPart === '';
    }
}

export function detectFormatFromEndpoint(endpoint: string): ApiFormat | null {
    try {
        const { hostname } = new URL(endpoint);
        if (hostname.includes('api.anthropic.com')) return 'claude';
        if (hostname.includes('generativelanguage.googleapis.com')) return 'gemini';
        if (/^(localhost|127\.0\.0\.1):11434$/.test(hostname)) return 'ollama';
    } catch { /* invalid URL */ }
    return null;
}

/** Gemini Enterprise / Vertex AI OpenAI-compatible endpoints expose chat/completions, not GET /models. */
export function isVertexOpenAiEndpoint(endpoint: string): boolean {
    try {
        const normalized = endpoint.toLowerCase();
        return normalized.includes('aiplatform.googleapis.com') && normalized.includes('/endpoints/openapi');
    } catch {
        return false;
    }
}

/** Native Vertex AI endpoints (not OpenAI-compatible proxy) */
export function isVertexNativeEndpoint(endpoint: string): boolean {
    return endpoint.toLowerCase().includes('aiplatform.googleapis.com') && !isVertexOpenAiEndpoint(endpoint);
}

export function isGeminiFamilyModel(provider: AnyProvider): boolean {
    return /gemini|gemma|nano banana/i.test(provider.modelName || '');
}

export function getBaseUrl(provider: AnyProvider): string {
    let base = provider.endpoint.replace(/\/+$/, '');
    const format = getApiFormat(provider);
    if ((format === 'openai' || format === 'claude') && isBareHost(base)) {
        base += '/v1';
    }
    return base;
}

export function getChatUrl(provider: AnyProvider, options?: { stream?: boolean }): string {
    const base = getBaseUrl(provider);
    const format = getApiFormat(provider);
    if (format === 'ollama') return `${base}/api/chat`;
    if (format === 'claude') return `${base}/messages`;
    if (format === 'gemini') {
        const stream = options?.stream ?? false;
        const model = provider.modelName;
        return stream
            ? `${base}/models/${model}:streamGenerateContent?alt=sse`
            : `${base}/models/${model}:generateContent`;
    }
    return `${base}/chat/completions`;
}

export function getModelsUrl(provider: AnyProvider): string {
    const base = getBaseUrl(provider);
    const format = getApiFormat(provider);
    if (format === 'ollama') return `${base}/api/tags`;
    if (format === 'gemini') return `${base}/models`;
    if (format === 'claude') return `${base}/models`;
    return `${base}/models`;
}

export function buildChatHeaders(provider: AnyProvider): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const format = getApiFormat(provider);
    if (format === 'claude') {
        if (provider.apiKey) {
            headers['x-api-key'] = provider.apiKey;
            headers['anthropic-version'] = '2023-06-01';
        }
    } else if (format === 'gemini' && !isVertexNativeEndpoint(provider.endpoint)) {
        // Gemini AI Studio auth goes in URL param, not headers.
        // Vertex AI native Gemini auth expects standard Bearer token.
    } else if (provider.apiKey) {
        headers['Authorization'] = `Bearer ${provider.apiKey}`;
    }
    return headers;
}

function transformClaudeMessages(messages: { role: string; content: string | null; name?: string; tool_calls?: unknown[]; tool_call_id?: string; reasoning_content?: string; cache_control?: { type: 'ephemeral' } }[]): { system?: string | ClaudeSystemBlock[]; messages: { role: string; content: string | ClaudeContentBlock[] }[] } {
    const systemBlocks: { text: string; cache_control?: { type: 'ephemeral' } }[] = [];
    const transformed: { role: string; content: string | ClaudeContentBlock[] }[] = [];

    for (const m of messages) {
        if (m.role === 'system') {
            systemBlocks.push({ text: m.content || '', ...(m.cache_control ? { cache_control: m.cache_control } : {}) });
            continue;
        }

        if (m.role === 'assistant') {
            const tc = (m as { tool_calls?: { id: string; function: { name: string; arguments: string } }[] }).tool_calls;
            if (tc && tc.length > 0) {
                // WO-09c: when the assistant message carries cache_control, the
                // breakpoint covers the COMPLETE message — put the marker on the
                // FINAL emitted content block only, so the breakpoint includes all
                // text and tool_use blocks. Do not duplicate the marker across blocks.
                const content: ClaudeContentBlock[] = [];
                if (m.content) content.push({ type: 'text', text: m.content });
                for (const t of tc) {
                    let input: unknown = {};
                    try { input = JSON.parse(t.function.arguments); } catch { input = { _raw: t.function.arguments }; }
                    content.push({ type: 'tool_use', id: t.id, name: t.function.name, input });
                }
                if (m.cache_control && content.length > 0) {
                    const lastBlock = content[content.length - 1];
                    (lastBlock as { cache_control?: { type: 'ephemeral' } }).cache_control = m.cache_control;
                }
                transformed.push({ role: 'assistant', content });
            } else {
                // WO-09c: a stamped plain assistant message emits as a single text
                // content block carrying the marker. An unstamped assistant message
                // retains the current plain-string representation.
                if (m.cache_control) {
                    transformed.push({
                        role: 'assistant',
                        content: [{ type: 'text', text: m.content || '', cache_control: m.cache_control }],
                    });
                } else {
                    transformed.push({ role: 'assistant', content: m.content || '' });
                }
            }
            continue;
        }

        if (m.role === 'tool') {
            // WO-09c: tool-role history messages are not stamped by payloadBuilder
            // (WO-09c §1 corrects the prior wording — tool-role stamping was not
            // authorized, not that the type cannot carry the marker). The tool
            // transformation is unchanged.
            transformed.push({
                role: 'user',
                content: [{
                    type: 'tool_result',
                    tool_use_id: (m as { tool_call_id?: string }).tool_call_id || '',
                    content: m.content || '',
                }],
            });
            continue;
        }

        // WO-09c: a stamped `user` message (non-tool) emits as a single text
        // content block carrying the marker. An unstamped user message retains
        // the current plain-string representation. The final volatile user
        // message has no marker in the assembled payload, so it stays plain.
        if (m.cache_control) {
            transformed.push({
                role: m.role,
                content: [{ type: 'text', text: m.content || '', cache_control: m.cache_control }],
            });
        } else {
            transformed.push({ role: m.role, content: m.content || '' });
        }
    }

    const result: { system?: string | ClaudeSystemBlock[]; messages: { role: string; content: string | ClaudeContentBlock[] }[] } = { messages: transformed };
    if (systemBlocks.length > 0) {
        const hasCacheControl = systemBlocks.some(b => b.cache_control);
        if (hasCacheControl) {
            result.system = systemBlocks.map(b => ({
                type: 'text' as const,
                text: b.text,
                ...(b.cache_control ? { cache_control: b.cache_control } : {}),
            }));
        } else {
            result.system = systemBlocks.map(b => b.text).join('\n\n');
        }
    }
    return result;
}

function transformGeminiMessages(messages: { role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string; name?: string; reasoning_content?: string; cache_control?: { type: 'ephemeral' } }[]): { systemInstruction?: { parts: { text: string }[] }; contents: { role: string; parts: unknown[] }[] } {
  const systemParts: string[] = [];
  const contents: { role: string; parts: unknown[] }[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(m.content || '');
      continue;
    }
    if (m.role === 'assistant') {
      const tc = (m as { tool_calls?: { id: string; function: { name: string; arguments: string }; thoughtSignature?: string }[] }).tool_calls;
      const parts: unknown[] = [];
      if (m.content) parts.push({ text: m.content });
      if (tc && tc.length > 0) {
        for (const t of tc) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(t.function.arguments); } catch { args = { _raw: t.function.arguments }; }
          const part: Record<string, unknown> = { functionCall: { name: t.function.name, args } };
          // Must echo back the exact signature Gemini issued for this call, or the
          // next request 400s with "Function call is missing a thought_signature".
          if (t.thoughtSignature) {
            part.thought_signature = t.thoughtSignature;
          } else {
            // Last-resort escape hatch documented by Google for functionCall parts
            // that have no real signature (legacy history saved before signature
            // capture, or history migrated from a non-Gemini model). The validator
            // accepts the literal string 'skip_thought_signature_validator'. This
            // degrades model performance per Google's docs, so it is intentionally
            // only a fallback — new turns captured via extractStreamThoughtSignature
            // (see llmService.ts) carry a real signature and never hit this branch.
            // Ref: https://ai.google.dev/gemini-api/docs/thought-signatures
            part.thought_signature = 'skip_thought_signature_validator';
          }
          parts.push(part);
        }
      }
      contents.push({ role: 'model', parts });
      continue;
    }
    if (m.role === 'tool') {
      const fName = m.name || '';
      contents.push({
        role: 'function',
        parts: [{ functionResponse: { name: fName, response: { content: m.content || '' } } }],
      });
      continue;
    }
    contents.push({ role: m.role, parts: [{ text: m.content || '' }] });
  }
  const result: { systemInstruction?: { parts: { text: string }[] }; contents: { role: string; parts: unknown[] }[] } = { contents };
  if (systemParts.length > 0) result.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] };
  return result;
}

function transformGeminiTools(tools: unknown[]): unknown[] {
    const openaiTools = tools as { type: string; function: { name: string; description: string; parameters: unknown } }[];
    const declarations = openaiTools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
    }));
    return [{ functionDeclarations: declarations }];
}

export function buildChatBody(
    provider: AnyProvider,
    messages: { role: string; content: string | null; name?: string; tool_calls?: unknown[]; tool_call_id?: string; reasoning_content?: string; cache_control?: { type: 'ephemeral' } }[],
    options?: { stream?: boolean; max_tokens?: number; temperature?: number; tools?: unknown[]; sampling?: SamplingConfig; thinkingEffort?: ThinkingEffort }
): Record<string, unknown> {
    const format = getApiFormat(provider);
    const stream = options?.stream ?? false;
    const effort = options?.thinkingEffort ?? (provider as EndpointConfig).thinkingEffort;

    if (format === 'claude') {
        const { system, messages: convMessages } = transformClaudeMessages(messages);
        const maxTokens = options?.sampling?.max_tokens ?? options?.max_tokens ?? 16384;
        const body: Record<string, unknown> = {
            model: provider.modelName,
            messages: convMessages,
            max_tokens: maxTokens,
            stream,
        };
        if (system) body.system = system;

        if (effort && effort !== 'off') {
            const budget = CLAUDE_BUDGET_MAP[effort];
            if (budget !== undefined) {
                body.thinking = { type: 'enabled', budget_tokens: budget };
            }
        }

        if (options?.temperature !== undefined) body.temperature = options.temperature;
        else if (options?.sampling?.temperature !== undefined) body.temperature = options.sampling.temperature;
        if (options?.sampling?.top_p !== undefined) body.top_p = options.sampling.top_p;
        if (options?.sampling?.top_k !== undefined) body.top_k = options.sampling.top_k;

        if (options?.tools && options.tools.length > 0) body.tools = options.tools;
        return body;
    }

    if (format === 'gemini') {
        const { systemInstruction, contents } = transformGeminiMessages(messages);
        const body: Record<string, unknown> = {
            contents,
        };
        if (systemInstruction) body.systemInstruction = systemInstruction;

        const genConfig: Record<string, unknown> = {};
        genConfig.maxOutputTokens = options?.sampling?.max_tokens ?? options?.max_tokens ?? 8192;
        
        // Gemini 3.0+ models have deprecated temperature and top* parameters.
        // We only append them for older models (1.0/1.5/2.0/2.5).
        const isGemini3Plus = provider.modelName && provider.modelName.includes('gemini-3');
        
        if (!isGemini3Plus) {
            if (options?.temperature !== undefined) genConfig.temperature = options.temperature;
            else if (options?.sampling?.temperature !== undefined) genConfig.temperature = options.sampling.temperature;
            if (options?.sampling?.top_p !== undefined) genConfig.topP = options.sampling.top_p;
            if (options?.sampling?.top_k !== undefined) genConfig.topK = options.sampling.top_k;
            if (options?.sampling?.frequency_penalty !== undefined) genConfig.frequencyPenalty = options.sampling.frequency_penalty;
            if (options?.sampling?.presence_penalty !== undefined) genConfig.presencePenalty = options.sampling.presence_penalty;
        }

        if (effort && effort !== 'off') {
            const budget = GEMINI_LEVEL_MAP[effort];
            if (budget !== undefined) {
                genConfig.thinkingConfig = { thinkingBudget: budget };
            }
        }

        body.generationConfig = genConfig;

        if (options?.tools && options.tools.length > 0) {
            body.tools = transformGeminiTools(options.tools);
        }
        return body;
    }

    // OpenAI / Ollama / DeepSeek — strip cache_control (Anthropic-specific)
    const isOllama = format === 'ollama';
    const sanitizedMessages = messages.map((m) => {
        const rest = { ...m };
        delete (rest as Record<string, unknown>).cache_control;
        return rest;
    });
    const body: Record<string, unknown> = {
        model: provider.modelName,
        messages: sanitizedMessages,
        stream,
    };

    // Ask OpenAI-compatible providers to emit a final usage chunk while streaming
    // (DeepSeek reports prompt-cache hit/miss here). Harmless for servers that
    // ignore it; skipped for Ollama which has its own usage fields.
    if (stream && !isOllama) {
        body.stream_options = { include_usage: true };
    }

    if (options?.sampling?.max_tokens !== undefined) body.max_tokens = options.sampling.max_tokens;
    else if (options?.max_tokens !== undefined) body.max_tokens = options.max_tokens;

    if (options?.temperature !== undefined) body.temperature = options.temperature;
    else if (options?.sampling?.temperature !== undefined) body.temperature = options.sampling.temperature;

    if (options?.sampling) {
        const s = options.sampling;
        if (s.top_p !== undefined) body.top_p = s.top_p;
        if (s.top_k !== undefined) body.top_k = s.top_k;
        if (s.min_p !== undefined) body.min_p = s.min_p;
        if (s.frequency_penalty !== undefined) body.frequency_penalty = s.frequency_penalty;
        if (s.presence_penalty !== undefined) body.presence_penalty = s.presence_penalty;
        if (s.repetition_penalty !== undefined) body.repetition_penalty = s.repetition_penalty;
        if (s.dry_multiplier !== undefined) body.dry_multiplier = s.dry_multiplier;
        if (s.dry_base !== undefined) body.dry_base = s.dry_base;
        if (s.dry_allowed_length !== undefined) body.dry_allowed_length = s.dry_allowed_length;
    }

    if (effort && effort !== 'off') {
        if (isOllama) {
            const ollamaThinkBudget: Record<ThinkingEffort, number | undefined> = {
                off: undefined, low: 2048, medium: 2048, high: 8192, max: 8192
            };
            const thinkBudget = ollamaThinkBudget[effort];
            if (thinkBudget !== undefined) {
                body.think = true;
                (body as Record<string, unknown>).options = { ...(body.options || {}), num_predict: thinkBudget };
            }
        } else {
            const modelName = (provider.modelName || '').toLowerCase();
            const isDeepSeek = modelName.includes('deepseek') || (() => { try { return new URL(provider.endpoint.replace(/\/+$/, '')).hostname.includes('deepseek'); } catch { return false; } })();
            const effortMap = isDeepSeek ? DEEPSEEK_EFFORT_MAP : OPENAI_EFFORT_MAP;
            const mapped = effortMap[effort];
            if (mapped !== undefined) {
                body.reasoning_effort = mapped;
            }
        }
    }

    if (!isOllama && options?.tools && options.tools.length > 0) {
        body.tools = options.tools;
    }

    return body;
}

export function extractContent(data: unknown, provider: AnyProvider): string {
    const format = getApiFormat(provider);

    if (format === 'ollama') {
        const ollama = data as { message?: { content?: string } };
        return ollama?.message?.content ?? '';
    }

    if (format === 'claude') {
        const claude = data as { content?: { type: string; text?: string }[] };
        const textBlocks = claude?.content?.filter(b => b.type === 'text');
        return textBlocks?.map(b => b.text ?? '').join('') ?? '';
    }

    if (format === 'gemini') {
        const gemini = data as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
        return gemini?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    }

    const openai = data as { choices?: { message?: { content?: string } }[] };
    return openai?.choices?.[0]?.message?.content ?? '';
}

export function extractStreamDelta(data: unknown, provider: AnyProvider): string {
    const format = getApiFormat(provider);

    if (format === 'claude') {
        const claude = data as { type?: string; delta?: { type?: string; text?: string } };
        if (claude.type === 'content_block_delta' && claude.delta?.type === 'text_delta') {
            return claude.delta.text ?? '';
        }
        return '';
    }

    if (format === 'gemini') {
        const gemini = data as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
        return gemini?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    }

    const openai = data as { choices?: { delta?: { content?: string } }[] };
    return openai?.choices?.[0]?.delta?.content ?? '';
}

export function extractStreamToolCall(data: unknown, provider: AnyProvider): { id: string; name: string; arguments: string; thoughtSignature?: string } | null {
    const format = getApiFormat(provider);
    if (format === 'claude') {
        const claude = data as { content_block?: { type: string; id: string; name: string; input: unknown }; };
        const block = claude.content_block;
        if (block && block.type === 'tool_use') {
            return { id: block.id, name: block.name, arguments: JSON.stringify(block.input) };
        }
        return null;
    }
    if (format === 'gemini') {
        const gemini = data as { candidates?: { content?: { parts?: { functionCall?: { name: string; args: Record<string, unknown> }; thoughtSignature?: string; thought_signature?: string }[] } }[] };
        const fc = gemini?.candidates?.[0]?.content?.parts?.find(p => p?.functionCall);
        if (fc) {
            const sig = fc.thoughtSignature || fc.thought_signature;
            return {
                id: `gemini_${Date.now()}`,
                name: fc.functionCall?.name || '',
                arguments: JSON.stringify(fc.functionCall?.args || {}),
                thoughtSignature: sig,
            };
        }
        return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tc = ((data as any)?.choices?.[0]?.delta as any)?.tool_calls?.[0];
    if (!tc) return null;
    return { id: tc.id || '', name: tc.function?.name || '', arguments: tc.function?.arguments || '' };
}

/**
 * Scans EVERY part of a Gemini streamed chunk for a thoughtSignature, independent of whether
 * that chunk also happens to carry the functionCall. This matters because Gemini frequently
 * streams the signature-bearing part in a DIFFERENT SSE event than the one containing the
 * functionCall itself (per Google's docs: "signatures are metadata that can be attached to any
 * part... such as living inside functionCall parts OR THE FINAL PART of a response"). Relying
 * only on extractStreamToolCall's co-location check silently drops the signature whenever it
 * lands on its own part/chunk — which is exactly what causes the "missing a thought_signature"
 * 400 even for brand-new tool calls the app itself generated this session.
 *
 * Callers should call this on EVERY parsed chunk (not just chunks where extractStreamToolCall
 * returns non-null) and keep the last non-empty value seen across the whole stream.
 */
export function extractStreamThoughtSignature(data: unknown, provider: AnyProvider): string | undefined {
    if (getApiFormat(provider) !== 'gemini') return undefined;
    const gemini = data as { candidates?: { content?: { parts?: { thoughtSignature?: string; thought_signature?: string }[] } }[] };
    const parts = gemini?.candidates?.[0]?.content?.parts;
    if (!parts) return undefined;
    for (const part of parts) {
        if (part) {
            const sig = part.thoughtSignature || part.thought_signature;
            if (typeof sig === 'string' && sig) {
                return sig;
            }
        }
    }
    return undefined;
}