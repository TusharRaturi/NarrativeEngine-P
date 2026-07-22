import { Worker } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const EMBEDDING_VERSION = 1;

let worker = null;
let msgIdCounter = 1;
const pendingResolvers = new Map();

function getWorker() {
    if (!worker) {
        worker = new Worker(path.join(__dirname, 'workers/dbWorker.js'));
        worker.on('message', (msg) => {
            const { id, result, error } = msg;
            if (pendingResolvers.has(id)) {
                const { resolve, reject } = pendingResolvers.get(id);
                pendingResolvers.delete(id);
                if (error) {
                    reject(new Error(error));
                } else {
                    resolve(result);
                }
            }
        });
        worker.on('error', (err) => {
            console.error('[VectorStore Proxy] Worker error:', err);
        });
        worker.on('exit', (code) => {
            if (code !== 0) {
                console.error(`[VectorStore Proxy] Worker stopped with exit code ${code}`);
            }
            worker = null;
        });
    }
    return worker;
}

function sendToWorker(action, ...args) {
    return new Promise((resolve, reject) => {
        const id = msgIdCounter++;
        pendingResolvers.set(id, { resolve, reject });
        getWorker().postMessage({ id, action, args });
    });
}

// Ensure initDb finishes before resolving
let initPromise = null;
export async function initDb() {
    if (!initPromise) {
        initPromise = sendToWorker('initDb');
    }
    return initPromise;
}

export async function storeArchiveEmbedding(campaignId, sceneId, embedding) {
    return sendToWorker('storeArchiveEmbedding', campaignId, sceneId, Array.from(embedding));
}

export async function storeLoreEmbedding(campaignId, loreId, embedding) {
    return sendToWorker('storeLoreEmbedding', campaignId, loreId, Array.from(embedding));
}

export async function storeRulesEmbedding(campaignId, ruleId, embedding) {
    return sendToWorker('storeRulesEmbedding', campaignId, ruleId, Array.from(embedding));
}

export async function searchArchive(campaignId, queryEmbedding, limit, diversity = true, opts = {}) {
    return sendToWorker('searchArchive', campaignId, Array.from(queryEmbedding), limit, diversity, opts);
}

export async function searchLore(campaignId, queryEmbedding, limit, diversity = true, opts = {}) {
    return sendToWorker('searchLore', campaignId, Array.from(queryEmbedding), limit, diversity, opts);
}

export async function searchRules(campaignId, queryEmbedding, limit, diversity = true, opts = {}) {
    return sendToWorker('searchRules', campaignId, Array.from(queryEmbedding), limit, diversity, opts);
}

export async function deleteArchiveEmbedding(campaignId, sceneId) {
    return sendToWorker('deleteArchiveEmbedding', campaignId, sceneId);
}

export async function deleteRulesEmbedding(campaignId, ruleId) {
    return sendToWorker('deleteRulesEmbedding', campaignId, ruleId);
}

export async function deleteCampaignRulesEmbeddings(campaignId) {
    return sendToWorker('deleteCampaignRulesEmbeddings', campaignId);
}

export async function deleteCampaignEmbeddings(campaignId) {
    return sendToWorker('deleteCampaignEmbeddings', campaignId);
}

export async function getEmbeddingStatus(campaignId) {
    return sendToWorker('getEmbeddingStatus', campaignId);
}

// These were added for reindexEmbeddings in archiveService to run asynchronously
export async function getStaleAndUnversionedIds(campaignId, itemType) {
    return sendToWorker('getStaleAndUnversionedIds', campaignId, itemType);
}

export async function getVssIds(campaignId, itemType) {
    return sendToWorker('getVssIds', campaignId, itemType);
}

// getDb() is no longer supported; callers must use explicit worker messages.
export function getDb() {
    throw new Error('getDb() is not supported in the Worker Thread architecture. Use proxy functions instead.');
}
