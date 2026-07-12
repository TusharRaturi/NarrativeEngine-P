import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LLMProvider } from '../../../types';

const mockAcquireSlot = vi.fn().mockResolvedValue(undefined);
const mockReleaseSlot = vi.fn();
const mockOnRateLimitHit = vi.fn();

vi.mock('../../../services/llm/llmRequestQueue', () => ({
    getQueueForEndpoint: () => ({
        acquireSlot: mockAcquireSlot,
        releaseSlot: mockReleaseSlot,
        onRateLimitHit: mockOnRateLimitHit,
    }),
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => false },
    CapacitorHttp: {},
}));

const openaiProvider: LLMProvider = {
    id: 'img-openai',
    label: 'OpenAI Image',
    endpoint: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    modelName: 'dall-e-3',
    apiFormat: 'openai',
};

const gptImageProvider: LLMProvider = {
    id: 'img-gpt-image',
    label: 'GPT Image',
    endpoint: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    modelName: 'gpt-image-1',
    apiFormat: 'openai',
};

const claudeProvider: LLMProvider = {
    id: 'img-claude',
    label: 'Claude',
    endpoint: 'https://api.anthropic.com/v1',
    apiKey: 'sk-ant-test',
    modelName: 'claude-3',
    apiFormat: 'claude',
};

describe('imageClient', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        global.fetch = vi.fn();
    });

    it('should reject unsupported API formats', async () => {
        const { generateImage } = await import('../imageClient');
        await expect(generateImage(claudeProvider, 'a dragon')).rejects.toThrow(
            'Image generation is not supported for claude API format'
        );
    });

    it('should call the OpenAI images endpoint with correct body', async () => {
        const { generateImage } = await import('../imageClient');

        const b64Data = Buffer.from('fake-png-data').toString('base64');
        (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ data: [{ b64_json: b64Data }] }),
            headers: new Headers(),
            text: async () => '',
        });

        const result = await generateImage(openaiProvider, 'a wizard casting fireball');

        expect(global.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(url).toContain('/images/generations');
        const body = JSON.parse(init.body);
        expect(body.model).toBe('dall-e-3');
        expect(body.prompt).toBe('a wizard casting fireball');
        expect(body.n).toBe(1);
        expect(body.response_format).toBe('b64_json');
        expect(result).toBe(`data:image/png;base64,${b64Data}`);
    });

    it('should include negative_prompt when provided', async () => {
        const { generateImage } = await import('../imageClient');

        const b64Data = Buffer.from('fake-png-data').toString('base64');
        (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ data: [{ b64_json: b64Data }] }),
            headers: new Headers(),
            text: async () => '',
        });

        await generateImage(openaiProvider, 'test', { negativePrompt: 'text, watermark' });

        const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
        expect(body.negative_prompt).toBe('text, watermark');
    });

    it('should retry without response_format on 400 response_format error', async () => {
        const { generateImage } = await import('../imageClient');

        (global.fetch as ReturnType<typeof vi.fn>)
            .mockResolvedValueOnce({
                ok: false,
                status: 400,
                headers: new Headers(),
                text: async () => 'Invalid response_format for this model',
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ data: [{ url: 'https://img.example/1.png' }] }),
                headers: new Headers(),
                text: async () => '',
            });

        const result = await generateImage(gptImageProvider, 'a forest glade');

        expect(global.fetch).toHaveBeenCalledTimes(2);
        const firstBody = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
        expect(firstBody.response_format).toBe('b64_json');
        const secondBody = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body);
        expect(secondBody.response_format).toBeUndefined();
        expect(result).toBe('https://img.example/1.png');
    });

    it('should throw on non-2xx response', async () => {
        const { generateImage } = await import('../imageClient');

        (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            ok: false,
            status: 401,
            headers: new Headers(),
            text: async () => 'Unauthorized',
        });

        await expect(generateImage(openaiProvider, 'test')).rejects.toThrow('Image API error 401');
    });

    it('should throw if response has no image data', async () => {
        const { generateImage } = await import('../imageClient');

        (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ data: [{}] }),
            headers: new Headers(),
            text: async () => '',
        });

        await expect(generateImage(openaiProvider, 'test')).rejects.toThrow('no image data');
    });
});