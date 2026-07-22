/**
 * Vector Service — thin wrapper over the red-zone vector store + embedder.
 *
 * Phase 5 split: every SQLite / embedding-model call goes through here. The
 * underlying `server/lib/vectorStore.js` and `server/lib/embedder.js` are NOT
 * modified (red zone per AI_CODEBASE_MAP.md blast radius matrix). This module
 * only re-exports and lightly composes their functions so the service/controller
 * layers have a single, narrow vector seam.
 *
 * IMPORTANT: this wrapper adds no behavioural change — same args, same returns,
 * same error semantics as the underlying calls. It exists for architectural
 * separation only, not optimisation.
 */

import {
    storeArchiveEmbedding,
    storeLoreEmbedding,
    searchArchive,
    searchLore,
    getEmbeddingStatus,
    deleteArchiveEmbedding,
    getStaleAndUnversionedIds,
    getVssIds,
    EMBEDDING_VERSION,
    getDb,
} from '../lib/vectorStore.js';
import {
    buildArchiveText,
    buildLoreText,
    warmup,
    embedBatch,
    getActiveDims,
    getActiveModelId,
    isModelReady,
} from '../lib/embedder.js';
import { isJobRunning } from '../lib/embedJobs.js';

// ─── Re-exports (no behaviour change) ──────────────────────────────────────
export {
    storeArchiveEmbedding,
    storeLoreEmbedding,
    searchArchive,
    searchLore,
    getEmbeddingStatus,
    deleteArchiveEmbedding,
    getStaleAndUnversionedIds,
    getVssIds,
    EMBEDDING_VERSION,
    getDb,
    buildArchiveText,
    buildLoreText,
    warmup,
    embedBatch,
    getActiveDims,
    getActiveModelId,
    isModelReady,
    isJobRunning,
};

// ─── Thin compositions ─────────────────────────────────────────────────────

/**
 * Search the archive for `query` (single or multi-query). Used by the
 * semantic-candidates route. Returns an array of { sceneId } hits.
 *
 * If `queries` is a non-empty array, runs each query and unions the sceneIds
 * into a deduplicated array. Otherwise runs the single `query`.
 *
 * `scopeSceneIds` (WO-10): optional array of scene IDs to restrict recall to.
 * Forwarded as `opts.scopeIds` to `searchArchive`; null/empty/absent → unscoped
 * (existing callers unaffected). The scope filter is additive on the search
 * function — see `createSearchFn` in `vectorStore.js` for the SQL IN / fallback
 * implementation.
 */
export async function searchArchiveCandidates(campaignId, { query, queries, queryEmbedding, queryEmbeddings, limit, diversity = true, scopeSceneIds } = {}) {
    if (queries && Array.isArray(queries) && queries.length > 0) {
        const allSceneIds = new Set();
        for (let i = 0; i < queries.length; i++) {
            const q = queries[i];
            if (!q?.trim()) continue;
            const embedding = queryEmbeddings ? queryEmbeddings[i] : null;
            if (!embedding) continue;
            const results = await searchArchive(campaignId, embedding, limit || 20, diversity, { scopeIds: scopeSceneIds });
            for (const r of results) allSceneIds.add(r.sceneId);
        }
        console.log(`[VectorStore] archive candidates for ${queries.length} queries: [${[...allSceneIds].join(', ')}]`);
        return [...allSceneIds];
    }
    if (!query?.trim()) return [];
    if (!queryEmbedding) return [];
    const results = await searchArchive(campaignId, queryEmbedding, limit || 20, diversity, { scopeIds: scopeSceneIds });
    console.log(`[VectorStore] archive candidates for "${query.slice(0, 50)}": [${results.map(r => r.sceneId).join(', ')}]`);
    return results.map(r => r.sceneId);
}

/**
 * Search the lore for `query` (single or multi-query). Mirrors
 * `searchArchiveCandidates` but returns loreIds. Used by the lore
 * semantic-candidates route.
 */
export async function searchLoreCandidates(campaignId, { query, queries, queryEmbedding, queryEmbeddings, limit, diversity = true }) {
    if (queries && Array.isArray(queries) && queries.length > 0) {
        const allLoreIds = new Set();
        for (let i = 0; i < queries.length; i++) {
            const q = queries[i];
            if (!q?.trim()) continue;
            const embedding = queryEmbeddings ? queryEmbeddings[i] : null;
            if (!embedding) continue;
            const results = await searchLore(campaignId, embedding, limit || 15, diversity);
            for (const r of results) allLoreIds.add(r.loreId);
        }
        console.log(`[VectorStore] lore candidates for ${queries.length} queries: [${[...allLoreIds].join(', ')}]`);
        return [...allLoreIds];
    }
    if (!query?.trim()) return [];
    if (!queryEmbedding) return [];
    const results = await searchLore(campaignId, queryEmbedding, limit || 15, diversity);
    console.log(`[VectorStore] lore candidates for "${query.slice(0, 50)}": [${results.map(r => r.loreId).join(', ')}]`);
    return results.map(r => r.loreId);
}