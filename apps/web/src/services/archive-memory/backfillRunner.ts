/* eslint-disable @typescript-eslint/no-explicit-any */
import { API_BASE as API } from '../../lib/apiBase';
import { embedClient } from '../llm/embedClient';

export type BackfillStatus = {
    scenes: { total: number; current: number; stale: number };
    lore: { total: number; current: number; stale: number };
    version: number;
};

export type BackfillResult = {
    reindexedScenes: number;
    reindexedLore: number;
    status: BackfillStatus;
};

export async function getEmbeddingStatus(campaignId: string): Promise<BackfillStatus> {
    const res = await fetch(`${API}/campaigns/${campaignId}/embeddings/status`);
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Failed to get embedding status: ${err}`);
    }
    return res.json();
}

export async function runBackfill(
    campaignId: string,
    type: 'all' | 'scene' | 'lore' = 'all',
    onProgress?: (msg: string) => void
): Promise<BackfillResult> {
    onProgress?.('Fetching stale texts...');
    
    const staleRes = await fetch(`${API}/campaigns/${campaignId}/embeddings/stale-texts`);
    if (!staleRes.ok) throw new Error('Failed to fetch stale texts');
    const { scenes, lore } = await staleRes.json();

    let reindexedScenes = 0;
    let reindexedLore = 0;
    let latestStatus: BackfillStatus | null = null;

    if ((type === 'all' || type === 'scene') && scenes.length > 0) {
        onProgress?.(`Embedding ${scenes.length} scenes...`);
        const texts = scenes.map((s: any) => s.text);
        const embeddings = await embedClient.embedBatch(texts);
        const items = scenes.map((s: any, i: number) => ({ id: s.id, embedding: embeddings[i] }));
        
        onProgress?.(`Syncing ${scenes.length} scenes...`);
        const syncRes = await fetch(`${API}/campaigns/${campaignId}/embeddings/sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'scene', items })
        });
        if (!syncRes.ok) throw new Error('Failed to sync scene embeddings');
        const syncData = await syncRes.json();
        reindexedScenes = syncData.synced;
        latestStatus = syncData.status;
    }

    if ((type === 'all' || type === 'lore') && lore.length > 0) {
        onProgress?.(`Embedding ${lore.length} lore chunks...`);
        const texts = lore.map((l: any) => l.text);
        const embeddings = await embedClient.embedBatch(texts);
        const items = lore.map((l: any, i: number) => ({ id: l.id, embedding: embeddings[i] }));
        
        onProgress?.(`Syncing ${lore.length} lore chunks...`);
        const syncRes = await fetch(`${API}/campaigns/${campaignId}/embeddings/sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'lore', items })
        });
        if (!syncRes.ok) throw new Error('Failed to sync lore embeddings');
        const syncData = await syncRes.json();
        reindexedLore = syncData.synced;
        latestStatus = syncData.status;
    }

    if (!latestStatus) {
        latestStatus = await getEmbeddingStatus(campaignId);
    }

    onProgress?.(`Done: ${reindexedScenes} scenes, ${reindexedLore} lore re-indexed`);
    return { reindexedScenes, reindexedLore, status: latestStatus };
}