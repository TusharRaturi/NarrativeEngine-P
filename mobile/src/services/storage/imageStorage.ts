import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';

export const imageStorage = {
    async store(campaignId: string, messageId: string, dataUrl: string): Promise<void> {
        await idbSet(`nn_image_${campaignId}_${messageId}`, dataUrl);
    },

    async get(campaignId: string, messageId: string): Promise<string | null> {
        const entry = await idbGet(`nn_image_${campaignId}_${messageId}`) as string | null;
        return entry ?? null;
    },

    async delete(campaignId: string, messageId: string): Promise<void> {
        await idbDel(`nn_image_${campaignId}_${messageId}`).catch(() => {});
    },

    async deleteAll(campaignId: string): Promise<void> {
        const allKeys = await import('idb-keyval').then(m => m.keys());
        const imgPrefix = `nn_image_${campaignId}_`;
        const portraitPrefix = `nn_portrait_${campaignId}_`;
        for (const key of allKeys) {
            if (typeof key === 'string' && (key.startsWith(imgPrefix) || key.startsWith(portraitPrefix))) {
                await idbDel(key);
            }
        }
    },

    async storePortrait(campaignId: string, npcId: string, dataUrl: string): Promise<void> {
        await idbSet(`nn_portrait_${campaignId}_${npcId}`, dataUrl);
    },

    async getPortrait(campaignId: string, npcId: string): Promise<string | null> {
        const entry = await idbGet(`nn_portrait_${campaignId}_${npcId}`) as string | null;
        return entry ?? null;
    },

    async deletePortrait(campaignId: string, npcId: string): Promise<void> {
        await idbDel(`nn_portrait_${campaignId}_${npcId}`).catch(() => {});
    },
};
