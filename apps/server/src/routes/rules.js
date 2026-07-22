import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { CAMPAIGNS_DIR, readJson } from '../lib/fileStore.js';
import { embedText, embedBatch, isModelReady } from '../lib/embedder.js';
import { storeRulesEmbedding, deleteRulesEmbedding, deleteCampaignRulesEmbeddings, searchRules, getEmbeddingStatus } from '../lib/vectorStore.js';
import { isJobRunning } from '../lib/embedJobs.js';
import { wrapAsync } from '../lib/asyncHandler.js';

function slugify(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}

function chunkRulesServer(markdown) {
    const lines = markdown.split(/\r?\n/);
    const chunks = [];
    const usedIds = new Set();
    
    let currentHeader = '';
    let currentLines = [];
    
    const flush = () => {
        const content = currentLines.join('\n').trim();
        if (content && currentHeader) {
            const baseId = slugify(currentHeader);
            let uniqueId = baseId;
            let counter = 1;
            while (usedIds.has(uniqueId)) {
                uniqueId = `${baseId}-${counter}`;
                counter++;
            }
            usedIds.add(uniqueId);
            
            chunks.push({
                id: uniqueId,
                header: currentHeader,
                content: content
            });
        }
    };
    
    for (const line of lines) {
        if (line.match(/^\s*(#{2,3})\s+(.+)/)) {
            const match = line.match(/^\s*(#{2,3})\s+(.+)/);
            flush();
            currentHeader = match[2].trim();
            currentLines = [];
        } else {
            currentLines.push(line);
        }
    }
    flush();
    return chunks;
}

export function createRulesRouter() {
    const router = Router();

    // Upsert single rule chunk embedding
    router.post('/api/campaigns/:id/rules/embed', wrapAsync(async (req, res) => {
        const campaignId = req.params.id;
        const { chunkId, text, embedding } = req.body;
        if (!chunkId || typeof text !== 'string') {
            return res.status(400).json({ error: 'chunkId and text are required' });
        }

        const vec = embedding || await embedText(text.slice(0, 500));
        await storeRulesEmbedding(campaignId, chunkId, vec);

        res.json({
            chunkId,
            modelId: 'mixedbread-ai/mxbai-embed-large-v1',
            version: 1
        });
    }));

    router.delete('/api/campaigns/:id/rules/embed/:chunkId', wrapAsync(async (req, res) => {
        const campaignId = req.params.id;
        const chunkId = req.params.chunkId;
        await deleteRulesEmbedding(campaignId, chunkId);
        res.json({ ok: true });
    }));

    // Search rules vector store (top-K candidate rule IDs)
    router.post('/api/campaigns/:id/rules/search', wrapAsync(async (req, res) => {
        const campaignId = req.params.id;
        // Non-blocking hot path — see archive semantic-candidates routes.
        if (!isModelReady() || isJobRunning(campaignId, 'rules')) {
            return res.json({ ruleIds: [], pending: true });
        }
        const { query, queryEmbedding, limit } = req.body;
        if (typeof query !== 'string' || !query.trim()) {
            return res.json({ ruleIds: [] });
        }

        const embedding = queryEmbedding || await embedText(query);
        const results = await searchRules(campaignId, embedding, limit || 15);
        res.json({ ruleIds: results.map(r => r.ruleId) });
    }));

    router.get('/api/campaigns/:id/rules/chunks', wrapAsync(async (req, res) => {
        const campaignId = req.params.id;
        const campaignStatePath = path.join(CAMPAIGNS_DIR, `${campaignId}.state.json`);
        if (!fs.existsSync(campaignStatePath)) {
            return res.status(404).json({ error: 'Campaign state not found' });
        }

        const campaignState = readJson(campaignStatePath);
        const rulesRaw = campaignState?.context?.rulesRaw || '';
        
        if (!rulesRaw.trim()) {
            return res.json({ chunks: [] });
        }

        const chunks = chunkRulesServer(rulesRaw);
        res.json({ chunks });
    }));

    router.post('/api/campaigns/:id/rules/embed-batch', wrapAsync(async (req, res) => {
        const campaignId = req.params.id;
        const { items } = req.body; // [{ chunkId, embedding }]

        try {
            await deleteCampaignRulesEmbeddings(campaignId);
        } catch (err) {
            console.warn('[Rules Reindex] Failed to clear DB explicitly:', err.message);
        }

        for (const item of items) {
            if (item.chunkId && item.embedding) {
                await storeRulesEmbedding(campaignId, item.chunkId, item.embedding);
            }
        }

        res.json({ status: 'success', totalChunks: items.length });
    }));

    return router;
}
