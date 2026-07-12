import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { del, get as idbGet } from 'idb-keyval';
import { saveCampaignState, saveCampaign, getCampaign } from '../campaignStore';
import type { CampaignState } from '../campaignStore';
import type { Campaign, ChatMessage } from '../../types';

function msg(id: string): ChatMessage {
    return { id, role: 'assistant', content: `prose ${id}`, timestamp: 0 };
}

function makeState(): CampaignState {
    return {
        context: {} as CampaignState['context'],
        messages: [msg('a')],
        condenser: { condensedUpToIndex: 0 } as CampaignState['condenser'],
    };
}

function makeCampaign(id: string, lastPlayedAt: number): Campaign {
    return {
        id,
        name: `Campaign ${id}`,
        coverImage: '',
        createdAt: 1000,
        lastPlayedAt,
    } as Campaign;
}

describe('B5 — saveCampaignState bumps the campaign meta lastPlayedAt', () => {
    beforeEach(async () => {
        await del('state_b5-test');
        await del('campaigns');
    });

    it('updates lastPlayedAt to ~Date.now() for an existing campaign', async () => {
        const openedAt = 1000;
        await saveCampaign(makeCampaign('b5-test', openedAt));

        const before = Date.now();
        await saveCampaignState('b5-test', makeState());
        const after = Date.now();

        const campaign = await getCampaign('b5-test');
        expect(campaign).toBeDefined();
        expect(campaign!.lastPlayedAt).toBeGreaterThanOrEqual(before);
        expect(campaign!.lastPlayedAt).toBeLessThanOrEqual(after);
        expect(campaign!.lastPlayedAt).toBeGreaterThan(openedAt);
    });

    it('is greater than the prior open-time stamp', async () => {
        // Simulate the bug scenario: campaign opened at 02:52, played until 12:31.
        const openTime = new Date('2026-06-23T02:52:00').getTime();
        await saveCampaign(makeCampaign('b5-test', openTime));

        await saveCampaignState('b5-test', makeState());

        const campaign = await getCampaign('b5-test');
        expect(campaign!.lastPlayedAt).toBeGreaterThan(openTime);
    });

    it('does not create a phantom campaign record if the id does not exist', async () => {
        // saveCampaignState for an unknown id should not invent a campaign meta.
        await saveCampaignState('nonexistent', makeState());

        const campaigns = await idbGet<Campaign[]>('campaigns');
        expect(campaigns ?? []).toEqual([]);
    });

    it('state is still saved even if the meta bump fails (no campaign record)', async () => {
        // No campaign record exists; the state write must still succeed.
        await saveCampaignState('orphan-test', makeState());

        const onDisk = await idbGet<CampaignState>('state_orphan-test');
        expect(onDisk?.messages).toHaveLength(1);
        expect(onDisk?.messages[0].content).toBe('prose a');
    });

    it('preserves the campaign name and other meta fields (only lastPlayedAt changes)', async () => {
        const original = makeCampaign('b5-test', 1000);
        original.name = 'My Campaign';
        await saveCampaign(original);

        await saveCampaignState('b5-test', makeState());

        const campaign = await getCampaign('b5-test');
        expect(campaign!.name).toBe('My Campaign');
        expect(campaign!.id).toBe('b5-test');
        expect(campaign!.createdAt).toBe(1000);
    });
});