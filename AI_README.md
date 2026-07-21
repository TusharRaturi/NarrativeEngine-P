# Narrative Engine Project Architecture

This document serves as the ultimate, unified architecture diagram and system map for the Narrative Engine project, synthesizing the current active codebase structure, data flows, and sub-system responsibilities.

## 1. System Architecture & Tech Stack

The Narrative Engine is a **Monorepo** consisting of three primary workspaces:
1. **Desktop / Web App (`mainApp`)**: A Vite + React frontend with a Node/Express backend powering local files, SQLite vector stores, and HuggingFace models.
2. **Mobile App (`mobileApp`)**: A Capacitor + React native Android app utilizing IndexedDB and Transformers.js for 100% offline, on-device vector embeddings (`all-MiniLM-L6-v2`).
3. **Engine Core (`@narrative/engine`)**: A shared, platform-pure TypeScript package (no DOM, Node, or React APIs) containing the game logic (dice engines, loot tables, RRF retrieval algorithms, and JSON extractors) consumed by both apps.

### High-Level Component Diagram

```mermaid
graph TD
    %% ================= FRONTEND =================
    subgraph Frontend ["Frontend (Vite + React + TS)"]

        subgraph Components ["UI Components (src/components/)"]
            ChatArea["ChatArea.tsx: Main dialogue UI"]
            CampaignHub["CampaignHub.tsx: Coverflow UI for campaigns"]
            ContextDrawer["ContextDrawer.tsx: Displays AI context payload"]
            WorldLoreModal["WorldLoreModal.tsx: Manage global lore"]
            NPCLedgerModal["NPCLedgerModal.tsx: Manage NPCs"]
            LocationLedgerModal["LocationLedgerModal.tsx: Manage Locations"]
            SettingsModal["SettingsModal.tsx: LLM & App config"]
            OOCControls["CreateTroubleModal / ArcInjectorButton / OneShotInjectorButton"]
        end

        subgraph Store ["Zustand Store (src/store/slices/)"]
            ChatSlice["chatSlice.ts: Messages and typing state"]
            CampaignSlice["campaignSlice.ts: Current campaign metadata & state"]
            SettingsSlice["settingsSlice.ts: UI & AI API settings"]
            UISlice["uiSlice.ts: Modal/drawer visibility toggles"]
            LoreSlice["worldLoreSlice.ts: Loaded lore/facts"]
            MapSlice["mapSlice.ts: Active map data"]
        end

        subgraph Services ["Frontend Services (src/services/)"]
            TurnOrchestrator["turn/turnOrchestrator.ts: Game loop and AI turn execution"]
            ContextGatherer["turn/contextGatherer.ts: Builds the payload for LLM"]
            Retrieval["retrieval/retrievalCore.ts / semanticMemory.ts: Semantic search for lore"]
            LLMClient["llm/llmService.ts: Handles model API requests"]
            MapEngine["mapEngine/MapEngine.ts: PixiJS map visualization logic"]
            TTSClient["tts/ttsClient.ts: Voice generation client"]
            CampaignInit["campaignInit.ts: Savefile bootstrapping"]
            Parsers["NPC / Location / Lore Parsers: Translates LLM output to state"]
        end
        
        subgraph Hooks ["Custom Hooks (src/hooks/)"]
            useChatOps["useChatOperations.ts"]
            useEmbedStatus["useEmbeddingStatus.ts"]
            useRules["useRulesIndexer.ts"]
        end
        
        subgraph Utils ["Frontend Utils (src/utils/)"]
            LLMApiHelper["llmApiHelper.ts: API formatting"]
            Sampling["samplingProfiles.ts: Temperature/TopP profiles"]
            EntityRes["entityResolution.ts: Cross-referencing entities"]
        end

        %% Frontend relationships
        Components --> Store
        Components --> Hooks
        Hooks --> Store
        Hooks --> Services
        Services --> Store
        Services --> Utils
        TurnOrchestrator --> ContextGatherer
        TurnOrchestrator --> LLMClient
        Components --> TurnOrchestrator
    end

    %% ================= BACKEND =================
    subgraph Backend ["Backend API (Express/Node.js)"]

        subgraph Routes ["API Routes (server/routes/)"]
            CampaignRoute["campaigns.js / chapters.js: Game saves"]
            LLMProxy["llmProxy.js: Proxies local/remote LLM calls"]
            TTSRoute["tts.js: Audio generation endpoints"]
            EmbedRoute["embedding.js: Vector encoding endpoints"]
            VaultRoute["vault.js: Secrets and keys decryption"]
            ArchiveRoute["archive.js: Past memories"]
            FactRoute["facts.js / timeline.js: Lore management"]
            WorldRoutes["overworld.js / divergence.js / rules.js: Map, branching & rules"]
            StateRoutes["backups.js / transfer.js / assets.js: State & asset mgmt"]
        end

        subgraph Lib ["Backend Core Logic (server/lib/)"]
            FileStore["fileStore.js: JSON flat-file db I/O"]
            VectorStore["vectorStore.js: sqlite-vec vector DB interface"]
            Embedder["embedder.js: Local huggingface/transformers embedding"]
            TTSLib["tts.js: Local kokoro-js execution"]
            NLP["nlp.js: Entity extraction and resolution"]
        end

        %% Backend relationships
        Routes --> Lib
        CampaignRoute --> FileStore
        EmbedRoute --> VectorStore
        EmbedRoute --> Embedder
        TTSRoute --> TTSLib
        FactRoute --> FileStore
    end

    %% ================= PACKAGES =================
    subgraph Packages ["Monorepo Packages"]
        Engine["@narrative/engine (packages/engine): Shared pure-TS game logic (dice, loot, RRF fusion, JSON repairs) consumed by both apps"]
    end

    %% ================= MOBILE =================
    subgraph Mobile ["Mobile App (Android/Capacitor)"]
        Capacitor["React + Capacitor shell"]
        MobileDB[("IndexedDB (Local storage)")]
        MobileEmbed["Transformers.js (all-MiniLM-L6-v2) on-device"]
        Capacitor --> MobileDB
        Capacitor --> MobileEmbed
    end

    %% ================= CROSS-BOUNDARY =================
    LLMClient -- "REST API (Fetch)" --> LLMProxy
    Retrieval -- "REST API (Fetch)" --> EmbedRoute
    TTSClient -- "REST API (Fetch)" --> TTSRoute
    CampaignInit -- "REST API (Fetch)" --> CampaignRoute
    Store -.-> Engine
    Services -.-> Engine
    Capacitor -.-> Engine
    
    %% Storage Output
    FileStore --> FileStoreDB[("JSON Files (data/ dir)")]
    VectorStore --> SQLiteDB[("embeddings.db (sqlite-vec)")]
```

