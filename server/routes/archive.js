/**
 * Archive Route Controller — thin HTTP adapter.
 *
 * Phase 5 split: this file is now a controller only. It parses `req.body` /
 * `req.params`, calls the appropriate `archiveService` method, and formats
 * the JSON response. No file I/O, no DB calls, no NLP, no locks live here.
 * The deferred-LLM NLP pipeline is wired at module load via registerNlpPipeline.
 */

import { Router } from 'express';
import { wrapAsync } from '../lib/asyncHandler.js';
import { serverError } from '../lib/serverError.js';
import * as svc from '../services/archiveService.js';
import { registerNlpPipeline } from '../services/nlpPipeline.js';

registerNlpPipeline();

/** Run a sync service call; route thrown AppError-shaped errors via serverError. */
function syncRoute(label, fn) {
    return wrapAsync((req, res) => {
        try { res.json(fn(req)); }
        catch (err) { serverError(res, err, label); }
    });
}

export function createArchiveRouter() {
    const router = Router();

    router.get('/api/campaigns/:id/archive/next-scene', wrapAsync((req, res) => {
        res.json(svc.getNextScene(req.params.id));
    }));

    router.post('/api/campaigns/:id/archive', wrapAsync(async (req, res) => {
        const { userContent, assistantContent } = req.body;
        if (typeof userContent !== 'string' || !userContent.trim()
            || typeof assistantContent !== 'string' || !assistantContent.trim()) {
            return res.status(400).json({ error: 'userContent and assistantContent are required non-empty strings' });
        }
        res.json(await svc.appendScene(req.params.id, req.body));
    }));

    router.delete('/api/campaigns/:id/archive', wrapAsync((req, res) => {
        res.json(svc.clearArchive(req.params.id));
    }));

    router.get('/api/campaigns/:id/archive', wrapAsync((req, res) => {
        res.json(svc.getArchiveStatus(req.params.id));
    }));

    router.get('/api/campaigns/:id/archive/index', wrapAsync((req, res) => {
        res.json(svc.getArchiveIndex(req.params.id));
    }));

    const requirePatches = (req, res) => {
        const { patches } = req.body;
        if (!Array.isArray(patches)) {
            res.status(400).json({ error: 'patches must be an array' });
            return null;
        }
        return patches;
    };

    router.patch('/api/campaigns/:id/archive/witnesses', wrapAsync((req, res) => {
        const patches = requirePatches(req, res);
        if (patches === null) return;
        res.json(svc.patchWitnesses(req.params.id, patches));
    }));

    router.patch('/api/campaigns/:id/archive/events', wrapAsync((req, res) => {
        const patches = requirePatches(req, res);
        if (patches === null) return;
        res.json(svc.patchEvents(req.params.id, patches));
    }));

    router.get('/api/campaigns/:id/archive/scenes', wrapAsync((req, res) => {
        res.json(svc.fetchScenesByIds(req.params.id, req.query.ids || ''));
    }));

    router.post('/api/campaigns/:id/archive/rename', syncRoute('Archive Rename', (req) =>
        svc.renameAcrossArchive(req.params.id, req.body?.from, req.body?.to)));

    router.delete('/api/campaigns/:id/archive/scenes-from/:sceneId', wrapAsync((req, res) => {
        res.json(svc.rollbackScenesFrom(req.params.id, req.params.sceneId));
    }));

    router.delete('/api/campaigns/:id/archive/scenes/:sceneId', syncRoute('Archive Delete', (req) =>
        svc.deleteScene(req.params.id, req.params.sceneId)));

    router.patch('/api/campaigns/:id/archive/scenes/:sceneId/assistant', wrapAsync(async (req, res) => {
        try { res.json(await svc.updateSceneAssistant(req.params.id, req.params.sceneId, req.body.assistantContent)); }
        catch (err) { serverError(res, err, 'Archive Edit-Sync'); }
    }));

    router.get('/api/campaigns/:id/archive/open', wrapAsync((req, res) => {
        svc.openArchive(req.params.id, (err) => {
            if (err) serverError(res, err, 'Archive Open');
            else res.json({ ok: true });
        });
    }));

    router.post('/api/campaigns/:id/archive/semantic-candidates', wrapAsync(async (req, res) => {
        res.json(await svc.archiveSemanticCandidates(req.params.id, req.body));
    }));

    router.post('/api/campaigns/:id/lore/semantic-candidates', wrapAsync(async (req, res) => {
        res.json(await svc.loreSemanticCandidates(req.params.id, req.body));
    }));

    router.get('/api/campaigns/:id/embeddings/status', wrapAsync(async (req, res) => {
        res.json(svc.getEmbeddingsStatus(req.params.id));
    }));

    router.get('/api/embeddings/info', wrapAsync((_req, res) => {
        res.json(svc.getEmbeddingsInfo());
    }));

    router.post('/api/campaigns/:id/embeddings/reindex', wrapAsync(async (req, res) => {
        const { type } = req.body; // 'scene' | 'lore' | 'all'
        res.json(await svc.reindexEmbeddings(req.params.id, type));
    }));

    return router;
}