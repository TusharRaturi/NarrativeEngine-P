import { Router } from 'express';
import { Readable } from 'stream';
import { exec } from 'child_process';
import { promisify } from 'util';
import { wrapAsync } from '../lib/asyncHandler.js';

const execAsync = promisify(exec);
let cachedGcloudToken = null;
let gcloudTokenExpiry = 0;

async function getGcloudToken() {
    if (cachedGcloudToken && Date.now() < gcloudTokenExpiry) {
        return cachedGcloudToken;
    }
    try {
        const { stdout } = await execAsync('gcloud auth print-access-token');
        cachedGcloudToken = stdout.trim();
        // Tokens are valid for 1 hour. Cache for 45 minutes (2700000 ms)
        gcloudTokenExpiry = Date.now() + 2700000;
        return cachedGcloudToken;
    } catch (err) {
        console.error('[LLM Proxy] Failed to fetch gcloud token:', err.message);
        throw err;
    }
}

export function createLLMProxyRouter() {
    const router = Router();

    // Transparent relay so the browser never calls AI providers directly.
    // Fixes CORS for providers (e.g. NVIDIA) that don't send Access-Control-Allow-Origin.
    // The client builds the real target/headers/body; we forward and stream the reply back.
    router.post('/api/llm/proxy', wrapAsync(async (req, res) => {
        const { target, method = 'POST', headers = {}, body } = req.body || {};
        if (!target || typeof target !== 'string') {
            res.status(400).json({ error: 'Missing proxy target' });
            return;
        }

        const controller = new AbortController();
        // Browser aborted the turn → tear down the upstream request too.
        // NOTE: listen on `res`, not `req`. express.json() fully consumes the request
        // body before this handler runs, so `req`'s 'close' fires immediately and would
        // abort every request. `res` 'close' only fires on a real client disconnect;
        // the writableEnded guard ignores our own normal completion.
        res.on('close', () => {
            if (!res.writableEnded) controller.abort();
        });

        // Intercept magic 'gcloud' API key and substitute real token
        const authKey = Object.keys(headers).find(k => k.toLowerCase() === 'authorization');
        if (authKey && typeof headers[authKey] === 'string' && headers[authKey].toLowerCase() === 'bearer gcloud') {
            try {
                const realToken = await getGcloudToken();
                headers[authKey] = `Bearer ${realToken}`;
            } catch (err) {
                res.status(401).json({ error: `Auto-gcloud auth failed: ${err.message}` });
                return;
            }
        }

        let upstream;
        try {
            console.log(`[LLM Proxy] Fetching upstream: ${method} ${target}`);
            console.log(`[LLM Proxy] Headers:`, JSON.stringify(headers));
            upstream = await fetch(target, {
                method,
                headers,
                body: method === 'GET' || method === 'HEAD' ? undefined : body,
                signal: controller.signal,
            });
            
            // If the cached token was rejected, clear the cache and try exactly once more
            if (upstream.status === 401 && authKey && headers[authKey].startsWith('Bearer ')) {
                console.log(`[LLM Proxy] Upstream returned 401. Invalidating gcloud token cache and retrying...`);
                cachedGcloudToken = null;
                gcloudTokenExpiry = 0;
                const freshToken = await getGcloudToken();
                headers[authKey] = `Bearer ${freshToken}`;
                
                upstream = await fetch(target, {
                    method,
                    headers,
                    body: method === 'GET' || method === 'HEAD' ? undefined : body,
                    signal: controller.signal,
                });
            }
            
            console.log(`[LLM Proxy] Upstream responded with status: ${upstream.status}`);
        } catch (err) {
            console.error(`[LLM Proxy] Upstream fetch threw error:`, err);
            if (controller.signal.aborted) return; // client went away; nothing to send
            res.status(502).json({ error: `Upstream fetch failed: ${err.message}` });
            return;
        }

        // Mirror status + content-type, then pipe the body straight through.
        // No buffering → streaming UX (SSE) is preserved.
        res.status(upstream.status);
        const ct = upstream.headers.get('content-type');
        if (ct) res.setHeader('Content-Type', ct);

        if (upstream.body) {
            Readable.fromWeb(upstream.body)
                .on('error', (err) => {
                    // AbortError is expected when the client disconnects mid-stream
                    // (stop/regenerate/close). Without this handler, the error becomes
                    // an uncaught exception that crashes the entire Express backend,
                    // causing 502s on every route until the server is restarted.
                    if (err.name !== 'AbortError') {
                        console.error('[LLM Proxy] Stream error:', err.message);
                    }
                })
                .pipe(res);
        } else {
            res.end();
        }
    }));

    return router;
}