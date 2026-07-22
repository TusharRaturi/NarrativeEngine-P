import type { EndpointConfig } from '../../types';
import { llmFetch } from '../llm/llmFetch';
import { isVertexNativeEndpoint } from '../../utils/llmApiHelper';

// ============================================================================
// Image Generation API
// ============================================================================

export async function generateNPCPortrait(config: EndpointConfig, prompt: string): Promise<string> {
    if (!config.endpoint) {
        throw new Error('Image AI not configured');
    }

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };
    if (config.apiKey) {
        headers['Authorization'] = `Bearer ${config.apiKey}`;
    }

    const isVertex = isVertexNativeEndpoint(config.endpoint);
    const model = config.modelName || (isVertex ? 'imagen-3.0-generate-001' : 'nano-banana');
    const isGeminiVertex = isVertex && (model.toLowerCase().includes('gemini') || model.toLowerCase().includes('nano'));

    let url: string;
    let payload: Record<string, unknown>;

    if (isVertex) {
        const baseEndpoint = config.endpoint.replace(/\/+$/, '');
        
        if (isGeminiVertex) {
            // Gemini models use generateContent with the standard contents array
            url = `${baseEndpoint}/models/${model}:generateContent`;
            payload = {
                contents: [{ role: "user", parts: [{ text: prompt }] }],
            };
        } else {
            // Vertex AI native Imagen endpoints use a specific path and payload format
            url = `${baseEndpoint}/models/${model}:predict`;
            payload = {
                instances: [{ prompt }],
                parameters: {
                    sampleCount: 1,
                    aspectRatio: "3:4",
                    personGeneration: "ALLOW_ADULT"
                }
            };
        }
    } else {
        // Normalize for OpenAI-compatible proxies
        const baseEndpoint = config.endpoint
            .replace(/\/+$/, '')                   // strip trailing slashes
            .replace(/\/images\/generations$/, ''); // strip suffix if already present
        url = `${baseEndpoint}/images/generations`;
        payload = {
            model: model,
            prompt,
            negative_prompt: "multiple people, group, crowd, split screen, twins, double, text, watermark, signature",
            size: '896x1152',
            response_format: 'url',
        };
    }

    try {
        console.log('[Image Engine] Sending payload:', payload);
        const res = await llmFetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
        });

        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Failed to generate image: ${err}`);
        }

        const data = await res.json();

        if (isVertex) {
            if (isGeminiVertex) {
                const part = data.candidates?.[0]?.content?.parts?.[0];
                if (part?.inlineData?.data) {
                    const mimeType = part.inlineData.mimeType || 'image/png';
                    return `data:${mimeType};base64,${part.inlineData.data}`;
                } else if (part?.inline_data?.data) {
                    const mimeType = part.inline_data.mimeType || part.inline_data.mime_type || 'image/png';
                    return `data:${mimeType};base64,${part.inline_data.data}`;
                }
            } else if (data.predictions && data.predictions[0] && data.predictions[0].bytesBase64Encoded) {
                const mimeType = data.predictions[0].mimeType || 'image/png';
                return `data:${mimeType};base64,${data.predictions[0].bytesBase64Encoded}`;
            }
        } else {
            // Match OpenAI / nano-gpt return format
            if (data.data && data.data[0]) {
                if (data.data[0].url) return data.data[0].url;
                if (data.data[0].b64_json) return `data:image/png;base64,${data.data[0].b64_json}`;
            }
        }

        throw new Error('Unexpected output format from Image AI: ' + JSON.stringify(data));
    } catch (error) {
        console.error('[Image Engine] Error generating portrait:', error);
        throw error;
    }
}
