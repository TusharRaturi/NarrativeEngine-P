import { describe, it, expect } from 'vitest';
import { buildChatBody, getApiFormat } from '../llmApiHelper';
import type { EndpointConfig } from '../../types';

const claudeProvider: EndpointConfig = {
    id: 'test-claude',
    name: 'Claude',
    endpoint: 'https://api.anthropic.com',
    modelName: 'claude-sonnet-4-20250514',
    apiKey: 'test-key',
    apiFormat: 'claude',
};

const openAIProvider: EndpointConfig = {
    id: 'test-openai',
    name: 'OpenAI',
    endpoint: 'https://api.openai.com/v1',
    modelName: 'gpt-4o',
    apiKey: 'test-key',
    apiFormat: 'openai',
};

const ollamaProvider: EndpointConfig = {
    id: 'test-ollama',
    name: 'Ollama',
    endpoint: 'http://localhost:11434',
    modelName: 'llama3',
    apiFormat: 'ollama',
};

const cacheControlEphemeral = { type: 'ephemeral' as const };

describe('buildChatBody — cache_control handling', () => {
    it('Claude: system message with cache_control emits system as array of blocks with cache_control', () => {
        const messages = [
            { role: 'system', content: 'You are a helpful GM.', cache_control: cacheControlEphemeral },
            { role: 'system', content: 'Established facts here.' },
            { role: 'user', content: 'Hello' },
        ];
        const body = buildChatBody(claudeProvider, messages, { stream: false });
        const system = body.system as { type: string; text: string; cache_control?: { type: string } }[];
        expect(Array.isArray(system)).toBe(true);
        expect(system[0].type).toBe('text');
        expect(system[0].text).toBe('You are a helpful GM.');
        expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
        expect(system[1].cache_control).toBeUndefined();
    });

    it('Claude: system message without any cache_control emits system as plain string', () => {
        const messages = [
            { role: 'system', content: 'You are a helpful GM.' },
            { role: 'user', content: 'Hello' },
        ];
        const body = buildChatBody(claudeProvider, messages, { stream: false });
        expect(typeof body.system).toBe('string');
    });

    it('Claude: stable and divergence blocks get cache_control, world block does not', () => {
        const messages = [
            { role: 'system', content: 'Rules text here.', cache_control: cacheControlEphemeral },
            { role: 'system', content: 'Divergence facts.', cache_control: cacheControlEphemeral },
            { role: 'system', content: '[WORLD LORE]\nSome lore content.' },
            { role: 'system', content: '[GM REMINDER: ...]' },
            { role: 'user', content: 'I look around' },
        ];
        const body = buildChatBody(claudeProvider, messages, { stream: false });
        const system = body.system as { type: string; text: string; cache_control?: { type: string } }[];
        expect(system.length).toBe(4);
        expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
        expect(system[1].cache_control).toEqual({ type: 'ephemeral' });
        expect(system[2].cache_control).toBeUndefined();
        expect(system[3].cache_control).toBeUndefined();
    });

    it('OpenAI: cache_control is stripped from messages in request body', () => {
        const messages = [
            { role: 'system', content: 'Rules text here.', cache_control: cacheControlEphemeral },
            { role: 'user', content: 'Hello' },
        ];
        const body = buildChatBody(openAIProvider, messages, { stream: false });
        const bodyMessages = body.messages as { role: string; content: string; cache_control?: unknown }[];
        expect(bodyMessages[0].cache_control).toBeUndefined();
        expect(bodyMessages[0].content).toBe('Rules text here.');
    });

    it('Ollama: cache_control is stripped from messages in request body', () => {
        const messages = [
            { role: 'system', content: 'Rules text here.', cache_control: cacheControlEphemeral },
            { role: 'user', content: 'Hello' },
        ];
        const body = buildChatBody(ollamaProvider, messages, { stream: false });
        const bodyMessages = body.messages as { role: string; content: string; cache_control?: unknown }[];
        expect(bodyMessages[0].cache_control).toBeUndefined();
    });

    it('Gemini: system messages are collected into systemInstruction (cache_control irrelevant for Gemini)', () => {
        const geminiProvider: EndpointConfig = {
            id: 'test-gemini',
            name: 'Gemini',
            endpoint: 'https://generativelanguage.googleapis.com',
            modelName: 'gemini-2.0-flash',
            apiKey: 'test-key',
            apiFormat: 'gemini',
        };
        const messages = [
            { role: 'system', content: 'You are a GM.', cache_control: cacheControlEphemeral },
            { role: 'user', content: 'Hello' },
        ];
        const body = buildChatBody(geminiProvider, messages, { stream: false });
        const si = body.systemInstruction as { parts: { text: string }[] };
        expect(si).toBeDefined();
        expect(si.parts[0].text).toContain('You are a GM.');
    });
});