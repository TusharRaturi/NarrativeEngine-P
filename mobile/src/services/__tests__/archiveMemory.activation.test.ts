import { describe, it, expect } from 'vitest';
import { extractContextActivations } from '../archive';
import type { ChatMessage } from '../../types';

function makeMsg(role: 'user' | 'assistant', content: string): ChatMessage {
    return { id: `msg-${Math.random()}`, role, content, timestamp: Date.now() };
}

describe('extractContextActivations with smooth decay', () => {
    it('user message terms get weight 1.0', () => {
        const activations = extractContextActivations('dragon sword', []);
        expect(activations['dragon']).toBe(1.0);
        expect(activations['sword']).toBe(1.0);
    });

    it('30-message window produces smooth decay with floor at 0.15', () => {
        const messages: ChatMessage[] = [];
        for (let i = 0; i < 30; i++) {
            const prefix = i < 26 ? 'aaa' : 'bbb';
            const suffix = String.fromCharCode(97 + (i % 26));
            messages.push(makeMsg('assistant', `${prefix}${suffix} appeared here`));
        }

        const activations = extractContextActivations('test', messages);

        const newestKey = `bbbd`;
        const oldestKey = `aaaa`;

        const newestWeight = activations[newestKey];
        const oldestWeight = activations[oldestKey];

        expect(newestWeight).toBeDefined();
        expect(oldestWeight).toBeDefined();
        expect(newestWeight).toBeGreaterThan(oldestWeight);
        expect(oldestWeight).toBeGreaterThanOrEqual(0.15);
    });

    it('older keywords have lower-but-nonzero weight', () => {
        const messages: ChatMessage[] = [];
        for (let i = 0; i < 26; i++) {
            messages.push(makeMsg('assistant', `bbb${String.fromCharCode(97 + i)} happened`));
        }

        const activations = extractContextActivations('query', messages);

        const recent = activations[`bbbz`];
        const mid = activations[`bbbn`];
        const oldest = activations[`bbba`];

        expect(recent).toBeDefined();
        expect(mid).toBeDefined();
        expect(oldest).toBeDefined();
        expect(recent).toBeGreaterThan(mid);
        expect(mid).toBeGreaterThan(oldest);
        expect(oldest).toBeGreaterThanOrEqual(0.15);
    });

    it('user message weight 1.0 is never overwritten by decay loop', () => {
        const messages = [makeMsg('assistant', 'dragon castle')];
        const activations = extractContextActivations('dragon', messages);

        expect(activations['dragon']).toBe(1.0);
    });

    it('NPC ledger forces names to 1.0', () => {
        const messages = [makeMsg('assistant', 'something happened')];
        const npcLedger = [{
            id: 'npc1', name: 'Malachar', aliases: 'Mal', appearance: '',
            faction: '', storyRelevance: '', disposition: '', status: '',
            goals: '', voice: '', personality: '', exampleOutput: '', affinity: 0,
        }];

        const activations = extractContextActivations('hello', messages, npcLedger);
        expect(activations['malachar']).toBe(1.0);
        expect(activations['mal']).toBe(1.0);
    });

    it('decay with 0.92 base at turn 30 clamped to 0.15', () => {
        const messages: ChatMessage[] = [];
        for (let i = 0; i < 30; i++) {
            const prefix = i < 26 ? 'ccc' : 'ddd';
            const suffix = String.fromCharCode(97 + (i % 26));
            messages.push(makeMsg('assistant', `${prefix}${suffix}`));
        }

        const activations = extractContextActivations('query', messages);
        const oldestWeight = activations['ccca'];

        expect(oldestWeight).toBeDefined();
        expect(oldestWeight!).toBeGreaterThanOrEqual(0.15);
        expect(oldestWeight!).toBeLessThanOrEqual(0.25);
    });
});