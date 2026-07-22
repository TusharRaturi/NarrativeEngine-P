import express from 'express';
import cors from 'cors';
import { KeyVault } from './src/vault.js';
import { DATA_DIR, PUBLIC_ASSETS_DIR, ensureDirs } from './src/lib/fileStore.js';
import { createVaultRouter } from './src/routes/vault.js';
import { createSettingsRouter } from './src/routes/settings.js';
import { createCampaignsRouter } from './src/routes/campaigns.js';
import { createArchiveRouter } from './src/routes/archive.js';
import { createChaptersRouter } from './src/routes/chapters.js';
import { createTimelineRouter } from './src/routes/timeline.js';
import { createFactsRouter } from './src/routes/facts.js';
import { createBackupsRouter } from './src/routes/backups.js';
import { createAssetsRouter } from './src/routes/assets.js';
import { createOverworldRouter } from './src/routes/overworld.js';
import { createTransferRouter } from './src/routes/transfer.js';
import { createDivergenceRouter } from './src/routes/divergence.js';
import { createRulesRouter } from './src/routes/rules.js';
import { createLLMProxyRouter } from './src/routes/llmProxy.js';
import { createEmbeddingRouter } from './src/routes/embedding.js';
import { createTtsRouter } from './src/routes/tts.js';
import { initDb } from './src/lib/vectorStore.js';
import { warmup as warmupEmbedder } from './src/lib/embedder.js';
import { warmupTts } from './src/lib/tts.js';
import { serverError } from './src/lib/serverError.js';

const app = express();
const PORT = 3001;

// Initialize vault
const vault = new KeyVault(DATA_DIR);
ensureDirs();

// Auto-initialize vault with machine key if it doesn't exist
if (!vault.exists()) {
    vault.create({ presets: [] }, null);
    console.log('[Vault] Auto-created with machine key');
}
// Auto-unlock machine-key vaults on startup
if (!vault.isUnlocked()) {
    try {
        vault.unlock(null);
        console.log('[Vault] Auto-unlocked with machine key');
    } catch (e) {
        // Password-protected vault — frontend will prompt for password
        console.log('[Vault] Password-protected vault, manual unlock required');
    }
}

// ─── Middleware ───
// Restrict CORS to the only two legitimate origins:
//   - 'null'       → Electron production loads the frontend via file:// (origin "null")
//   - Vite dev URL → local development via http://localhost:5173
// Any other origin (e.g. a malicious website in the user's browser) is rejected,
// preventing cross-origin reads of /api/vault/keys and other sensitive endpoints.
const ALLOWED_ORIGINS = new Set(['null', 'http://localhost:5173']);
app.use(cors({
    origin(origin, cb) {
        // Allow same-origin requests (no Origin header) and allowlisted origins.
        if (!origin || ALLOWED_ORIGINS.has(origin)) return cb(null, true);
        return cb(null, false);
    },
    credentials: false,
}));
app.use(express.json({ limit: '500mb' }));
app.use('/assets/portraits', express.static(PUBLIC_ASSETS_DIR));

// ─── Vector Search Init ───
try {
    initDb();
} catch (err) {
    console.error('[VectorStore] Init failed:', err.message);
}
warmupEmbedder().catch(err => console.error('[Embedder] Warmup failed:', err.message));
warmupTts().catch(err => console.error('[TTS] Warmup failed:', err.message));

// ─── Routes ───
app.use(createVaultRouter(vault));
app.use(createSettingsRouter());
app.use(createCampaignsRouter());
app.use(createArchiveRouter());
app.use(createChaptersRouter());
app.use(createTimelineRouter());
app.use(createFactsRouter());
app.use(createBackupsRouter());
app.use(createAssetsRouter());
app.use(createOverworldRouter());
app.use(createTransferRouter());
app.use(createDivergenceRouter());
app.use(createRulesRouter());
app.use(createLLMProxyRouter());
app.use(createEmbeddingRouter());
app.use(createTtsRouter());

// ─── Central Error Handler ───
app.use((err, _req, res, _next) => {
    serverError(res, err, 'Server');
});

// ─── Start ───
app.listen(PORT, '127.0.0.1', () => {
    console.log(`[GM-Cockpit API] ✓ Running on http://localhost:${PORT}`);
    console.log(`[GM-Cockpit API]   Data dir: ${DATA_DIR}`);
});
