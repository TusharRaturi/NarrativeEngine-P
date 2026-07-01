import { DATA_DIR } from './fileStore.js';
import path from 'path';
import fs from 'fs';

const MODEL_ID = 'mixedbread-ai/mxbai-embed-large-v1';
const CACHE_DIR = path.join(DATA_DIR, '.embeddings_cache');
const ACTIVE_DIMS = 1024;
const ACTIVE_PROVIDER = 'local-mxbai';

let extractor = null;
let warmupPromise = null;
let modelReady = false;

const EMBED_CACHE_MAX = 512;
const embedCache = new Map();

function cacheGet(text) {
    if (!embedCache.has(text)) return null;
    const v = embedCache.get(text);
    embedCache.delete(text);
    embedCache.set(text, v);
    return new Float32Array(v);
}

function cacheSet(text, vec) {
    if (embedCache.size >= EMBED_CACHE_MAX) {
        const oldest = embedCache.keys().next().value;
        if (oldest !== undefined) embedCache.delete(oldest);
    }
    embedCache.set(text, new Float32Array(vec));
}

/**
 * True once the model is loaded AND has served at least one inference (warmup or a
 * real embed). Until this flips, the first embed call pays the full cold-load cost,
 * so callers on the hot path (turn-1 semantic retrieval) should short-circuit instead
 * of blocking. See server/routes/archive.js semantic-candidates routes.
 */
export function isModelReady() {
    return modelReady;
}

/**
 * Map an indexing-speed setting to embedBatch params. The model is a single CPU
 * instance, so batchSize barely changes raw throughput — the real lever is delayMs,
 * which yields the event loop between batches so the server stays responsive to the
 * active turn. 'eco' keeps the UI snappy during a big import; 'aggressive' finishes
 * fastest but starves other requests while it runs.
 */
export function resolveIndexingSpeed(speed) {
    switch (speed) {
        case 'eco': return { batchSize: 4, delayMs: 250 };
        case 'aggressive': return { batchSize: 16, delayMs: 0 };
        case 'balanced':
        default: return { batchSize: 8, delayMs: 100 };
    }
}

function ensureCacheDir() {
    if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
}

async function loadModel() {
    if (extractor) return extractor;

    ensureCacheDir();

    const { pipeline } = await import('@huggingface/transformers');
    extractor = await pipeline('feature-extraction', MODEL_ID, {
        dtype: 'q8',
        cache_dir: CACHE_DIR,
    });

    console.log(`[Embedder] Model loaded: ${MODEL_ID} (${ACTIVE_DIMS} dims, CPU)`);
    return extractor;
}

export async function warmup() {
    if (warmupPromise) return warmupPromise;

    warmupPromise = (async () => {
        try {
            const start = Date.now();
            const model = await loadModel();
            const result = await model('warmup', { pooling: 'mean', normalize: true });
            void result;
            modelReady = true;
            const ms = Date.now() - start;
            console.log(`[Embedder] Warmup complete (${ms}ms)`);
            return true;
        } catch (err) {
            console.error('[Embedder] Warmup failed:', err.message);
            warmupPromise = null;
            return false;
        }
    })();

    return warmupPromise;
}

async function runInference(texts) {
    const model = await loadModel();
    const output = await model(texts, { pooling: 'mean', normalize: true });
    modelReady = true;
    const data = output.data;
    const src = data.buffer ? new Float32Array(data.buffer, data.byteOffset, data.length) : Float32Array.from(data);
    const batch = texts.length;
    const dims = src.length / batch;
    const out = new Array(batch);
    for (let i = 0; i < batch; i++) {
        out[i] = src.slice(i * dims, (i + 1) * dims);
    }
    return out;
}

export async function embedText(text) {
    if (!text || !text.trim()) return new Float32Array(ACTIVE_DIMS);

    const cached = cacheGet(text);
    if (cached) return cached;

    const [vec] = await runInference([text]);
    cacheSet(text, vec);
    return vec;
}

export async function embedBatch(texts, batchSize = 10, delayMs = 100) {
    const results = new Array(texts.length);

    for (let i = 0; i < texts.length; i += batchSize) {
        const batchSlice = texts.slice(i, i + batchSize);
        const batchPositions = [];
        const uncached = [];
        const cachedVecs = [];

        for (let j = 0; j < batchSlice.length; j++) {
            const text = batchSlice[j];
            if (!text || !text.trim()) {
                cachedVecs[j] = new Float32Array(ACTIVE_DIMS);
                continue;
            }
            const c = cacheGet(text);
            if (c) {
                cachedVecs[j] = c;
            } else {
                batchPositions.push(j);
                uncached.push(text);
            }
        }

        if (uncached.length > 0) {
            const out = await runInference(uncached);
            for (let k = 0; k < uncached.length; k++) {
                cachedVecs[batchPositions[k]] = out[k];
                cacheSet(uncached[k], out[k]);
            }
        }

        for (let j = 0; j < batchSlice.length; j++) {
            results[i + j] = cachedVecs[j];
        }

        if (i + batchSize < texts.length && delayMs > 0) {
            await new Promise(r => setTimeout(r, delayMs));
        }

        console.log(`[Embedder] Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(texts.length / batchSize)} done`);
    }
    return results;
}

export function getActiveDims() {
    return ACTIVE_DIMS;
}

export function getActiveProvider() {
    return ACTIVE_PROVIDER;
}

export function getActiveModelId() {
    return MODEL_ID;
}

export function buildArchiveText(indexEntry) {
    const parts = [];
    if (indexEntry.witnesses?.length) parts.push(indexEntry.witnesses.join(' '));
    if (indexEntry.npcsMentioned?.length) parts.push(indexEntry.npcsMentioned.join(' '));
    if (indexEntry.keywords?.length) parts.push(indexEntry.keywords.join(' '));
    if (indexEntry.userSnippet) parts.push(indexEntry.userSnippet);
    return parts.join(' ').slice(0, 500);
}

export function buildLoreText(chunk) {
    const parts = [];
    if (chunk.header) parts.push(chunk.header);
    if (chunk.summary) parts.push(chunk.summary);
    if (chunk.triggerKeywords?.length) parts.push(chunk.triggerKeywords.join(' '));
    if (chunk.linkedEntities?.length) parts.push(chunk.linkedEntities.join(' '));
    return parts.join(' ').slice(0, 500);
}
