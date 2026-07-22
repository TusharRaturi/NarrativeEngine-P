import { parentPort } from 'worker_threads';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ─── Environment Setup ───
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_DIR = path.resolve(__dirname, '../../../../');
const DATA_DIR = path.join(SERVER_DIR, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const DB_PATH = path.join(DATA_DIR, 'embeddings.db');
const VEC_DIMS_KEY = 'embeddingDims';

export const EMBEDDING_VERSION = 1;

// ─── MMR diversity reranking ───
const MMR_LAMBDA = 0.7;
const MMR_MIN_POOL = 4;

export function cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
}

export function mmrSelect(pool, topK, lambda = MMR_LAMBDA) {
    pool = pool.filter(p => p && p.vector);
    if (pool.length <= topK) return pool.map(({ id, score }) => ({ id, score }));

    const selected = [];
    const remaining = [...pool];

    remaining.sort((a, b) => b.score - a.score);
    selected.push(remaining.shift());

    while (selected.length < topK && remaining.length > 0) {
        let bestIdx = -1;
        let bestMmr = -Infinity;

        for (let i = 0; i < remaining.length; i++) {
            const candidate = remaining[i];
            let maxSim = 0;
            for (const sel of selected) {
                const sim = cosineSimilarity(candidate.vector, sel.vector);
                if (sim > maxSim) maxSim = sim;
            }
            const mmr = lambda * candidate.score - (1 - lambda) * maxSim;
            if (mmr > bestMmr) {
                bestMmr = mmr;
                bestIdx = i;
            }
        }

        if (bestIdx === -1) break;
        selected.push(remaining.splice(bestIdx, 1)[0]);
    }

    return selected.map(({ id, score }) => ({ id, score }));
}

function blobToFloat32(blob) {
    if (!blob) return null;
    return new Float32Array(new Uint8Array(blob).buffer);
}

function readJsonSafe(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        const text = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(text);
    } catch (e) {
        console.warn(`[dbWorker] Error reading ${filePath}: ${e.message}`);
        return fallback;
    }
}

function writeJsonSafe(filePath, data) {
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
        console.warn(`[dbWorker] Error writing ${filePath}: ${e.message}`);
    }
}

let db = null;
let currentDims = null;

function resolveDims() {
    const settings = readJsonSafe(SETTINGS_FILE, {});
    const dims = settings?.settings?.[VEC_DIMS_KEY];
    if (dims) return dims;
    return 1024; // Default to mxbai dims if not set
}

function getStoredSchemaDims() {
    if (!db) return null;
    try {
        const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='archive_vss'").get();
        if (!row) return null;
        const match = row.sql.match(/float\[(\d+)\]/i);
        return match ? parseInt(match[1], 10) : null;
    } catch (e) {
        console.warn(`[dbWorker] Schema dims read failed: ${e.message}`);
        return null;
    }
}