### Client-Server Topology (Desktop)

```text
   [ CLIENT / FRONTEND ]                            [ SERVER / BACKEND ]
+-----------------------------+              +------------------------------+
| React 19 + TypeScript + Vite |              |       Express 5 (ESM)        |
| Zustand (6 slices)          |              |  CORS allowlist (Electron +  |
| Tailwind CSS 4              |              |  Vite only), localhost-only   |
| PixiJS 8 (overworld map)    |              |  127.0.0.1:3001 bind          |
+--------------+--------------+              +--------------+---------------+
               |                                            |
     HTTP /api (Vite proxy in dev,                         |
     absolute http://localhost:3001 in Electron)           |
               +-----------------------+--------------------+
                                       |
                +----------------------v----------------------+
                |                server.js                    |
                | KeyVault auto-init → ensureDirs → initDb →  |
                | warmupEmbedder → warmupTts → mount 16       |
                | routers → listen 127.0.0.1:3001             |
                +-------+-----------------+-------------------+
                        |                 |
              +---------v------+   +-------v----------+
              | better-sqlite3 |   | File I/O         |
              | + sqlite-vec    |   | data/campaigns/  |
              | (archive_vss,  |   | <id>.archive.md  |
              |  lore_vss,     |   | <id>.archive.    |
              |  rules_vss)    |   |   index.json     |
              | cosine distance|   | <id>.archive.    |
                +---------+------+   |   chapters.json  |
                          |          | <id>.timeline.json
                  +-------v------+    | <id>.entities.json
                  | embedder.js  |    | <id>.facts.json
                  | mxbai-embed-  |    | <id>.lore.json
                  | large-v1 q8   |    | <id>.npcs.json
                  | 1024 dims    |    | <id>.overworld.json
                  | LRU 512      |    | <id>.divergence.json
                  +--------------+    +------------------+
```

