import { Router } from 'express';
import { readJson, writeJson, divergencePath } from '../lib/fileStore.js';

export function createDivergenceRouter() {
    const router = Router();

    router.get('/api/campaigns/:id/divergence', (req, res) => {
        const data = readJson(divergencePath(req.params.id), {
            entries: [],
            lastUpdatedSceneId: '',
            lastUpdatedAt: 0,
            version: 1,
        });
        res.json(data);
    });

    router.put('/api/campaigns/:id/divergence', (req, res) => {
        writeJson(divergencePath(req.params.id), req.body);
        res.json({ ok: true });
    });

    return router;
}