function initDb() {
    if (db) return;
    
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    db = new Database(DB_PATH);
    sqliteVec.load(db);

    const version = db.prepare("select vec_version() as v").get();
    console.log(`[dbWorker] sqlite-vec v${version.v} loaded`);

    currentDims = resolveDims();
    const storedDims = getStoredSchemaDims();

    if (storedDims !== null && storedDims !== currentDims) {
        console.warn(`[dbWorker] Dimension mismatch: schema=${storedDims}, active=${currentDims}. Rebuilding tables.`);
        db.exec("DROP TABLE IF EXISTS archive_vss");
        db.exec("DROP TABLE IF EXISTS lore_vss");
        db.exec("DROP TABLE IF EXISTS rules_vss");
        console.warn('[dbWorker] Tables dropped — run migrateEmbeddings.js to re-index');
    }

    db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS archive_vss USING vec0(
            campaign_id TEXT,
            scene_id TEXT,
            embedding FLOAT[${currentDims}] distance_metric=cosine
        )
    `);
    db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS lore_vss USING vec0(
            campaign_id TEXT,
            lore_id TEXT,
            embedding FLOAT[${currentDims}] distance_metric=cosine
        )
    `);
    db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS rules_vss USING vec0(
            campaign_id TEXT,
            rule_id TEXT,
            embedding FLOAT[${currentDims}] distance_metric=cosine
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS embedding_meta (
            campaign_id TEXT NOT NULL,
            item_type TEXT NOT NULL,
            item_id TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            updated_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (campaign_id, item_type, item_id)
        )
    `);

    const settings = readJsonSafe(SETTINGS_FILE, {});
    if (settings?.settings && !settings.settings[VEC_DIMS_KEY]) {
        if (!settings.settings) settings.settings = {};
        settings.settings[VEC_DIMS_KEY] = currentDims;
        writeJsonSafe(SETTINGS_FILE, settings);
    }

    console.log(`[dbWorker] Initialized (${currentDims} dims, cosine, meta v${EMBEDDING_VERSION})`);
}

function storeEmbedding(table, idCol, itemType, campaignId, itemId, embeddingArray) {
    if (!db) return;
    const embedding = new Float32Array(embeddingArray);
    db.prepare(`DELETE FROM ${table} WHERE campaign_id = ? AND ${idCol} = ?`).run(campaignId, itemId);
    db.prepare(`INSERT INTO ${table}(campaign_id, ${idCol}, embedding) VALUES (?, ?, ?)`).run(campaignId, itemId, embedding);
    db.prepare(`INSERT OR REPLACE INTO embedding_meta (campaign_id, item_type, item_id, version, updated_at) VALUES (?, ?, ?, ?, ?)`)
        .run(campaignId, itemType, itemId, EMBEDDING_VERSION, Date.now());
}

function normalizeScopeIds(scopeIds) {
    if (scopeIds === undefined || scopeIds === null) return null;
    if (!Array.isArray(scopeIds)) return null;
    const filtered = scopeIds.filter(s => typeof s === 'string' && s.length > 0);
    return filtered.length > 0 ? filtered : null;
}

const SCOPE_FALLBACK_OVERFETCH_CAP = 64;

function searchVector(table, idCol, resultKey, itemType, applyMmr, campaignId, queryEmbeddingArray, limit, diversity = true, opts = {}) {
    if (!db) return [];
    const queryEmbedding = new Float32Array(queryEmbeddingArray);
    const useMmr = applyMmr && diversity !== false;
    const poolSize = useMmr ? Math.max(limit, MMR_MIN_POOL, limit * 3) : limit;
    const cols = useMmr ? `${idCol}, distance, embedding` : `${idCol}, distance`;
    
    try {
        let rows;
        const scopeIds = normalizeScopeIds(opts.scopeIds);
        if (scopeIds) {
            try {
                const placeholders = scopeIds.map(() => '?').join(',');
                rows = db.prepare(`
                    SELECT ${cols}
                    FROM ${table}
                    WHERE embedding MATCH ? AND campaign_id = ? AND ${idCol} IN (${placeholders})
                    ORDER BY distance
                    LIMIT ?
                `).all(queryEmbedding, campaignId, ...scopeIds, poolSize);
            } catch (scopeErr) {
                console.warn(`[dbWorker] ${table} scoped search (SQL IN) failed, falling back to over-fetch: ${scopeErr.message}`);
                const overFetch = Math.min(limit * 4, SCOPE_FALLBACK_OVERFETCH_CAP);
                rows = db.prepare(`
                    SELECT ${cols}
                    FROM ${table}
                    WHERE embedding MATCH ? AND campaign_id = ?
                    ORDER BY distance
                    LIMIT ?
                `).all(queryEmbedding, campaignId, overFetch);
                const scopeSet = new Set(scopeIds);
                rows = rows.filter(r => scopeSet.has(r[idCol]));
            }
        } else {
            rows = db.prepare(`
                SELECT ${cols}
                FROM ${table}
                WHERE embedding MATCH ? AND campaign_id = ?
                ORDER BY distance
                LIMIT ?
            `).all(queryEmbedding, campaignId, poolSize);
        }
        
        const currentVersion = EMBEDDING_VERSION;
        const staleIds = new Set();
        if (rows.length > 0) {
            const ids = rows.map(r => r[idCol]);
            const placeholders = ids.map(() => '?').join(',');
            const metaRows = db.prepare(
                `SELECT item_id, version FROM embedding_meta WHERE campaign_id = ? AND item_type = ? AND item_id IN (${placeholders})`
            ).all(campaignId, itemType, ...ids);
            const metaIds = new Set(metaRows.map(m => m.item_id));
            for (const m of metaRows) {
                if (m.version < currentVersion) staleIds.add(m.item_id);
            }
            for (const id of ids) {
                if (!metaIds.has(id)) staleIds.add(id);
            }
        }

        const fresh = rows.filter(r => !staleIds.has(r[idCol]));

        if (useMmr && fresh.length >= MMR_MIN_POOL && fresh.length > limit) {
            const pool = fresh
                .map(r => ({
                    id: r[idCol],
                    score: 1 - r.distance,
                    vector: blobToFloat32(r.embedding),
                }))
                .filter(p => p.vector);
            if (pool.length > 0) {
                return mmrSelect(pool, limit).map(h => ({ [resultKey]: h.id, distance: 1 - h.score }));
            }
        }

        return fresh.slice(0, limit).map(r => ({ [resultKey]: r[idCol], distance: r.distance }));
    } catch (err) {
        console.error(`[dbWorker] ${table} search failed:`, err.message);
        return [];
    }
}

function deleteEmbedding(table, idCol, itemType, campaignId, itemId) {
    if (!db) return;
    db.prepare(`DELETE FROM ${table} WHERE campaign_id = ? AND ${idCol} = ?`).run(campaignId, itemId);
    db.prepare(`DELETE FROM embedding_meta WHERE campaign_id = ? AND item_type = ? AND item_id = ?`).run(campaignId, itemType, itemId);
}

function deleteCampaignRulesEmbeddings(campaignId) {
    if (!db) return;
    db.prepare("DELETE FROM rules_vss WHERE campaign_id = ?").run(campaignId);
    db.prepare("DELETE FROM embedding_meta WHERE campaign_id = ? AND item_type = 'rule'").run(campaignId);
}

function deleteCampaignEmbeddings(campaignId) {
    if (!db) return;
    db.prepare("DELETE FROM archive_vss WHERE campaign_id = ?").run(campaignId);
    db.prepare("DELETE FROM lore_vss WHERE campaign_id = ?").run(campaignId);
    db.prepare("DELETE FROM rules_vss WHERE campaign_id = ?").run(campaignId);
    db.prepare("DELETE FROM embedding_meta WHERE campaign_id = ?").run(campaignId);
}

function getEmbeddingStatus(campaignId) {
    if (!db) return { scenes: { total: 0, current: 0, stale: 0 }, lore: { total: 0, current: 0, stale: 0 }, rules: { total: 0, current: 0, stale: 0 }, version: EMBEDDING_VERSION };
    const currentVersion = EMBEDDING_VERSION;
    const sceneMeta = db.prepare("SELECT version, COUNT(*) as count FROM embedding_meta WHERE campaign_id = ? AND item_type = 'scene' GROUP BY version").all(campaignId);
    const loreMeta = db.prepare("SELECT version, COUNT(*) as count FROM embedding_meta WHERE campaign_id = ? AND item_type = 'lore' GROUP BY version").all(campaignId);
    const rulesMeta = db.prepare("SELECT version, COUNT(*) as count FROM embedding_meta WHERE campaign_id = ? AND item_type = 'rule' GROUP BY version").all(campaignId);

    let scenesTotal = 0, scenesCurrent = 0, scenesStale = 0;
    for (const row of sceneMeta) {
        scenesTotal += row.count;
        if (row.version >= currentVersion) scenesCurrent += row.count;
        else scenesStale += row.count;
    }

    let loreTotal = 0, loreCurrent = 0, loreStale = 0;
    for (const row of loreMeta) {
        loreTotal += row.count;
        if (row.version >= currentVersion) loreCurrent += row.count;
        else loreStale += row.count;
    }

    let rulesTotal = 0, rulesCurrent = 0, rulesStale = 0;
    for (const row of rulesMeta) {
        rulesTotal += row.count;
        if (row.version >= currentVersion) rulesCurrent += row.count;
        else rulesStale += row.count;
    }

    return {
        scenes: { total: scenesTotal, current: scenesCurrent, stale: scenesStale },
        lore: { total: loreTotal, current: loreCurrent, stale: loreStale },
        rules: { total: rulesTotal, current: rulesCurrent, stale: rulesStale },
        version: EMBEDDING_VERSION,
    };
}

function getStaleAndUnversionedIds(campaignId, itemType) {
    if (!db) return { stale: [], unversioned: [] };
    const table = itemType === 'scene' ? 'archive_vss' : itemType === 'lore' ? 'lore_vss' : 'rules_vss';
    const idCol = itemType === 'scene' ? 'scene_id' : itemType === 'lore' ? 'lore_id' : 'rule_id';
    
    const staleRows = db.prepare(`SELECT item_id FROM embedding_meta WHERE campaign_id = ? AND item_type = ? AND version < ?`).all(campaignId, itemType, EMBEDDING_VERSION);
    const unversionedRows = db.prepare(`SELECT ${idCol} FROM ${table} WHERE campaign_id = ? AND ${idCol} NOT IN (SELECT item_id FROM embedding_meta WHERE campaign_id = ? AND item_type = ?)`).all(campaignId, campaignId, itemType);
    
    return {
        stale: staleRows.map(r => r.item_id),
        unversioned: unversionedRows.map(r => r[idCol])
    };
}

function getVssIds(campaignId, itemType) {
    if (!db) return [];
    const table = itemType === 'scene' ? 'archive_vss' : itemType === 'lore' ? 'lore_vss' : 'rules_vss';
    const idCol = itemType === 'scene' ? 'scene_id' : itemType === 'lore' ? 'lore_id' : 'rule_id';
    return db.prepare(`SELECT ${idCol} FROM ${table} WHERE campaign_id = ?`).all(campaignId).map(r => r[idCol]);
}

// ─── IPC Router ───
if (parentPort) {
    parentPort.on('message', async (msg) => {
        const { id, action, args } = msg;
        try {
            let result;
            switch (action) {
                case 'initDb':
                    initDb();
                    result = { success: true };
                    break;
                case 'storeArchiveEmbedding':
                    storeEmbedding('archive_vss', 'scene_id', 'scene', ...args);
                    result = { success: true };
                    break;
                case 'storeLoreEmbedding':
                    storeEmbedding('lore_vss', 'lore_id', 'lore', ...args);
                    result = { success: true };
                    break;
                case 'storeRulesEmbedding':
                    storeEmbedding('rules_vss', 'rule_id', 'rule', ...args);
                    result = { success: true };
                    break;
                case 'searchArchive':
                    result = searchVector('archive_vss', 'scene_id', 'sceneId', 'scene', true, ...args);
                    break;
                case 'searchLore':
                    result = searchVector('lore_vss', 'lore_id', 'loreId', 'lore', true, ...args);
                    break;
                case 'searchRules':
                    result = searchVector('rules_vss', 'rule_id', 'ruleId', 'rule', false, ...args);
                    break;
                case 'deleteArchiveEmbedding':
                    deleteEmbedding('archive_vss', 'scene_id', 'scene', ...args);
                    result = { success: true };
                    break;
                case 'deleteRulesEmbedding':
                    deleteEmbedding('rules_vss', 'rule_id', 'rule', ...args);
                    result = { success: true };
                    break;
                case 'deleteCampaignRulesEmbeddings':
                    deleteCampaignRulesEmbeddings(...args);
                    result = { success: true };
                    break;
                case 'deleteCampaignEmbeddings':
                    deleteCampaignEmbeddings(...args);
                    result = { success: true };
                    break;
                case 'getEmbeddingStatus':
                    result = getEmbeddingStatus(...args);
                    break;
                case 'getStaleAndUnversionedIds':
                    result = getStaleAndUnversionedIds(...args);
                    break;
                case 'getVssIds':
                    result = getVssIds(...args);
                    break;
                default:
                    throw new Error(`Unknown action: ${action}`);
            }
            parentPort.postMessage({ id, result });
        } catch (err) {
            parentPort.postMessage({ id, error: err.message });
        }
    });
}