### Technology Stack
| Layer | Technology |
|-------|-----------|
| Frontend | React 19.2 + TypeScript 5.9 (strict) + Vite 8 + Tailwind 4 (w/ react-markdown, remark-gfm, lucide-react) |
| State | Zustand 5 (6 slices: settings, campaign, chat, ui, map, worldLore) |
| Backend | Express 5 (ESM), Node ≥ 20.19, localhost-only bind |
| Database | JSON files per campaign in `data/campaigns/<id>/` |
| Vector search | better-sqlite3 + sqlite-vec (cosine distance, 3 vec0 tables) |
| Embedding | `@huggingface/transformers` local ONNX `mixedbread-ai/mxbai-embed-large-v1` q8, 1024 dims |
| Token counting | js-tiktoken |
| TTS | `kokoro-js` Kokoro-82M q8 (lazy warmup, SHA-256 WAV cache) |
| LLM streaming | Direct fetch to Ollama / OpenAI / Claude / Gemini via per-endpoint priority queue |
| LLM proxy | Server-side `/llm/proxy` route forwards provider calls to dodge browser CORS |
| Encryption | Node `crypto` AES-256-GCM + PBKDF2-SHA256 600k iterations (password) or 10k (machine key) |
| Desktop | Electron (nodeIntegration:false, contextIsolation:true) |
| Shared core | `@narrative/engine` (file-linked `packages/engine`, platform-pure, no DOM/Node libs) |

---

## 2. Data Flow: Sequence of a Single Turn

This diagram shows the deterministic pipeline of a "Game Turn", tracking how an action moves from the UI, through the orchestrator and vector databases, to the LLM, and back to file storage.

```mermaid
sequenceDiagram
    autonumber
    actor Player
    participant UI as ChatArea.tsx
    participant PC as pendingCommit.ts
    participant TO as turnOrchestrator.ts
    participant CG as contextGatherer.ts
    participant PB as payloadBuilder.ts
    participant LS as llmService.ts
    participant PT as postTurnPipeline.ts
    participant SRV as Express (server.js)

    Player->>UI: Types message & clicks "Send"
    UI->>PC: commitPendingTurn() (finalise PREVIOUS turn)
    PC->>PT: runPostTurnPipeline() on previous committed text
    PT->>SRV: POST /api/campaigns/:id/archive (NLP + embed + store)
    SRV-->>PT: { sceneId }
    PC->>PC: Auto-condense check
    PC->>PC: clearPendingTurnSnapshot()

    UI->>TO: runTurn(state, callbacks, abortController)
    TO->>TO: rollEngines(context) — pre-rolled dice pool
    TO->>TO: resolveManualRoll() / resolveLootDrop() / buildOneShotDirective()
    TO->>UI: Add user message bubble (sync)
    TO->>CG: gatherContext() [phase: gathering-context]
    par
        CG->>CG: gatherPlannerSceneIds (LLM, tier-gated)
    and
        CG->>SRV: POST /archive/semantic-candidates (vector search)
    and
        CG->>SRV: GET /archive/next-scene (pre-assign scene #)
    and
        CG->>CG: gatherRecommender (LLM, tier-gated)
    and
        CG->>CG: gatherLoreAndRules (IDF+RRF)
    end
    CG-->>TO: GatheredContext (scenes, lore, rules, NPCs, facts)
    TO->>TO: rollCharacterIntroEngine (LLM, tier-gated) [phase: building-prompt]
    TO->>PB: buildPayload(...)
    PB-->>TO: { messages: OpenAIMessage[], trace? }
    TO->>LS: sendMessage(provider, payload, onChunk, onDone, tools?, abort)
    LS->>LS: Acquire slot from per-endpoint queue
    LS->>SRV: POST /llm/proxy (CORS dodge for NVIDIA etc.)
    SRV-->>LS: SSE / NDJSON stream
    LS-->>UI: Stream chunks → updateLastAssistant() [phase: generating]
    TO->>TO: onDone: extractAndStripSceneStakes, build SwipeVariant
    TO->>PC: capturePendingTurnSnapshot() (freeze messages + cached payload)
    TO->>UI: setPipelinePhase('idle')

    Note over Player,UI: Player browses swipes (2-5) generated lazily from cached payload
    Player->>UI: Clicks send again OR switches campaign
    UI->>PC: commitPendingTurn() — loop back to step 2
```

---

## 3. Server Initialization Order (`server.js`)

