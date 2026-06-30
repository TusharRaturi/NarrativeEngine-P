# Work Order — LLM Provider Proxy (fixes issue #8: NVIDIA CORS)

**Goal:** Stop the browser from calling AI providers directly. Relay every provider
call through the local Express server so CORS-restricted providers (NVIDIA
`integrate.api.nvidia.com`, and any other server-to-server API) work.

**Scope:** MVP transparent relay. ALL providers route through it (Ollama included).
No host allowlist / SSRF hardening this round (deferred, local-only threat model).
Keep all request-format logic (`getChatUrl` / `buildChatHeaders` / `buildChatBody`)
exactly where it is — the server stays a dumb forwarder.

**Why it works:** the server already runs on `127.0.0.1:3001` and the client reaches it
via `/api` (Vite-proxied in dev, absolute URL under Electron `file://` — see
`src/lib/apiBase.ts`). NVIDIA refuses browser origins but happily talks to a server.

---

## 1. New server router — `server/routes/llmProxy.js`

Pattern matches `server/routes/embedding.js` (ESM, `Router()`, `wrapAsync`).
Requires Node 18+ (global `fetch`, `Readable.fromWeb`) — already the project baseline.

```js
import { Router } from 'express';
import { Readable } from 'stream';
import { wrapAsync } from '../lib/asyncHandler.js';

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
        req.on('close', () => controller.abort());

        let upstream;
        try {
            upstream = await fetch(target, {
                method,
                headers,
                body: method === 'GET' || method === 'HEAD' ? undefined : body,
                signal: controller.signal,
            });
        } catch (err) {
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
            Readable.fromWeb(upstream.body).pipe(res);
        } else {
            res.end();
        }
    }));

    return router;
}
```

## 2. Mount it — `server.js`

Add the import next to the other route imports (after line 18):

```js
import { createLLMProxyRouter } from './server/routes/llmProxy.js';
```

Add the mount in the `// ─── Routes ───` block (after line 73,
`app.use(createEmbeddingRouter());`):

```js
app.use(createLLMProxyRouter());
```

## 3. New client helper — `src/services/llm/llmFetch.ts`

A drop-in `fetch()` replacement. Same `(url, init)` signature so call sites barely change.

```ts
import { API_BASE } from '../../lib/apiBase';

/**
 * Drop-in fetch() replacement that relays an AI-provider request through the local
 * server instead of calling the provider directly from the browser. Avoids CORS
 * failures for providers (e.g. NVIDIA) that don't allow browser origins.
 *
 * Call sites already pass a stringified JSON body and a plain headers object,
 * which is exactly what the proxy forwards.
 */
export async function llmFetch(target: string, init?: RequestInit): Promise<Response> {
    return fetch(`${API_BASE}/llm/proxy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            target,
            method: init?.method ?? 'GET',
            headers: init?.headers ?? {},
            body: typeof init?.body === 'string' ? init.body : undefined,
        }),
        signal: init?.signal ?? undefined,
    });
}
```

## 4. Swap the 5 direct-provider fetch sites → `llmFetch`

At each site: add the import and change the final `fetch(` to `llmFetch(`.
Do NOT touch the surrounding `fetchUrl` construction (Gemini `?key=` stays — it
becomes the relay `target`) or the streaming/parse code.

| File | Line | Call |
|------|------|------|
| `src/services/llm/llmService.ts` | ~50 | streaming chat (`fetch(fetchUrl, { method, headers, body, signal })`) |
| `src/services/llm/llmService.ts` | ~228 | testConnection — GET (`fetch(url, { headers })`) |
| `src/utils/llmCall.ts` | ~118 | non-streaming utility call (`fetch(fetchUrl, {...})`) |
| `src/services/archive-memory/archiveChapterEngine.ts` | ~259 | chapter summary (`fetch(fetchUrl, {...})`) |
| `src/services/npc-generation/portrait.ts` | ~36 | image generation (`fetch(url, {...})`) |

Import line for each: `import { llmFetch } from '../llm/llmFetch';`
(adjust relative depth: `../../services/llm/llmFetch` from `utils/`, etc.)

---

## Acceptance criteria

1. Configure an NVIDIA provider (`https://integrate.api.nvidia.com/v1`, format `openai`,
   `nvapi-…` key, model e.g. `meta/llama-3.1-70b-instruct`).
2. **Test Connection** in Settings → succeeds (no CORS error in console).
3. **Story turn** streams token-by-token (no buffering regression).
4. **NPC creation suggestions** and **lore check** succeed.
5. Existing providers (OpenAI / Anthropic / Gemini / Ollama) still work unchanged.
6. Aborting a turn mid-stream stops generation (server upstream torn down).

## Test notes / watch-outs

- **Dev streaming through Vite proxy:** confirm SSE still streams smoothly via the
  Vite `/api` dev proxy. `http-proxy` streams by default, so it should be fine; if dev
  feels buffered, prod (Electron, direct `localhost:3001`) is unaffected.
- **Rate-limit handling preserved:** client reads `res.status`; we mirror upstream
  status, so the 429/503/529 → `queue.onRateLimitHit()` path at `llmService.ts:59` still fires.
- **Node 18+** required (global `fetch`, `Readable.fromWeb`).
- No new deps.

## Out of scope (deferred)

- SSRF host allowlist / target validation beyond "is a string".
- Moving provider format-building to the server.
- Built-in NVIDIA preset in the Providers UI (nice-to-have, separate WO).
