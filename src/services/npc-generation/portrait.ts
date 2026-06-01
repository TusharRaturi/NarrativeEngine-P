import type { EndpointConfig } from '../../types';

// ============================================================================
// Image Generation API
// ============================================================================

export async function generateNPCPortrait(config: EndpointConfig, prompt: string): Promise<string> {
    if (!config.endpoint) {
        throw new Error('Image AI not configured');
    }

    const payload = {
        model: config.modelName || 'nano-banana',
        prompt,
        negative_prompt: "multiple people, group, crowd, split screen, twins, double, text, watermark, signature",
        size: '896x1152',
        response_format: 'url',
    };

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };
    if (config.apiKey) {
        headers['Authorization'] = `Bearer ${config.apiKey}`;
    }

    // Normalize: strip trailing slashes and any pre-existing /images/generations suffix,
    // then always append the correct path. Works for both base endpoints and full paths.
    const baseEndpoint = config.endpoint
        .replace(/\/+$/, '')                   // strip trailing slashes
        .replace(/\/images\/generations$/, ''); // strip suffix if already present
    const url = `${baseEndpoint}/images/generations`;

    try {
        console.log('[Image Engine] Sending payload:', payload);
        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
        });

        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Failed to generate image: ${err}`);
        }

        const data = await res.json();

        // Match nano-gpt return format
        if (data.data && data.data[0] && data.data[0].url) {
            return data.data[0].url;
        }

        throw new Error('Unexpected output format from Image AI: ' + JSON.stringify(data));
    } catch (error) {
        console.error('[Image Engine] Error generating portrait:', error);
        throw error;
    }
}