1. `new KeyVault(DATA_DIR)` — init crypto vault
2. `ensureDirs()` — create data/, campaigns/, backups/, public/assets/portraits/
3. `Auto-create vault with machine key` — if missing
4. `Auto-unlock machine-key vaults` — on startup; password vaults require manual frontend unlock
5. `CORS allowlist` (Electron 'null' + Vite) — reject all other origins
6. `express.json({ limit: '500mb' })` — middleware
7. `express.static(assets)` — portrait serving (dev: public/assets/portraits, prod: data/portraits)
8. `initDb()` — SQLite + sqlite-vec (3 vec0 tables, cosine distance)
9. `warmupEmbedder()` (fire-and-forget) — pre-load mxbai-embed-large-v1 q8
10. `warmupTts()` (fire-and-forget, no-op if not cached) — pre-load Kokoro-82M q8
11. Mount 16 routers in order: `vault`, `settings`, `campaigns`, `archive`, `chapters`, `timeline`, `facts`, `backups`, `assets`, `overworld`, `transfer`, `divergence`, `rules`, `llmProxy`, `embedding`, `tts`
12. Central error handler (`serverError`)
13. `app.listen(3001, '127.0.0.1', ...)` — localhost-only bind

---

## 4. API Route Table

All routes are mounted under `/api` in the backend Express router.

### Critical Routes
| Route | Methods | Subsystem Handled |
|---|---|---|
| `/vault/*` | GET/POST/PUT/DELETE | Key encryption, unlock, import/export, setup |
| `/settings` | GET/PUT | App Settings (`stripApiKeys` before persist) |
| `/campaigns/:id` | GET/PUT/DELETE | Campaign CRUD + lastPlayedAt bump |
| `/campaigns/:id/archive` | GET/POST/DELETE | Archive management, vector scene search (`semantic-candidates`) |
| `/campaigns/:id/archive/chapters` | GET/PUT/POST/PATCH | Chapter auto-seal, merge, split operations |
| `/campaigns/:id/timeline` | GET/POST/DELETE | Resolved timeline events |
| `/campaigns/:id/facts` | GET/PUT | Semantic Lore extraction |
| `/campaigns/:id/divergence` | GET/POST | Alternate timelines, branching scenarios |
| `/campaigns/:id/overworld` | GET/PUT/POST | Overworld map state and landmarks |
| `/backups` | GET/POST | Campaign save backups |
| `/transfer` | POST | Campaign import/export migrations |
| `/assets/*` | GET/POST | Asset management (portraits, audio) |
| `/llm/proxy` | POST | Transparent streaming proxy |
| `/rules/embed|search|reindex` | POST | Rules RAG Chunk vectors |
| `/tts/*` | GET/POST | Local Kokoro TTS Synthesis & caching |
| `/embeddings/info` | GET | Check local HuggingFace Embedder status |

---

## 5. Subsystem Feature Map & Deep-Dives

| Subsystem | Primary Directory | Key Files | Role |
|---|---|---|---|
| **Turn Orchestration** | `src/services/turn/` | `turnOrchestrator.ts`, `pendingCommit.ts`, `contextGatherer.ts`, `aiTier.ts` | Main game loop, swipe lifecycle, tier feature matrix |
| **NPC Agency** | `src/services/npc/agency/` | `agencyEngine.ts`, `agencyBands.ts`, `agencyGoals.ts`, `agencyCollision.ts` | Heartbeat-driven off-screen NPC life, goal rolls, hex drift, timeskip |
| **NPC Generation** | `src/services/npc/` | `npcDetector.ts`, `npcBehaviorDirective.ts`, `reactionMenu.ts`, `hexRoll.ts` | Name detection (7-pass), hex roll inside envelope, reaction menu |
| **Prompt Assembly** | `src/services/payload/` | `payloadBuilder.ts`, `stable.ts`, `volatile.ts`, `world.ts`, `history.ts` | 5-block payload assembly with Anthropic prompt-cache annotations |
| **Archive Memory** | `src/services/archive-memory/` | `recall.ts`, `idf.ts`, `deepArchiveSearch.ts`, `archiveChapterEngine.ts` | RRF hybrid retrieval, IDF, dynamic ceiling, deep search, chapter funnel |
| **Rules/Lore RAG** | `src/services/rules|lore/`| `defaultRules.ts`, `loreChunker.ts`, `loreRetriever.ts` | RAG rules chunking + IDF+RRF retrieval, lore-consistency verifier |
| **LLM Interface** | `src/services/llm/` | `llmService.ts`, `llmRequestQueue.ts`, `llmFetch.ts` | Streaming chat, per-endpoint adaptive concurrency queue |
| **Shared Engine** | `packages/engine/` | `src/{json,loot,retrieval,rolls}/` | Platform-pure shared core (no DOM/Node) consumed by both apps |

