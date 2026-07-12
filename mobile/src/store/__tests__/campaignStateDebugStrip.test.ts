import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { get as idbGet } from 'idb-keyval';
import { saveCampaignState, loadCampaignState } from '../campaignStore';
import type { CampaignState } from '../campaignStore';
import type { ChatMessage } from '../../types';

function msg(id: string, withPayload: boolean): ChatMessage {
    return {
        id,
        role: 'assistant',
        content: `prose ${id}`,
        timestamp: 0,
        ...(withPayload ? { debugPayload: { huge: 'x'.repeat(1000) } } : {}),
    };
}

function makeState(): CampaignState {
    return {
        context: {} as CampaignState['context'],
        messages: [msg('a', true), msg('b', false), msg('c', true)],
        condenser: { condensedUpToIndex: 0 } as CampaignState['condenser'],
    };
}

describe('campaignState debugPayload stripping', () => {
    beforeEach(async () => {
        // fake-indexeddb persists across tests in a file; clear our key
        const { del } = await import('idb-keyval');
        await del('state_strip-test');
    });

    it('does not persist debugPayload to IndexedDB but keeps all messages', async () => {
        await saveCampaignState('strip-test', makeState());

        const onDisk = await idbGet<CampaignState>('state_strip-test');
        expect(onDisk?.messages).toHaveLength(3); // no messages dropped
        expect(onDisk?.messages.some(m => m.debugPayload !== undefined)).toBe(false);
        // content survives intact
        expect(onDisk?.messages.map(m => m.content)).toEqual(['prose a', 'prose b', 'prose c']);
    });

    it('strips debugPayload on load for legacy states already saved with payloads', async () => {
        // Simulate a legacy save that bypassed the strip (raw set)
        const { set } = await import('idb-keyval');
        await set('state_strip-test', makeState());

        const loaded = await loadCampaignState('strip-test');
        expect(loaded?.messages).toHaveLength(3);
        expect(loaded?.messages.some(m => m.debugPayload !== undefined)).toBe(false);
    });

    it('does not clone the array when no payloads are present (returns same ref)', async () => {
        const lean: CampaignState = {
            context: {} as CampaignState['context'],
            messages: [msg('a', false)],
            condenser: { condensedUpToIndex: 0 } as CampaignState['condenser'],
        };
        const { set } = await import('idb-keyval');
        await set('state_strip-test', lean);
        const loaded = await loadCampaignState('strip-test');
        expect(loaded?.messages[0].debugPayload).toBeUndefined();
    });
});
