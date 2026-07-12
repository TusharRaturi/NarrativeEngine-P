// Eval fixture builder (Plan 3). Embeds every fixture campaign's scenes/lore and
// queries with the REAL model for a given preset, caching vectors to
// `vectors.<preset>.json` next to each `campaign.json`. The eval suite then runs
// entirely offline against the cache(s), deterministic and fast.
//
//   npm run eval:build         # 'standard' preset — 384-dim MiniLM (bundled, offline)
//   npm run eval:build:high    # 'high' preset     — 768-dim bge-base (downloads from HF once)
//
// Presets mirror the app's `settings.embeddingModel` ('standard' | 'high'). The
// embedding call matches src/services/embedding/embedder.worker.ts exactly (mean
// pool, L2-normalize, 1500-char single-pass + windowed pooling, dtype q8, and —
// like the app — NO query instruction prefix, even for bge).
import { pipeline, env } from '@huggingface/transformers';
import fs from 'node:fs';
import path from 'node:path';

// queryPrefix is applied to QUERIES ONLY (passages stay raw) — the asymmetric
// retrieval setup bge expects. MiniLM is symmetric, so it gets no prefix.
const PRESETS = {
    standard: { model: 'Xenova/all-MiniLM-L6-v2', bundled: true, queryPrefix: '' },
    high: { model: 'Xenova/bge-base-en-v1.5', bundled: false, queryPrefix: '' },
    highPrefix: { model: 'Xenova/bge-base-en-v1.5', bundled: false, queryPrefix: 'Represent this sentence for searching relevant passages: ' },
};

const preset = process.argv[2] ?? 'standard';
const cfg = PRESETS[preset];
if (!cfg) {
    console.error(`[eval:build] unknown preset "${preset}" — use one of: ${Object.keys(PRESETS).join(', ')}`);
    process.exit(1);
}

const SINGLE_PASS_LIMIT = 1500;
const WINDOW_SIZE = 1000;
const WINDOW_STRIDE = 700;

env.allowLocalModels = true;
env.localModelPath = path.resolve('public/models'); // bundled 'standard' loads from here
env.allowRemoteModels = !cfg.bundled;               // 'high' downloads from HF the first time

const FIXTURES_ROOT = path.resolve('src/services/__evals__/fixtures');
const round = (v) => Math.round(v * 1e6) / 1e6;

console.log(`[eval:build] preset=${preset} model=${cfg.model} (${cfg.bundled ? 'bundled/offline' : 'remote download'})`);
const pipe = await pipeline('feature-extraction', cfg.model, { dtype: 'q8' });

async function embedOnce(text) {
    const out = await pipe(text, { pooling: 'mean', normalize: true });
    return Array.from(out.data);
}

async function embed(text) {
    if (text.length <= SINGLE_PASS_LIMIT) return (await embedOnce(text)).map(round);

    const windows = [];
    let i = 0;
    while (i < text.length) {
        windows.push(text.slice(i, i + WINDOW_SIZE));
        if (i + WINDOW_SIZE >= text.length) break;
        i += WINDOW_STRIDE;
    }
    const vecs = [];
    for (const w of windows) vecs.push(await embedOnce(w));
    const dim = vecs[0].length;
    const pooled = new Array(dim).fill(0);
    for (const v of vecs) for (let j = 0; j < dim; j++) pooled[j] += v[j];
    for (let j = 0; j < dim; j++) pooled[j] /= vecs.length;
    let norm = 0;
    for (let j = 0; j < dim; j++) norm += pooled[j] * pooled[j];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let j = 0; j < dim; j++) pooled[j] /= norm;
    return pooled.map(round);
}

const dirs = fs.readdirSync(FIXTURES_ROOT).filter(d => fs.existsSync(path.join(FIXTURES_ROOT, d, 'campaign.json')));

for (const dir of dirs) {
    const campaign = JSON.parse(fs.readFileSync(path.join(FIXTURES_ROOT, dir, 'campaign.json'), 'utf8'));
    const docs = { scene: [], lore: [], npc: [], rule: [] };
    for (const s of campaign.scenes ?? []) docs.scene.push({ id: s.sceneId, vector: await embed(s.content) });
    for (const l of campaign.lore ?? []) docs.lore.push({ id: l.id, vector: await embed(l.content) });
    for (const n of campaign.npcs ?? []) docs.npc.push({ id: n.id, vector: await embed(n.profile ?? n.content ?? '') });

    // Key by the RAW query text (what retrieval passes), but embed with the
    // preset's query prefix — so the cached vector is the prefixed embedding
    // while passages above stay raw. That is the asymmetric query/passage setup.
    const queries = {};
    for (const q of campaign.queries ?? []) queries[q.query] = await embed(cfg.queryPrefix + q.query);

    const out = {
        preset,
        model: cfg.model,
        generatedAt: new Date().toISOString(),
        dims: docs.scene[0]?.vector.length ?? docs.lore[0]?.vector.length ?? 0,
        docs,
        queries,
    };
    fs.writeFileSync(path.join(FIXTURES_ROOT, dir, `vectors.${preset}.json`), JSON.stringify(out));
    console.log(`[eval:build] ${dir}: ${docs.scene.length} scenes, ${docs.lore.length} lore, ${Object.keys(queries).length} queries → vectors.${preset}.json (${out.dims}d)`);
}

console.log('[eval:build] done.');