### Deep Dive: Context Gathering & Vector Search (`sqlite-vec` + `Transformers`)
To preserve user privacy and offline capabilities, the engine relies heavily on local ML executing within the Node process (`server/lib/`):
*   **Local Embedding (`embedder.js`)**: Uses `@huggingface/transformers` to vectorize chat messages and lore *locally*, preventing token leakage to third parties.
*   **Vector DB (`vectorStore.js`)**: Instead of relying on Pinecone or Milvus, the backend uses `sqlite-vec` to manage a local `embeddings.db` file. When `ContextGatherer` runs, it asks `vectorStore` to calculate Cosine Similarity between the current chat and all stored timeline events to pull "memories".
*   **Local Voice (`tts.js`)**: Uses `kokoro-js` to locally synthesize speech for NPC dialogue without API costs.

### Deep Dive: Encryption & `KeyVault` (`vault.js`)
To protect LLM API Keys (OpenAI, Anthropic) while running locally, the project implements a custom `AES-256-GCM` encryption vault (`apikeys.vault`):
*   **File format**: Custom binary wrapper starting with a `NEV1` magic string, an Initialization Vector (IV), Ciphertext, and a GCM Auth Tag.
*   **Password Derivation**: Uses PBKDF2 (600,000 iterations) to derive a 256-bit key from user passwords.
*   **Machine Keys**: If the user skips a password, a machine-specific key is generated using their OS Hostname and Username.
*   **Electron Integration**: When running inside the desktop wrapper, it utilizes Electron's `safeStorage` to persist the vault unlock key in the OS Credential Manager (Keychain/Keyring).

### Deep Dive: Zustand Store Cross-Slice Dependencies (`src/store/`)
The store relies on a specific dependency structure with 6 composed slices, managed via `_registerCampaignStateGetter`:
*   **Settings Slice**: Reads `activeCampaignId` (from Campaign Slice) for the save context.
*   **Campaign Slice**: Reads `settings` and `messages` (from Chat and Settings). Dynamically imports `commitPendingTurn`.
*   **Chat Slice**: Reads `activeCampaignId`, `context`, and `archiveIndex` (from Campaign).

### Deep Dive: UI Component Key Surfaces (`src/components/`)
*   **`App.tsx`**: Contains the Vault-gate loader.
*   **`ChatArea.tsx`**: Master shell managing swipe generation, scene notes, OOC side panel, PC creation wizard, and indexing banners.
*   **`MessageBubble.tsx`**: Implements touch-swipe navigation (50px threshold), TTS karaoke highlighting, and a `<dim>` block extraction spinning ReasoningViewer.
*   **`ContextDrawer.tsx`**: Contains 8 context tabs (System Context, Rules, World Info, Engines, Chapters, Memory, PC Profile, Bookkeeping).

### Deep Dive: Cross-Cutting Concerns
*   **LLM Call Tracking**: Managed via `useSyncExternalStore` to show an in-flight countdown in the UI for utility AI tasks.
*   **Cache Telemetry**: `cacheTelemetry.ts` records DeepSeek prompt-cache hits/misses, retaining logs for 14 days for the Debug UI.
*   **Background Queue**: Fire-and-forget task queue `makeGuarded()` to prevent running background tasks on campaigns that have been swapped away.
*   **JSON Extraction**: `extractJsonRobust` acts as a resilient backend parser handling broken or trailing balanced-braces in LLM outputs.

### Deep Dive: Divergence Extractor v2 (Fact Extraction)
The fact extraction pipeline uses a bifurcated schema to handle chronological supersession of world state and lore facts:
*   **Schema**: Outputs an `ExtractedDivergences` object containing `new_facts`, `updated_facts` (with `target_fact_id`), and `invalidated_facts`.
*   **RAG Injection**: Active facts from the `divergenceRegister` are injected into the prompt using semantic entity matching, ensuring the LLM has historical context for updates.
*   **Lifecycle**: Updates and invalidations automatically tombstone the old fact (`isActive: false`) and set a `supersededBy` lineage to maintain chronological integrity.

