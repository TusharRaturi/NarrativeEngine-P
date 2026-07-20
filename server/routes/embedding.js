import os from 'os';
import { Router } from 'express';
import { isModelReady, embedBatch } from '../lib/embedder.js';
import { getActiveJobs } from '../lib/embedJobs.js';
import { wrapAsync } from '../lib/asyncHandler.js';

/**
 * Suggest an indexing-speed default from the host's CPU/RAM. Conservative on purpose:
 * embedding is CPU-bound and shares the box with the game, so we only recommend
 * 'aggressive' on clearly capable machines.
 */
function suggestSpeed(cores, totalMemGB) {
    if (cores >= 12 && totalMemGB >= 16) return 'aggressive';
    if (cores >= 6 && totalMemGB >= 8) return 'balanced';
    return 'eco';
}

export function createEmbeddingRouter() {
    const router = Router();

    // Live embedder state: is the model warm, and what bulk embeds are in flight.
    // Polled by the client to drive the indexing snackbar. `?campaignId=` filters jobs.
    router.get('/api/embedding/runtime', wrapAsync((req, res) => {
        res.json({
            modelReady: isModelReady(),
            jobs: getActiveJobs(req.query.campaignId),
        });
    }));

    // Host hardware summary + a suggested indexing speed. Used once on first run to
    // offer a sensible default the user can accept or change.
    router.get('/api/system/specs', wrapAsync((_req, res) => {
        const cores = os.cpus()?.length ?? 0;
        const totalMemGB = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10;
        res.json({
            cores,
            totalMemGB,
            cpuModel: os.cpus()?.[0]?.model?.trim() ?? 'unknown',
            suggestedSpeed: suggestSpeed(cores, totalMemGB),
        });
    }));

    router.post('/api/embedding/batch-compute', wrapAsync(async (req, res) => {
        const { texts } = req.body;
        if (!Array.isArray(texts)) {
            return res.status(400).json({ error: 'texts must be an array of strings' });
        }
        
        // Use a relatively aggressive batch config since this is a user-initiated active block
        const vectors = await embedBatch(texts, 12, 10);
        
        // Convert Float32Arrays back to regular arrays for JSON serialization
        const serialized = vectors.map(v => Array.from(v));
        res.json({ embeddings: serialized });
    }));

    return router;
}
