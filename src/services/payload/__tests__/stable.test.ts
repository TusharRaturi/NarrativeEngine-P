/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { isReasoningModel } from '../stable';
import type { AppSettings } from '../../../types';

const baseSettings = (): AppSettings => ({
    debugMode: true,
    contextLimit: 8192,
} as unknown as AppSettings);

describe('isReasoningModel — provider-slot resolution', () => {
    it('returns true when active preset storyAIProviderId references a provider with a deepseek-r1 model name', () => {
        const settings = {
            ...baseSettings(),
            activePresetId: 'preset_1',
            providers: [{ id: 'prov_a', modelName: 'deepseek-r1-distill-llama-70b' }],
            presets: [{ id: 'preset_1', storyAIProviderId: 'prov_a' }],
        } as unknown as AppSettings;

        expect(isReasoningModel(settings)).toBe(true);
    });

    it('returns true for QwQ model name pattern (case-insensitive)', () => {
        const settings = {
            ...baseSettings(),
            activePresetId: 'preset_1',
            providers: [{ id: 'prov_a', modelName: 'QwQ-32B-Preview' }],
            presets: [{ id: 'preset_1', storyAIProviderId: 'prov_a' }],
        } as unknown as AppSettings;

        expect(isReasoningModel(settings)).toBe(true);
    });

    it('returns true for qwen-think pattern', () => {
        const settings = {
            ...baseSettings(),
            activePresetId: 'preset_1',
            providers: [{ id: 'prov_a', modelName: 'qwen2.5-think-32b' }],
            presets: [{ id: 'preset_1', storyAIProviderId: 'prov_a' }],
        } as unknown as AppSettings;

        expect(isReasoningModel(settings)).toBe(true);
    });

    it('returns false for non-reasoning model name (gpt-4o)', () => {
        const settings = {
            ...baseSettings(),
            activePresetId: 'preset_1',
            providers: [{ id: 'prov_a', modelName: 'gpt-4o' }],
            presets: [{ id: 'preset_1', storyAIProviderId: 'prov_a' }],
        } as unknown as AppSettings;

        expect(isReasoningModel(settings)).toBe(false);
    });

    it('returns false for claude / gemini / ollama non-reasoning names', () => {
        for (const modelName of ['claude-3-opus', 'gemini-1.5-pro', 'llama-3.1-70b']) {
            const settings = {
                ...baseSettings(),
                activePresetId: 'preset_1',
                providers: [{ id: 'prov_a', modelName }],
                presets: [{ id: 'preset_1', storyAIProviderId: 'prov_a' }],
            } as unknown as AppSettings;

            expect(isReasoningModel(settings)).toBe(false);
        }
    });
});

describe('isReasoningModel — legacy fallback', () => {
    it('falls back to activePreset.storyAI.modelName when storyAIProviderId is missing', () => {
        const settings = {
            ...baseSettings(),
            activePresetId: 'preset_legacy',
            providers: [],
            presets: [
                {
                    id: 'preset_legacy',
                    storyAI: { endpoint: 'http://x', apiKey: '', modelName: 'deepseek-r1' } as any,
                },
            ],
        } as unknown as AppSettings;

        expect(isReasoningModel(settings)).toBe(true);
    });

    it('returns false when legacy storyAI.modelName is a non-reasoning model', () => {
        const settings = {
            ...baseSettings(),
            activePresetId: 'preset_legacy',
            providers: [],
            presets: [
                {
                    id: 'preset_legacy',
                    storyAI: { endpoint: 'http://x', apiKey: '', modelName: 'gpt-4o' } as any,
                },
            ],
        } as unknown as AppSettings;

        expect(isReasoningModel(settings)).toBe(false);
    });

    it('provider slot takes precedence over legacy storyAI.modelName', () => {
        // Provider slot points to gpt-4o; legacy storyAI says deepseek-r1.
        // Two-tier resolution should win → false.
        const settings = {
            ...baseSettings(),
            activePresetId: 'preset_mixed',
            providers: [{ id: 'prov_normal', modelName: 'gpt-4o' }],
            presets: [
                {
                    id: 'preset_mixed',
                    storyAIProviderId: 'prov_normal',
                    storyAI: { endpoint: 'http://x', apiKey: '', modelName: 'deepseek-r1' } as any,
                },
            ],
        } as unknown as AppSettings;

        expect(isReasoningModel(settings)).toBe(false);
    });
});

describe('isReasoningModel — defensive cases', () => {
    it('returns false when no preset is active', () => {
        const settings = {
            ...baseSettings(),
            activePresetId: 'missing',
            providers: [{ id: 'prov_a', modelName: 'deepseek-r1' }],
            presets: [],
        } as unknown as AppSettings;

        expect(isReasoningModel(settings)).toBe(false);
    });

    it('returns false when active preset references a missing provider and has no legacy storyAI', () => {
        const settings = {
            ...baseSettings(),
            activePresetId: 'preset_1',
            providers: [],
            presets: [{ id: 'preset_1', storyAIProviderId: 'prov_missing' }],
        } as unknown as AppSettings;

        expect(isReasoningModel(settings)).toBe(false);
    });

    it('returns false when providers/presets arrays are undefined (old campaign hydration)', () => {
        const settings = {
            ...baseSettings(),
        } as unknown as AppSettings;

        expect(isReasoningModel(settings)).toBe(false);
    });
});