### Deep Dive: Supported LLM Provider Roles
The engine supports decoupled providers across 5 configurable endpoints:
*   **Story AI**: Main GM narration (required).
*   **Summarizer AI**: Condensing old history into running summaries.
*   **Utility AI**: Lore checks, divergence structuring, archive reranking, rule indexing.
*   **Image AI**: Portrait and scene illustration generation.
*   **Auxiliary AI**: Witness capture, NPC intro engine, scene analysis fallback.

### Deep Dive: Overworld Map Generation
A procedurally generated world map tied to the campaign (`OverworldCanvas.tsx`):
*   Uses Perlin noise with Voronoi biome clustering (plains, hills, mountains, coast, swamp, forest, deep ocean).
*   Supports multiple shapes: single continent, two continents, archipelago, coastal kingdom.
*   Named landmarks snap to cardinal anchor positions, with a tracked player grid.

### Deep Dive: Auto-Condensation & Archive
To prevent context drift, the engine uses 3 compression strategies (Tight ~50%, Smart ~75%, Deep) for old turns. The most recent 8 messages, proper names, and dramatic moments are preserved. A Two-Phase Deep Archive Search scans LLM-generated chapter overviews first, then runs vector searches within relevant chapters.

---

## 6. Blast Radius & Impact Matrix

When modifying core files, consult this matrix to trace downstream effects to prevent regression.

| MODIFIED FILE / COMPONENT | DIRECTLY AFFECTED | DOWNSTREAM IMPACTS |
|===========================|===================|====================|
| **`server/lib/vectorStore.js`** <br/> (sqlite-vec schema, MMR, dims) | `vectorService`, `archiveService`, `archive.js`, `apiClient` | Semantic recall fails, MMR rankings break, Campaign loads lock up |
| **`server/vault.js`** <br/> (AES-256-GCM, PBKDF2, binary format) | `vault.js`, `settings.js`, `settingsSlice`, `settingsCrypto.ts` | Settings unlock fails, API keys lost, Startup routing breaks |
| **`src/store/slices/campaignSlice.ts`** <br/> (Zustand campaign state) | `useAppStore.ts`, `ContextDrawer`, `ChatArea.tsx`, `chatSlice.ts` | UI render loop breaks, Campaign hydration fails, debouncedSave breaks |
| **`src/services/llm/llmRequestQueue.ts`** <br/> (adaptive concurrency) | `llmService.ts`, `llmCall.ts`, `postTurnPipe` | Network deadlocks, Tool calls queue indefinitely |
| **`src/services/turn/pendingCommit.ts`** <br/> (swipe lifecycle / commit) | `ChatArea.tsx`, `postTurnPipe`, `chatSlice.ts`, `App.tsx` | Message swiping breaks, NLP updates skipped, Ghost messages on crash |
| **`src/services/payload/payloadBuilder.ts`** <br/> (5-block assembly + cache control)| `turnOrchestrator`, `sceneContinue`, `TokenGauge.tsx` | LLM payload malformed, Token budget overflow, Cache busts every turn |
| **`src/types/gamecontext.ts`** | All `src/` files importing types, `packages/engine/src/*` | Compile errors, Defaults change, **Campaign migrations fail** |

---

## 7. Developer Tooling & Commands

### Build, Test & Run Commands
- **Start App (Frontend + Server concurrently)**: `npm run dev` (starts server on port 3001, Vite frontend on port 5173). Alternatively, use `Start_Narrative_Engine.bat` or `start.sh`.
- **Start Backend Server only**: `node server.js`
- **Build Frontend Assets**: `npm run build`
- **Lint Codebase**: `npm run lint` or `npx eslint .`
- **Run Tests**: `npm run test` or `npx vitest`
- **Run Tests with Coverage**: `npm run test:coverage`
- **Update App**: `Update_Narrative_Engine.bat` (pulls from Git and syncs npm dependencies without touching `data/`).
- **Repair App**: `Repair_Narrative_Engine.bat` or `.sh` (Fixes `NODE_MODULE_VERSION` mismatches or native binding Rolldown errors).

### Visual Dependency Graphs (Graphify)
This codebase includes a custom parsing script to build interactive visual dependency graphs. 
After modifying imports or file configurations, run:
```bash
node scripts/patch-graph-imports.mjs
```
This will parse the codebase imports, rebuild the dependency map, and update `graphify-out/graph.json` and the interactive visual file `graphify-out/graph.html`.
