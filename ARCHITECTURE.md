# Narrative Engine — Architecture Map

Single-file reference for AI agents and developers. Covers directory layout,
server initialization, API routes, frontend→backend contract, state management,
data flow, and the shared engine package.

For the system map & blast radius matrix see [`AI_CODEBASE_MAP.md`](./AI_CODEBASE_MAP.md).
For exhaustive feature listings see [`FEATURE_INVENTORY.md`](./FEATURE_INVENTORY.md).
For architectural innovations see [`INNOVATIONS.md`](./INNOVATIONS.md).

---

## Directory Layout

```
mainApp/
├── server.js                       # Express entry point (127.0.0.1:3001, localhost-only)
├── server/
│   ├── vault.js                    # KeyVault class (AES-256-GCM, PBKDF2-SHA256 600k iter, NEV1 magic)
│   ├── lib/
│   │   ├── fileStore.js            # DATA_DIR paths, atomic JSON I/O (tmp+rename), path resolvers, campaign hash
│   │   ├── embedder.js             # @huggingface/transformers mxbai-embed-large-v1 q8, 1024 dims, LRU 512
│   │   ├── vectorStore.js          # better-sqlite3 + sqlite-vec, 3 vec0 tables (cosine), MMR (λ=0.7), embedding versioning
│   │   ├── nlp.js                  # 6-pass NPC name detection, keyword extraction, importance, witness heuristic, timeline regex
│   │   ├── entityResolution.js     # Levenshtein + 3-tier name normalization (exact → substring → fuzzy)
│   │   ├── tts.js                  # Kokoro-82M q8 TTS, lazy warmup, SHA-256 WAV cache, ASAR workaround
│   │   ├── embedJobs.js            # In-memory bulk embed job tracker (non-blocking signal)
│   │   ├── writeLock.js            # Per-campaign async write serializer (promise-chain lock)
│   │   ├── serverError.js         # AppError class + centralized Express error formatter
│   │   └── asyncHandler.js        # One-liner Express async route wrapper
│   ├── routes/                     # 16 route modules, all export create<Name>Router() factories
│   │   ├── vault.js                # /api/vault/* — 11 endpoints, strict allowlist validation on PUT /keys
│   │   ├── settings.js             # /api/settings — GET/PUT, stripApiKeys before persist
│   │   ├── campaigns.js            # /api/campaigns/:id — 12 endpoints, lastPlayedAt bump, lore bulk-embed
│   │   ├── archive.js              # /api/campaigns/:id/archive — 18 endpoints (append, scenes, semantic-candidates, reindex)
│   │   ├── chapters.js             # /api/campaigns/:id/archive/chapters — 7 endpoints (seal, merge, split)
│   │   ├── timeline.js             # /api/campaigns/:id/timeline — 3 endpoints, lazy v1→v2 migration from facts.json
│   │   ├── facts.js                # /api/campaigns/:id/facts + /entities — 4 endpoints, entity merge
│   │   ├── backups.js              # /api/campaigns/:id/backup(s) — 5 endpoints, pre-restore safety backup
│   │   ├── assets.js               # /api/assets/{upload,download} — 2 endpoints, path-traversal guard
│   │   ├── overworld.js            # /api/campaigns/:id/overworld — 3 endpoints, LLM generation (120s timeout)
│   │   ├── transfer.js             # /api/campaigns/:id/export + /import — 2 endpoints, bundle v1, background re-embed
│   │   ├── divergence.js           # /api/campaigns/:id/divergence — GET/PUT
│   │   ├── rules.js                # /api/campaigns/:id/rules/embed|search|reindex — RAG rules chunk endpoints
│   │   ├── llmProxy.js             # /api/llm/proxy — transparent streaming proxy (CORS dodge for NVIDIA etc.)
│   │   ├── embedding.js            # /api/embeddings/info — global embedding model info
│   │   └── tts.js                  # /api/tts/{status,init,voices,synthesize} — Kokoro TTS endpoints
│   └── services/
│       ├── archiveService.js      # 826 lines — appendScene, rollback, deleteScene, updateSceneAssistant, reindex
│       ├── archiveRepository.js    # Pure file I/O layer (no locks, no business logic)
│       ├── archiveEvents.js       # Shared EventEmitter for archive:written (breaks circular import)
│       ├── nlpPipeline.js         # Deferred LLM extraction (witness + timeline), setImmediate after res.json()
│       ├── llmProxy.js            # Server-side LLM calls (witness classification, timeline events), retry+backoff
│       ├── backup.js              # Campaign backup (directory-based) + auto-prune, MD5 hash dedup
│       └── vectorService.js       # Thin wrapper over vectorStore + embedder + embedJobs (architectural seam)
├── src/
│   ├── main.tsx                    # Vite entry → createRoot(<App/>)
│   ├── App.tsx                     # Root layout: vault-gate, ErrorBoundary, CampaignHub | Header+Drawer+ChatArea+modals
│   ├── index.css                   # Tailwind 4 entry
│   ├── lib/
│   │   └── apiBase.ts              # API_BASE / ASSET_BASE (file:// → absolute localhost:3001, else relative /api)
│   ├── types/                      # 12 files, ~1,062 lines, barrel at index.ts
│   │   ├── index.ts                # Barrel re-export
│   │   ├── llm.ts                  # ApiFormat, AiTier, ThinkingEffort, LLMProvider, AIPreset, AppSettings (44 fields)
│   │   ├── character.ts           # InventoryItem, CharacterProfile, CharacterTrait, NPCEntry (~46 fields), PersonalityHex, Goal
│   │   ├── archive.ts             # ArchiveIndexEntry, ArchiveScene, ArchiveChapter, TimelineEvent, TIMELINE_PREDICATES, SUPERSEDE_RULES
│   │   ├── campaign.ts            # SwipeVariant, ChatMessage (with sceneId, swipeSet, pendingCommit), Campaign, PinnedExcerpt
│   │   ├── divergence.ts          # DivergenceEntry, DivergenceRegister (v2), TopicClusters
│   │   ├── gamecontext.ts        # GameContext (~70 fields), PipelinePhase, DiceSystemConfig, migrateLegacyContext()
│   │   ├── arc.ts                # ArcType, ArcStance, ArcRecord, ArcWorldState
│   │   ├── loot.ts               # LootTree, LootProfile, LootDropResult, ArmedLoot
│   │   ├── lore.ts               # LoreChunk, RuleChunkMeta, WorldLoreDraft
│   │   ├── location.ts           # LocationEntry, LocationConnection, LocationSuggestion
│   │   └── map.ts                # WorldMap, BiomeDefinition, WorldAnchor, MapPin, EngineSeed
│   ├── data/
│   │   └── titles.json            # Nobility/military/religious/family/academic titles for NPC name stripping
│   ├── store/
│   │   ├── useAppStore.ts         # Zustand composition root (6 slices via create<AppState>()((...a) => ({...})))
│   │   ├── campaignStore.ts       # Bare async fetch wrappers (NOT a Zustand store)
│   │   ├── campaignHydrator.ts    # hydrateCampaign() — parallel load + migration
│   │   └── slices/
│   │       ├── settingsSlice.ts   # Settings + vault lifecycle, 6 endpoint selectors (getActiveXEndpoint)
│   │       ├── settingsHelpers.ts # Pure helpers, defaults, migrateSettings (3 legacy shapes), debouncedSaveSettings
│   │       ├── campaignSlice.ts   # Largest slice — 19 state keys, 35+ actions, debouncedSaveCampaignState (1s)
│   │       ├── chatSlice.ts       # Messages, condenser, divergence register (~20 actions), pinned excerpts, rename modal
│   │       ├── uiSlice.ts         # 27 ephemeral toggles (modals, armed roll/loot/oneshot, composerInjection, pipelinePhase)
│   │       ├── mapSlice.ts        # Overworld map state, generate/load/save/addPin/deletePin
│   │       └── worldLoreSlice.ts  # World-builder drafts (ONLY slice using localStorage: nn_world_lore_drafts)
│   ├── services/
│   │   ├── apiClient.ts           # Frontend HTTP client (api.archive.*, api.chapters.*, api.vault.*, etc.)
│   │   ├── chatEngine.ts          # Barrel: payloadBuilder + llmService + npcGeneration + tagGeneration
│   │   ├── archiveMemory.ts       # Barrel re-export from archive-memory/
│   │   ├── saveFileEngine.ts      # sealChapterCombined (chapter seal LLM call with divergences + witness corrections)
│   │   ├── campaignInit.ts        # New campaign initialization (chunk lore, seed engines, parse NPCs)
│   │   ├── characterProfileParser.ts # PC profile auto-scan
│   │   ├── characterTraitParser.ts # PC trait auto-scan
│   │   ├── inventoryParser.ts     # Inventory auto-scan
│   │   ├── locationParser.ts      # Location auto-scan + connectionBand
│   │   ├── locationHeader.ts      # resolveLocationHeader (resolved/feature-only/unknown)
│   │   ├── locationEnrich.ts      # queueLocationEnrichment (LLM background fill)
│   │   ├── engineRolls.ts         # (also in services/engine/) — re-export
│   │   ├── llm/
│   │   │   ├── llmService.ts       # sendMessage streaming (Ollama/OpenAI/Claude/Gemini + DSML fallback)
│   │   │   ├── llmRequestQueue.ts # Per-endpoint adaptive concurrency (cloud=∞, local=1), 429/503/529 recovery
│   │   │   ├── apiClient.ts        # api.* barrel (archive, chapters, facts, timeline, entities, campaigns, settings, backups, vault, rules)
│   │   │   ├── llmFetch.ts         # Drop-in fetch replacement → /llm/proxy (CORS dodge)
│   │   │   ├── cacheTelemetry.ts  # DeepSeek prompt-cache hit/miss telemetry (14-day retention)
│   │   │   ├── timeouts.ts        # AI_CALL_TIMEOUT_MS=120s, ENGINE_CALL_TIMEOUT_MS=30s
│   │   │   └── utilityCallTracker.ts # In-flight utility call UI strip + EXTEND button (useSyncExternalStore)
│   │   ├── turn/                   # 16 production files + 2 tests
│   │   │   ├── turnOrchestrator.ts # runTurn() — main game loop (509 lines)
│   │   │   ├── pendingCommit.ts   # Swipe lifecycle + commit (298 lines, PendingTurnSnapshot singleton)
│   │   │   ├── contextGatherer.ts # Parallel 5-stage gather with Promise.race safety backstop
│   │   │   ├── contextRecommender.ts # LLM-based context selection (high priority, tracked)
│   │   │   ├── postTurnPipeline.ts # 3 parallel tracks (archive/NPC/pressure) + on-stage + agency + arc ticks (774 lines)
│   │   │   ├── aiTier.ts          # TierFeature matrix (22 features), NPC_UPDATE_COOLDOWN
│   │   │   ├── toolHandlers.ts    # Lore/notebook/dice/inventory tool handlers
│   │   │   ├── toolRegistry.ts    # Declarative tool registry (accumulation mode, trace flag)
│   │   │   ├── contextMinifier.ts # Markdown strip + ~40 field abbreviations + category-prefixed lore
│   │   │   ├── sceneContinue.ts   # Continue button (USER-role directive, R6 last-segment word count, 120-word floor)
│   │   │   ├── sceneStakesTag.ts  # [[SCENE_STAKES]] tag strip + LLM fallback classifier
│   │   │   ├── sceneStakesTelemetry.ts # localStorage counter for fallback frequency
│   │   │   ├── swipeGeneration.ts # Lazy swipes 2-5 from cached payload, session temp offset
│   │   │   ├── tagGeneration.ts   # AI tag populate for 8 engine fields
│   │   │   └── gatherProgress.ts   # useSyncExternalStore stage indicator
│   │   ├── payload/                # 8 production files + 1 test
│   │   │   ├── payloadBuilder.ts  # 5-block assembly + Anthropic cache_control annotations
│   │   │   ├── stable.ts          # Static system prompt (rules, canon, header, starter, reasoning-model guard)
│   │   │   ├── volatile.ts         # Dynamic system prompt (PC stub, inventory, profile traits, location, notebook)
│   │   │   ├── world.ts           # World block (archive recall, events, lore, timeline, tiered NPCs, digests, divergence) — 532 lines
│   │   │   ├── history.ts          # History fit (newest-first), ephemeral tool cleanup, orphan protection, scene-note depth injection
│   │   │   ├── budgets.ts         # computeBudgets (rules 10%, NPC floor 5%, stable/world/volatile split)
│   │   │   ├── pinnedMemories.ts  # [PINNED MEMORIES] block formatter
│   │   │   └── traceCollector.ts   # Debug-only trace + section collector
│   │   ├── archive-memory/         # 13 production files + 2 tests
│   │   │   ├── recall.ts          # RRF fusion entry (IDF + embedding + divergence surfacing + dynamic max)
│   │   │   ├── idf.ts             # Signature-gated IDF cache (BM25 smoothing, campaign-scoped)
│   │   │   ├── scoring.ts         # scoreEntry (POV multipliers), extractContextActivations, expandActivationsWithFacts (1-hop + 2-hop)
│   │   │   ├── dynamicMax.ts      # Consensus-based recall ceiling (lean/standard/deep)
│   │   │   ├── condenser.ts       # VERBATIM_WINDOW=10, budget ratios (tight 0.5 / default 0.75 / deep 0.90)
│   │   │   ├── deepArchiveSearch.ts # 2-round LLM deep scan (chapter → scene → unscanned → partitioned summarize)
│   │   │   ├── archiveChapterEngine.ts # Auto-seal (threshold 25 OR new SESSION_ID) + iterative funnel (3D score → LLM validate → scene score)
│   │   │   ├── archiveManager.ts  # Rollback + clear (pre-rollback backup, condenser-aware)
│   │   │   ├── archivePlanner.ts  # LLM planner (rank candidate scenes by event relevance, max 5)
│   │   │   ├── backfillRunner.ts  # Frontend wrapper for server reindex endpoint
│   │   │   ├── importanceRater.ts # LLM 1-5 rating + heuristic fallback (death/betrayal/MEMORABLE keywords)
│   │   │   ├── sceneEventExtractor.ts # LLM structured event extraction (max 3, 12 event types)
│   │   │   └── witnessCapture.ts  # Regex NPC ID extraction + LLM fallback
│   │   ├── npc/                    # 15 production files + 6 tests
│   │   │   ├── npcDetector.ts     # 7-pass name extraction + fail-closed LLM validator
│   │   │   ├── npcBehaviorDirective.ts # PLAY AS directive, drift alert, knowledge boundary, reaction menu line
│   │   │   ├── npcPressureTracker.ts # Per-NPC ignored/engaged pressure, auto-archive stale
│   │   │   ├── reactionMenu.ts    # Engine-build reaction menu (sycophant-anti-pattern)
│   │   │   ├── reactionRepression.ts # Inner repression layer (concealed/leaked, BURST_THRESHOLD=4)
│   │   │   ├── relationMeter.ts   # Hidden sub-band relation meter (asymmetric rise/fall)
│   │   │   ├── hexRoll.ts         # Weighted-never-walled Gaussian hex roll inside envelope
│   │   │   ├── manualAdd.ts       # Add NPC from selection (empty/ambiguous/update/create)
│   │   │   ├── npcManualResolve.ts # Normalize + resolve against ledger
│   │   │   ├── npcReview.ts       # AI triage (40-NPC batches, 24h sentinel timeout)
│   │   │   ├── portraitPrompt.ts  # Single-subject portrait prompt builder
│   │   │   ├── signatureKit.ts    # Signature kit bounds + sanitizer (KIT_MAX_ENTRIES=8)
│   │   │   ├── troublemaker.ts    # 4 trouble arc seeds (legacy; Arc Engine is successor)
│   │   │   ├── dispositionGroups.ts # Re-export from @narrative/engine (ENVELOPES, MODIFIERS, GROUP_KEYS)
│   │   │   ├── hexVoiceGuide.ts   # Re-export from @narrative/engine (buildVoiceDirective)
│   │   │   └── agency/             # 17 production files + 9 tests
│   │   │       ├── agencyEngine.ts # runAgencyTick + bumpOnStageActivity + runTimeskipPath (386 lines)
│   │   │       ├── agencyBands.ts  # Word-band tables (relations -3..+3, 6 hex axes 7 words each)
│   │   │       ├── agencyPools.ts  # 41 TRAIT_VOCAB, 60 WANT_POOL, 56 ACTION_POOL, 29 REACTION_VOCAB
│   │   │       ├── agencyConstants.ts # All tunable knobs (DRIVE_MULT, KARMA_CAP=6, GOAL_BASE_DC=10, etc.)
│   │   │       ├── agencyDice.ts   # karmaBonus, bandFromMargin, rollGoal, nextFailStreak
│   │   │       ├── agencyDrift.ts  # hexDelta (clamp ±1), applyGoalOutcomeNudge, applyTierCross
│   │   │       ├── agencyGoals.ts  # buildGoalsFromWants, upgradeWantsToGoals (idempotent)
│   │   │       ├── agencyHeartbeat.ts # rollHeartbeat (d100 vs DC 20→0), buildProximityRoster
│   │   │       ├── agencyLifecycle.ts # isAgencyEligible, filterUpdatableNPCs, completeShortWant
│   │   │       ├── agencyProgress.ts # progressDelta, applyBandToGoal, canCrossTier, consumeTierCross
│   │   │       ├── agencySelection.ts # driveMult, contextAllow, goalScore, chooseTick
│   │   │       ├── agencyTimeskip.ts # ticksForDuration (cap 10), allocateTicks
│   │   │       ├── agencyTimeskipRun.ts # detectTimeskip (13 regex), runTimeskip, buildReturnBeatGrounding
│   │   │       ├── agencyCollision.ts # goalsCoinide, relationTone, detectCollision, resolveTangle
│   │   │       ├── agencyDigest.ts # TickDelta, buildDigest (player vs debug view)
│   │   │       ├── agencyAudition.ts # currentActivity (lazy decay), activityBumpPatch, selectTickTarget
│   │   │       └── agencyWantDraw.ts # drawShortWants(4), drawMediumWants(3) — Fisher-Yates partial shuffle
│   │   ├── npc-generation/         # Shared profile + portrait generation
│   │   │   ├── shared.ts          # generateNPCProfile, updateExistingNPCs, backfillNPCDrives
│   │   │   ├── charIntroEngine.ts # rollCharacterIntroEngine (tier-gated)
│   │   │   ├── profileRefit.ts    # Phase 1 NPC generation refit
│   │   │   └── __tests__/         # signatureKit, profileRefit tests
│   │   ├── rules/
│   │   │   ├── defaultRules.ts    # 241-line system rules template literal (with HTML-comment RAG hints)
│   │   │   ├── rulesIndexer.ts    # indexRules, deriveDefaultMeta, LLM keyword extraction
│   │   │   └── rulesRetriever.ts  # retrieveRelevantRules (classic + idf-rrf algorithms)
│   │   ├── lore/
│   │   │   ├── loreChunker.ts     # chunkLoreFile, classifyCategory (B7 [CHUNK: TYPE] fix)
│   │   │   ├── loreRetriever.ts   # retrieveRelevantLore (IDF+RRF, linked-entity cross-pull)
│   │   │   ├── loreNPCParser.ts   # parseNPCsFromLore (deterministic canon NPC seeder)
│   │   │   ├── loreEngineSeeder.ts # extractEngineSeeds (surprise/encounter/world engine seeds)
│   │   │   ├── loreCheck.ts       # runLoreCheck (consistency verifier with rewrite)
│   │   │   ├── loreKeywordEnricher.ts # enrichLoreKeywords (LLM batch, version-gated)
│   │   │   ├── lootTreeLoader.ts  # loadLootTree (WO-03 validator, never throws)
│   │   │   ├── worldLoreAI.ts     # formatLoreText, expandLoreText (auxiliary AI)
│   │   │   ├── worldLoreExport.ts # exportDraftToMarkdown + browser download
│   │   │   └── worldLoreImport.ts # classifyPastedLore (12 categories via LLM)
│   │   ├── campaign-state/
│   │   │   ├── divergenceRegister.ts # renderRegisterForPayload, mergeSealEntries, EMPTY_REGISTER
│   │   │   ├── knowledgeScope.ts  # isKnownToAnyOnStage, parseKnownByToken
│   │   │   └── timelineResolver.ts # resolveTimeline (supersession rules), formatResolvedForContext
│   │   ├── engine/
│   │   │   ├── engineRolls.ts     # rollEngines, rollDiceFairness, resolveManualRoll (3-gate)
│   │   │   ├── diceTier.ts        # mapTier (5 outcome bands: Catastrophe/Failure/Success/Triumph/Narrative Boon)
│   │   │   ├── lootEngine.ts      # resolveLootDrop (WO-05 loot tree walker)
│   │   │   └── pcCreationScript.ts # PC point-buy script (PC_POINT_BUY config)
│   │   ├── arc/
│   │   │   └── arcEngine.ts       # runArcTick, runArcSpawn (7-type systemic conflict engine)
│   │   ├── oneshot/
│   │   │   └── oneShotEvents.ts   # buildOneShotDirective (manual event injector)
│   │   ├── ooc/
│   │   │   ├── askGmHandoff.ts    # summarizeAskGmConversation (brief for next turn)
│   │   │   ├── oocService.ts      # answerOocQuestion (streaming)
│   │   │   ├── context.ts         # OocCampaignSnapshot builder
│   │   │   └── retrieval.ts       # OOC-specific retrieval
│   │   ├── mapEngine/
│   │   │   └── worldOrchestrator.ts # generateWorldMap, loadWorld
│   │   ├── context-gatherer/       # Sub-stages of gatherContext
│   │   │   ├── semanticCandidates.ts # gatherSemanticCandidates
│   │   │   ├── archiveRecall.ts   # gatherArchiveRecall
│   │   │   ├── recommenderGather.ts # gatherRecommender
│   │   │   ├── loreRulesGather.ts # gatherLoreAndRules
│   │   │   ├── pinnedChaptersGather.ts # injectPinnedChapters
│   │   │   ├── deepSearchGather.ts # gatherDeepSearch
│   │   │   └── plannerGather.ts   # gatherPlannerSceneIds
│   │   ├── retrieval/
│   │   │   ├── lexicalFusion.ts   # Re-export from @narrative/engine (fuseRRF, computeIdf)
│   │   │   └── retrievalCore.ts   # Shared retrieval helpers
│   │   ├── semantic-memory/        # PC trait retrieval
│   │   │   └── semanticMemory.ts  # queryTraits, formatTraitsForContext
│   │   └── infrastructure/
│   │       ├── backgroundQueue.ts  # Fire-and-forget queue + makeGuarded + assertStillActive
│   │       ├── jsonExtract.ts     # extractJson, extractJsonRobust (balanced-brace scan)
│   │       ├── tokenizer.ts       # countTokens (js-tiktoken)
│   │       └── settingsCrypto.ts  # AES-256-GCM encryption of providers (idb-keyval at rest)
│   ├── utils/
│   │   ├── uid.ts                 # uid() ID generator
│   │   ├── helpers.ts             # safeSceneNum, misc helpers
│   │   ├── llmCall.ts             # Non-streaming utility wrapper (retries, priority, tracking, timeout)
│   │   ├── llmApiHelper.ts        # getChatUrl, buildChatHeaders, buildChatBody, extractContent, getApiFormat
│   │   ├── llmApiHelperBundles.ts # API format-specific body builders
│   │   └── entityResolution.ts    # Frontend twin of server/lib/entityResolution.js
│   ├── test/
│   │   └── setup.ts               # jest-dom + scrollIntoView/scrollHeight polyfills
│   └── components/                 # 16 subdirectories, ~50 component files
│       ├── App.tsx                 # (see src/App.tsx above)
│       ├── Header.tsx             # Top bar: drawer toggle, title, TokenGauge, BackgroundControl, backup, AI Tier cycle
│       ├── ChatArea.tsx           # Master chat shell
│       ├── ContextDrawer.tsx      # 8-tab side panel
│       ├── CampaignHub.tsx        # Landing page (campaign list + create/import)
│       ├── CampaignFormModal.tsx  # New campaign form
│       ├── CoverflowCarousel.tsx  # Campaign cover image carousel
│       ├── SettingsModal.tsx     # 5-tab settings (Providers/Presets/Global/Advanced/Debug)
│       ├── NPCLedgerModal.tsx     # NPC ledger master modal
│       ├── LocationLedgerModal.tsx # Location ledger master modal
│       ├── BackupModal.tsx        # Backup create/restore/delete
│       ├── VaultUnlockModal.tsx   # Password prompt
│       ├── TokenGauge.tsx         # Live token budget readout (SYS/HIS/FREE)
│       ├── Toast.tsx              # Global toast notification system
│       ├── ErrorBoundary.tsx      # React error boundary wrapper
│       ├── PayloadTraceView.tsx   # Debug payload trace view
│       ├── SceneNoteEditor.tsx    # Inline scene note editor
│       ├── IndexingSpeedPrompt.tsx # Indexing speed prompt on first launch
│       ├── PinnedMemoriesPanel.tsx # Pinned memories side panel
│       ├── CreateTroubleModal.tsx  # 4 trouble arc seeds (legacy)
│       ├── RenameNpcModal.tsx     # Whole-archive NPC rename
│       ├── LoreCheckModal.tsx     # Lore consistency verifier modal
│       ├── DivergenceReviewModal.tsx # Divergence review modal
│       ├── DedupReviewModal.tsx   # Fact dedup review modal
│       ├── NPCReviewModal.tsx     # NPC review (AI triage) modal
│       ├── WorldLoreModal.tsx     # World-builder modal
│       ├── chat/                   # Chat subcomponents
│       │   ├── ChatMessageList.tsx # Scrollable message column (visible-count paging)
│       │   ├── ChatComposer.tsx   # Bottom composer (preset selector, deep-search chip, send/stop)
│       │   ├── ChatActionStrip.tsx # Action buttons (Save, Trim, Deep, Dice Me, Loot, Arc, OneShot, AskGM, Archive)
│       │   ├── ChatEmptyState.tsx
│       │   ├── ChatNavFabs.tsx     # Jump-up / jump-to-bottom FABs
│       │   ├── DiceRollModal.tsx  # 3-gate dice configurator
│       │   ├── LootRollModal.tsx  # Pre-roll loot modal
│       │   ├── RegenerateSheet.tsx # Swipe Generation v1 sheet
│       │   ├── SelectionActionsMenu.tsx # Floating toolbar over selection
│       │   ├── ToolCallChips.tsx   # Tool call chips (dice/lore/notebook/generic)
│       │   ├── UtilityCallStrip.tsx # In-flight utility call strip
│       │   ├── GenerationProgress.tsx # Pipeline phase + streaming stats
│       │   └── useSelectionActions.ts # Selection state machine hook
│       ├── message/
│       │   ├── MessageMarkdown.tsx # react-markdown + remark-gfm + NPC name chip wrapping
│       │   ├── MessageActionRail.tsx # Hover rail (edit/rewind/swipe/TTS/delete)
│       │   ├── InlineMessageEditor.tsx # WO-EDIT inline editor
│       │   ├── SwipeIndicator.tsx  # "2/5" position + chevrons
│       │   ├── ContinueButton.tsx
│       │   └── ReasoningViewer.tsx # <dim> block viewer
│       ├── context-drawer/
│       │   ├── RulesTab.tsx        # System rules editor + RAG threshold detection
│       │   ├── RulesManagerTab.tsx  # Per-rule-chunk RAG activation manager
│       │   ├── LoreTab.tsx         # Per-lore-chunk RAG mode manager
│       │   ├── EnginesTab.tsx      # Surprise/Encounter/World engines + Dice Fairness Section
│       │   ├── BookkeepingTab.tsx   # Smart-injection bookkeeping (inventory + profile + AI scan)
│       │   ├── ChapterTab.tsx      # Chapter list + seal/split/merge/regenerate
│       │   ├── ChapterCard.tsx     # Single expandable chapter row
│       │   ├── MemoryTab.tsx        # Facts + Review sub-tabs
│       │   ├── CharacterProfileEditor.tsx # Narrative traits editor (max 10 active)
│       │   ├── ResolvedStatePanel.tsx # Resolved timeline truths panel
│       │   ├── TimelineDotRow.tsx  # Per-scene importance dot row
│       │   ├── Toggle.tsx
│       │   ├── TemplateField.tsx
│       │   ├── TokenCounter.tsx
│       │   └── memory-tab/
│       │       ├── FactsView.tsx   # 3-view (Chapter/Topic/Subject) + dedup + clustering + knownBy editor
│       │       └── ReviewView.tsx  # Divergence review queue
│       ├── npc-ledger/
│       │   ├── NPCEditForm.tsx     # 890-line full NPC editor (hex axes, traits, relations, kit, boundaries)
│       │   ├── NPCListView.tsx
│       │   ├── NPCGalleryView.tsx
│       │   ├── NPCPortraitSection.tsx
│       │   └── NPCSuggestionsPanel.tsx
│       ├── location-ledger/
│       │   ├── LocationEditForm.tsx
│       │   └── LocationSuggestionsPanel.tsx
│       ├── settings-modal/
│       │   ├── ProvidersTab.tsx    # LLM provider management + connection test
│       │   ├── PresetsTab.tsx      # AI preset management + SamplingPanel
│       │   ├── GlobalSettingsTab.tsx # 562-line global preferences + VaultSection
│       │   ├── AdvancedTab.tsx     # Embedding model info + reindex + TTS init/poll
│       │   ├── DebugTab.tsx        # Debug toggles + cache telemetry + scene-stakes fallback count
│       │   ├── VaultSection.tsx    # Vault export/import
│       │   └── SamplingPanel.tsx
│       ├── pc/
│       │   ├── PCCreationWizard.tsx # 574-line 3-step wizard (questions → stats → review)
│       │   └── WorldPrimerPanel.tsx # World lore digest for newcomers
│       ├── ooc/
│       │   ├── AskGmPanel.tsx      # OOC side chat + "Pass to Story AI" brief arming
│       │   └── ArmedAskGmNote.tsx  # Visible editable session-only handoff
│       ├── tts/
│       │   └── TtsPlaybackPanel.tsx # Karaoke TTS panel (sentence/word highlight, speed, replay)
│       ├── inventory/
│       │   └── InventoryStagingBar.tsx # GM-proposed inventory change staging
│       ├── map/
│       │   ├── MapPanel.tsx        # Map panel shell (currently commented out in App.tsx)
│       │   └── OverworldCanvas.tsx # 672-line PixiJS 8 renderer
│       ├── primitives/
│       │   ├── Backdrop.tsx
│       │   └── Buttons.tsx
│       ├── world-lore/
│       │   └── WorldLoreDraftEditor.tsx # World-builder draft editor
│       ├── pinned-memories/
│       │   └── PinnedMemoriesList.tsx
│       └── hooks/
│           ├── useCampaignForm.ts  # Campaign creation form state
│           ├── useMessageEditor.ts # Inline edit + rewind + surgical delete
│           ├── useChapterSealing.ts # Manual + auto chapter sealing pipeline
│           ├── useCondenser.ts     # Trigger condense
│           ├── useSwipeVariants.ts # Swipe Generation v1 (lazy 1-at-a-time, session temp offset)
│           ├── useSceneContinue.ts # Scene Continue v1 (append-not-replace swipe)
│           ├── useNpcPortraits.ts  # NPC portrait generation/upload (bulk populate)
│           ├── useNpcReview.ts     # AI NPC ledger review (cancellable batches)
│           ├── useTtsPlayback.ts   # Per-bubble Kokoro TTS state
│           ├── useChatOperations.ts # Chat operations
│           ├── useChatPersistence.ts # Chat persistence
│           ├── useAutoresizeInput.ts # Textarea auto-resize
│           ├── useChatKeyboard.ts  # Chat keyboard shortcuts
│           └── sceneContinueFallback.ts # rebuildStateFromLiveStoreLike (no store mutation)
├── packages/
│   └── engine/                     # @narrative/engine — platform-pure shared core
│       ├── package.json            # name: @narrative/engine, main: dist/index.js
│       ├── tsconfig.json           # lib: ES2022 only (NO DOM/Node — enforces purity)
│       ├── scripts/
│       │   └── boundary-gate.mjs   # pretest hook: rejects react/zustand/express/node:* imports
│       └── src/
│           ├── index.ts            # Barrel
│           ├── json/
│           │   ├── jsonExtract.ts  # extractJson, extractJsonRobust
│           │   └── __tests__/
│           ├── loot/
│           │   ├── lootEngine.ts   # Loot tree walker
│           │   └── __tests__/
│           ├── retrieval/
│           │   ├── lexicalFusion.ts # fuseRRF (k=60), computeIdf (BM25 smoothing)
│           │   └── __tests__/
│           └── rolls/
│               ├── engineRolls.ts  # 3-gate dice engine
│               └── __tests__/
├── scripts/
│   └── patch-graph-imports.mjs    # Graphify dependency graph builder (348 lines)
├── build-server.mjs               # esbuild server → server.bundle.cjs for Electron ASAR
├── electron/
│   └── main.cjs                    # Electron main process (nodeIntegration:false, contextIsolation:true)
├── data/                           # (gitignored) campaign data, embeddings.db, tts_cache, embeddings_cache
├── public/assets/                  # 361 files: portraits, props, Snow Asset Pack, textures, tilesets
├── mobile/                         # (parallel mobile variant — outside main app scope)
├── index.html                      # Vite entry (root div, /src/main.tsx)
├── package.json                    # narrative-engine v1.0.2, type:module, 17 deps + 24 devDeps
├── vite.config.ts                  # Vite 8 + React + Tailwind 4 plugins, /api proxy → :3001
├── vitest.config.ts                # jsdom + setupFiles, includes src/** + server/__tests__
├── tsconfig.json                   # Solution-style (references app + node)
├── tsconfig.app.json               # strict, verbatimModuleSyntax, erasableSyntaxOnly, allowImportingTsExtensions
├── tsconfig.node.json              # For vite.config.ts
├── eslint.config.js                # ESLint 9 flat config (tseslint + react-hooks + react-refresh)
└── .nvmrc                          # Node 22
```

---

## Server Initialization Order (`server.js`)

```
1. new KeyVault(DATA_DIR)                     — init crypto vault
2. ensureDirs()                               — create data/, campaigns/, backups/, public/assets/portraits/
3. Auto-create vault with machine key         — if missing
4. Auto-unlock machine-key vaults             — on startup; password vaults require manual frontend unlock
5. CORS allowlist (Electron 'null' + Vite)     — reject all other origins
6. express.json({ limit: '500mb' })           — middleware
7. express.static(assets)                     — portrait serving (dev: public/assets/portraits, prod: data/portraits)
8. initDb()                                   — SQLite + sqlite-vec (3 vec0 tables, cosine distance)
9. warmupEmbedder() (fire-and-forget)         — pre-load mxbai-embed-large-v1 q8
10. warmupTts() (fire-and-forget, no-op if not cached) — pre-load Kokoro-82M q8
11. Mount 16 routers in order:
    vault, settings, campaigns, archive, chapters, timeline, facts, backups,
    assets, overworld, transfer, divergence, rules, llmProxy, embedding, tts
12. Central error handler (serverError)        — 5xx → generic message, 4xx → actual message
13. app.listen(3001, '127.0.0.1', ...)         — localhost-only bind
```

---

## API Route Table

All routes are mounted under `/api`. All route files export `create<Name>Router()` factories.

### Vault (11 endpoints)
| Method | Path | Behavior |
|---|---|---|
| GET | `/api/vault/status` | `{exists, unlocked, hasRemember}` |
| POST | `/api/vault/setup` | Create with `{password, presets}` |
| POST | `/api/vault/unlock` | Unlock with `{password, remember}` |
| POST | `/api/vault/unlock-remembered` | Unlock via OS-safeStorage remembered key |
| POST | `/api/vault/lock` | Lock vault |
| GET | `/api/vault/keys` | Get decrypted presets (403 if locked) |
| PUT | `/api/vault/keys` | Save presets (strict allowlist validation) |
| POST | `/api/vault/export` | Export as `.nevault` (encrypted with password) |
| POST | `/api/vault/import` | Import `.nevault` (merge by preset name) |
| DELETE | `/api/vault/remember` | Clear remembered key |
| DELETE | `/api/vault` | Delete vault |

### Settings (2 endpoints)
| Method | Path | Behavior |
|---|---|---|
| GET | `/api/settings` | Read `data/settings.json` |
| PUT | `/api/settings` | Write after `stripApiKeys()` (zeroes apiKey in all AI presets) |

### Campaigns (12 endpoints)
| Method | Path | Behavior |
|---|---|---|
| GET | `/api/campaigns` | List all (sorted by lastPlayedAt desc) |
| GET/PUT/DELETE | `/api/campaigns/:id` | Campaign CRUD |
| GET/PUT | `/api/campaigns/:id/state` | Game state (pinnedExcerpts preservation guard) |
| GET/PUT | `/api/campaigns/:id/lore` | Lore chunks (PUT triggers background bulk-embed with job tracking) |
| GET/PUT | `/api/campaigns/:id/npcs` | NPC ledger |
| GET/PUT | `/api/campaigns/:id/locations` | Location ledger |

### Archive (18 endpoints)
| Method | Path | Behavior |
|---|---|---|
| GET | `/api/campaigns/:id/archive/next-scene` | Next scene number + padded sceneId |
| POST | `/api/campaigns/:id/archive` | Append scene (6 NLP heuristics inline, fire-and-forget embed, chapter auto-lifecycle) |
| DELETE | `/api/campaigns/:id/archive` | Clear archive (md + index + chapters + timeline) |
| GET | `/api/campaigns/:id/archive` | `{exists, sceneCount}` |
| GET | `/api/campaigns/:id/archive/index` | Full archive index |
| PATCH | `/api/campaigns/:id/archive/witnesses` | Patch witnesses on index entries |
| PATCH | `/api/campaigns/:id/archive/events` | Patch events on index entries |
| GET | `/api/campaigns/:id/archive/scenes?ids=001,002,...` | Fetch verbatim scenes by comma-separated IDs |
| POST | `/api/campaigns/:id/archive/rename` | Whole-word rename across prose + index |
| DELETE | `/api/campaigns/:id/archive/scenes-from/:sceneId` | Rollback: remove all scenes ≥ sceneId |
| DELETE | `/api/campaigns/:id/archive/scenes/:sceneId` | Surgical single-scene delete |
| PATCH | `/api/campaigns/:id/archive/scenes/:sceneId/assistant` | Edit-sync: rewrite + rebuild index + re-embed (awaited) |
| GET | `/api/campaigns/:id/archive/open` | Open archive in OS default editor |
| POST | `/api/campaigns/:id/archive/semantic-candidates` | Vector search (returns `{sceneIds}` or `{pending:true}`) |
| POST | `/api/campaigns/:id/lore/semantic-candidates` | Lore semantic search |
| GET | `/api/campaigns/:id/embeddings/status` | `{scenes, lore, rules, version}` with stale counts |
| GET | `/api/embeddings/info` | Global `{modelId, dims, embeddingVersion}` |
| POST | `/api/campaigns/:id/embeddings/reindex` | Reindex stale + unversioned (`{type: 'scene'|'lore'|'all'}`) |

### Chapters (7 endpoints)
| Method | Path | Behavior |
|---|---|---|
| GET | `/api/campaigns/:id/archive/chapters` | List chapters |
| PUT | `/api/campaigns/:id/archive/chapters` | Replace all chapters |
| POST | `/api/campaigns/:id/archive/chapters` | Create chapter (auto-ID `CH{NN}`) |
| PATCH | `/api/campaigns/:id/archive/chapters/:chapterId` | Patch (allowlist: title, summary, keywords, npcs, majorEvents, unresolvedThreads, tone, themes, invalidated, sceneIds) |
| POST | `/api/campaigns/:id/archive/chapters/seal` | Seal open + create new open |
| POST | `/api/campaigns/:id/archive/chapters/merge` | Merge two adjacent chapters (validates `Math.abs(idxA - idxB) === 1`) |
| POST | `/api/campaigns/:id/archive/chapters/:chapterId/split` | Split at `atSceneId` into A/B halves |

### Timeline (3 endpoints)
| Method | Path | Behavior |
|---|---|---|
| GET | `/api/campaigns/:id/timeline` | List (auto-migrates from `.facts.json` on first access) |
| POST | `/api/campaigns/:id/timeline` | Add manual event (auto-increment `tl_NNNN`) |
| DELETE | `/api/campaigns/:id/timeline/:eventId` | Remove event |

### Facts & Entities (4 endpoints)
| Method | Path | Behavior |
|---|---|---|
| GET/PUT | `/api/campaigns/:id/facts` | Semantic facts |
| GET | `/api/campaigns/:id/entities` | Entity list |
| POST | `/api/campaigns/:id/entities/merge` | Merge entities (survivor absorbs consumed.aliases, rewrites facts) |

### Backups (5 endpoints)
| Method | Path | Behavior |
|---|---|---|
| POST | `/api/campaigns/:id/backup` | Create (auto-skip if hash unchanged) |
| GET | `/api/campaigns/:id/backups` | List sorted by timestamp desc |
| GET | `/api/campaigns/:id/backups/:ts` | Get meta + file list |
| POST | `/api/campaigns/:id/backups/:ts/restore` | Pre-restore safety backup + restore (allowlist-filtered) |
| DELETE | `/api/campaigns/:id/backups/:ts` | Delete backup directory |

### Assets (2 endpoints)
| Method | Path | Behavior |
|---|---|---|
| POST | `/api/assets/upload` | Upload portrait (data URL, path-traversal guard) |
| POST | `/api/assets/download` | Download remote asset (502 on ENOTFOUND/ECONNREFUSED/ETIMEDOUT) |

### Overworld (3 endpoints)
| Method | Path | Behavior |
|---|---|---|
| GET | `/api/campaigns/:id/overworld` | Get overworld data (404 if missing) |
| PUT | `/api/campaigns/:id/overworld` | Save overworld data |
| POST | `/api/campaigns/:id/overworld/generate` | LLM-generate (120s timeout, 4 world_type allowlist, 8-anchor cap) |

### Transfer (2 endpoints)
| Method | Path | Behavior |
|---|---|---|
| GET | `/api/campaigns/:id/export` | Export portable bundle (version 1, includes scenes parsed from archive.md) |
| POST | `/api/campaigns/import` | Import bundle (ID collision check, background re-embed via setImmediate) |

### Divergence (2 endpoints)
| Method | Path | Behavior |
|---|---|---|
| GET | `/api/campaigns/:id/divergence` | Get divergence register (v2 migration) |
| PUT | `/api/campaigns/:id/divergence` | Save divergence register |

### Rules RAG (3 endpoints)
| Method | Path | Behavior |
|---|---|---|
| POST | `/api/campaigns/:id/rules/embed` | Upsert rule chunk embedding |
| POST | `/api/campaigns/:id/rules/search` | Vector search rule chunks (no MMR — rules not diversified) |
| POST | `/api/campaigns/:id/rules/reindex` | Reindex stale rule embeddings |

### LLM Proxy (1 endpoint)
| Method | Path | Behavior |
|---|---|---|
| POST | `/api/llm/proxy` | Transparent streaming proxy (forwards `{target, method, headers, body}`) |

### Embedding Info (1 endpoint)
| Method | Path | Behavior |
|---|---|---|
| GET | `/api/embeddings/info` | Global `{modelId, dims, embeddingVersion}` |

### TTS (4 endpoints)
| Method | Path | Behavior |
|---|---|---|
| GET | `/api/tts/status` | `{modelReady, initializing, voice, modelId, dtype}` |
| POST | `/api/tts/init` | Init TTS model (lazy load) |
| GET | `/api/tts/voices` | List voices |
| POST | `/api/tts/synthesize` | Synthesize WAV (returns audio blob) |

---

## Frontend → Backend Contract

`src/services/llm/apiClient.ts` calls → `src/lib/apiBase.ts` (`API_BASE`) → Vite proxy (`/api` → `localhost:3001`) in dev, or absolute `http://localhost:3001/api` in Electron.

| apiClient namespace | HTTP calls | Server route file |
|--------------------|------------|-------------------|
| `api.archive.*` | POST/GET/DELETE/PATCH `/campaigns/:id/archive/...` | archive.js |
| `api.chapters.*` | GET/POST/PATCH `/campaigns/:id/archive/chapters/...` | chapters.js |
| `api.facts.*` | GET `/campaigns/:id/facts` | facts.js |
| `api.timeline.*` | GET/POST/DELETE `/campaigns/:id/timeline/...` | timeline.js |
| `api.entities.*` | GET/POST `/campaigns/:id/entities/...` | facts.js |
| `api.settings.*` | GET/PUT `/settings` | settings.js |
| `api.backups.*` | POST/GET/DELETE `/campaigns/:id/backup(s)/...` | backups.js |
| `api.vault.*` | GET/POST/PUT/DELETE `/vault/...` | vault.js |
| `api.rules.*` | POST `/campaigns/:id/rules/embed|search|reindex` | rules.js |

`src/store/campaignStore.ts` calls → same `API_BASE` for campaign CRUD, lore, NPCs, state save/load, locations, archive index, semantic facts, entities, chapters, backups, timeline, divergence.

`src/services/llm/llmFetch.ts` calls → `POST /api/llm/proxy` to forward provider calls (CORS dodge for NVIDIA etc.).

---

## State Management (Zustand)

```
useAppStore = settingsSlice + campaignSlice + chatSlice + uiSlice + mapSlice + worldLoreSlice
```

| Slice | Key State | Actions | Persistence |
|---|---|---|---|
| **settingsSlice** | `settings` (44 fields), `vaultStatus`, `vaultLoading` | loadSettings, updateSettings, addPreset, updatePreset, removePreset, setActivePreset, 6 endpoint selectors (getActiveXEndpoint), addProvider, updateProvider, removeProvider, checkVaultStatus, setupVault, unlockVault, unlockVaultWithRemembered, lockVault, saveVaultKeys, exportVault, importVault | IndexedDB (`nn_settings`, providers encrypted) + server `PUT /settings` (500ms debounce) |
| **campaignSlice** | `activeCampaignId`, `loreChunks`, `archiveIndex`, `chapters`, `npcLedger`, `onStageNpcIds`, `npcSuggestions`, `locationLedger`, `locationSuggestions`, `semanticFacts`, `timeline`, `entities`, `pinnedChapterIds`, `context` (~70 fields), `inventoryItems`, `characterProfileData`, `bookkeepingTurnCounter`, `autoBookkeepingInterval` | 35+ actions (setActiveCampaign, lore CRUD, NPC CRUD + archive/restore + mergeOrRename, location CRUD, timeline CRUD, pinChapter, context update, inventory CRUD, character profile, bookkeeping counter) | Server-only (4 debounced saves, 1s debounce) |
| **chatSlice** | `messages`, `isStreaming`, `condenser`, `divergenceRegister`, `pinnedExcerpts`, `renameModalOpen/Text` | 30+ actions (message CRUD, condenser, divergence register ~20 actions, pinned excerpts with token cap, rename modal + tiered rename) | Via shared `debouncedSaveCampaignState` |
| **uiSlice** | 27 ephemeral toggles (modals, armed roll/loot/oneshot, composerInjection, pipelinePhase, streamingStats, loreCheck*, troubleModal*) | 25+ toggle/set actions | Ephemeral (no persistence) |
| **mapSlice** | `overworldMap`, `isMapOpen/Loading`, `playerPosition`, `isPinMode`, `pendingPin` | toggleMap, setOverworldMap, generateMap, loadMap, setPlayerPosition, togglePinMode, setPendingPin, saveMap, addPin, deletePin | Server `/api/campaigns/:id/overworld` (hardcoded `/api` prefix) |
| **worldLoreSlice** | `worldLoreDrafts`, `worldLoreActiveDraftId`, `worldLoreModalOpen` | createDraft, deleteDraft, updateDraftField, addItem, updateItem, removeItem, setActiveDraft, toggleWorldLoreModal, loadWorldLoreDrafts | localStorage (`nn_world_lore_drafts`, the ONLY slice using localStorage) |

**Cross-slice dependencies**:
- `settingsSlice` reads `activeCampaignId` (Campaign) for save context.
- `campaignSlice` reads `settings` (Settings), `messages`/`condenser`/`pinnedExcerpts` (Chat) via `CampaignDeps`; exports `debouncedSaveCampaignState` consumed by Chat; dynamically imports `commitPendingTurn` from `services/turn/pendingCommit`.
- `chatSlice` reads `activeCampaignId`/`context`/`archiveIndex` (Campaign) via `ChatDeps`; imports `debouncedSaveCampaignState` from Campaign; `clearArchive` writes Campaign's `archiveIndex`.
- `uiSlice`, `mapSlice`, `worldLoreSlice` → no cross-slice reads (self-contained).

---

## Data Flow: Single User Turn

```
1. User types message → ChatArea.tsx
2. commitPendingTurn() (finalise PREVIOUS turn):
   a. Read chosen variant via swipeActiveIndex
   b. classifySceneStakes if GM omitted tag (tier-gated)
   c. Build commitState with frozen snapshot.messages (NEVER live)
   d. runPostTurnPipeline(commitState, callbacks, text, snapshotMessages):
      - 3 parallel tracks via Promise.allSettled:
        i. Archive track: rateImportance (tier-gated) → api.archive.append → stamp sceneId (WO-F) → refresh index/timeline/chapters → Event-Extraction (background) → Chapter-AutoSeal if sceneCount >= 25
        ii. NPC track: extractNPCNames (7-pass) → validateNPCCandidates (tier-gated, fail-closed) → NPC-Update + NPC-Drives-Backfill (background, tier-gated + cooldown)
        iii. Pressure track: scanPressure → buildPressurePatch → auto-archive stale / auto-restore mentioned
      - On-stage NPC tracking (parsePresentHeader)
      - Location header tracking (resolveLocationHeader)
      - Agency tick: bumpOnStageActivity (unconditional) + runAgencyTick (tier-gated heartbeatTick)
      - Inner repression booking (once-per-turn, pure dice)
      - Arc engine tick (tier-gated arcTick)
   e. Auto-condense check (shouldCondense → computeTrimIndex → setCondensed)
   f. Clear swipeSet/pendingCommit/swipeActiveIndex
   g. clearPendingTurnSnapshot()

3. runTurn(state, callbacks, abortController):
   a. Phase 'rolling-dice': rollEngines(context) → pre-rolled dice pool
   b. If armedRoll: resolveManualRoll + inject as hard FACT
   c. If armedLoot: resolveLootDrop + wrap as fact-assertion
   d. If armedOneShot: buildOneShotDirective
   e. Add user message synchronously (bubble appears before heavy async)
   f. Phase 'gathering-context': gatherContext() — 5 parallel stages with Promise.race safety backstop
      - plannerPromise (LLM, tier-gated)
      - semanticPromise (server vector search)
      - timelinePromise (next-scene pre-assign)
      - recommenderPromise (LLM, tier-gated)
      - loreRulesPromise (IDF+RRF)
   g. NPC Intro Engine (tier-gated introEngine) — LLM call to auxiliary provider
   h. Phase 'building-prompt': buildPayload() — 5-block assembly with Anthropic cache_control
   i. Phase 'generating': sendMessage (streaming via per-endpoint queue, /llm/proxy for CORS)
      - Tool calls via TOOL_REGISTRY (max 5 per turn)
      - 3-tier retry on error (retry → retry without tools → give up)
   j. On done: extractAndStripSceneStakes → build SwipeVariant → stamp swipeSet + pendingCommit
   k. capturePendingTurnSnapshot() — freeze messages + cached payload for lazy swipes 2-5
   l. Phase 'idle'

4. Player browses swipes (2-5) generated lazily from cached payload (swipeGeneration.ts)
5. Player clicks send again OR switches campaign → loop back to step 2
```

---

## Server-Side Archive Pipeline (per scene append)

```
POST /api/campaigns/:id/archive
  → archiveService.appendScene():
    1. Synchronous: getNextSceneNumber + build markdown block + appendFileSync (serializes concurrent appends)
    2. Run 6 NLP heuristics inline:
       - extractIndexKeywords (proper nouns + quoted strings + [MEMORABLE:"..."] tags, cap 20)
       - extractNPCNames (6-pass, excludeNames list)
       - extractWitnessesHeuristic (bracketed dialogue OR user "talk to/ask/tell X")
       - extractKeywordStrengths (frequency + position + proximity bonus)
       - extractNPCStrengths (death=1.0, 3+ mentions OR dialogue=0.7, 2=0.5, 1=0.3)
       - estimateImportance (1-10, +3 death, +2 MEMORABLE, +1 royalty/treasure/quest)
    3. withCampaignLock #1 — index write
    4. Fire-and-forget embedding (embedText → storeArchiveEmbedding, NOT awaited)
    5. Pre-compute entity name union for deferred timeline extraction
    6. withCampaignLock #2 — entity registry update + chapter auto-lifecycle
    7. Emit 'archive:written' event for deferred NLP pipeline
  → res.json({sceneId, ...})

  → nlpPipeline listener (setImmediate after res.json):
    1. If utilityConfig.endpoint AND npcNames.length > 0:
       a. extractWitnessesLLM (5000ms timeout, 1 attempt) → patchWitnesses
       b. extractTimelineEventsLLM (6000ms timeout, 2 attempts) OR regex fallback
          → normalizeEntityName → append to timeline store with auto-incremented tl_NNNN IDs
    2. Each write under withCampaignLock
    3. Errors logged and swallowed (deferred failures must not crash)
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19.2 + TypeScript 5.9 (strict) + Vite 8 + Tailwind 4 |
| State | Zustand 5 (6 slices) |
| Styling | Tailwind CSS 4 |
| 2D Rendering | PixiJS 8 + pixi-filters (overworld map) |
| Markdown | react-markdown 10 + remark-gfm 4 |
| Icons | lucide-react |
| Backend | Express 5 (ESM), Node ≥ 20.19 |
| Database | JSON files per campaign in `data/campaigns/<id>/` |
| Vector search | better-sqlite3 12 + sqlite-vec 0.1.9 (3 vec0 tables, cosine distance) |
| Embedding | @huggingface/transformers 4 (mxbai-embed-large-v1 q8, 1024 dims, LRU 512) |
| TTS | kokoro-js 1.2.1 (Kokoro-82M q8, af_heart default voice, SHA-256 WAV cache) |
| Token counting | js-tiktoken 1 |
| LLM streaming | Direct fetch to Ollama / OpenAI / Claude / Gemini via per-endpoint priority queue |
| LLM proxy | Server-side `/llm/proxy` route forwards provider calls to dodge browser CORS |
| Encryption | Node `crypto` AES-256-GCM + PBKDF2-SHA256 (600k iter password / 10k machine key) |
| Settings storage | idb-keyval 6 (IndexedDB, providers encrypted at rest) |
| Desktop | Electron (nodeIntegration:false, contextIsolation:true) |
| Testing | Vitest 4 + React Testing Library 16 + Supertest 7 (84 test files, ~1,055 tests) |
| Build | esbuild 0.28 (server bundle for Electron) + Vite 8 (frontend) |
| Linting | ESLint 9 flat config + typescript-eslint 8 + react-hooks + react-refresh |
| Shared core | @narrative/engine (file-linked `packages/engine`, platform-pure, boundary-gate enforced) |

---

## Engine Package (`packages/engine/`)

The `@narrative/engine` package is a **file-linked local dependency** (`"file:packages/engine"` in `package.json`). It is consumed by both `mainApp` (desktop) and `mobileApp` (mobile) for platform-pure shared logic.

**Purity enforcement**: `packages/engine/scripts/boundary-gate.mjs` runs as the `pretest` hook. It rejects imports of:
- `react`, `react-dom`
- `zustand`
- `@capacitor*`
- `idb-keyval`
- `better-sqlite3`
- `express`
- `node:*`

**tsconfig**: `lib: ["ES2022"]` only — NO DOM/Node libs. This enforces platform purity at the compiler level.

**Modules**:
- `src/json/jsonExtract.ts` — `extractJson`, `extractJsonRobust` (balanced-brace scan)
- `src/loot/lootEngine.ts` — Loot tree walker
- `src/retrieval/lexicalFusion.ts` — `fuseRRF` (k=60, Cormack et al. 2009), `computeIdf` (BM25 smoothing)
- `src/rolls/engineRolls.ts` — 3-gate dice engine

**Type strategy**: Types are structural twins. The app keeps its own `src/types/` as source of truth; the engine declares only the fields it reads in `packages/engine/src/*/types.ts`. This avoids a circular dep where the engine imports app types.

---

## Key Files for Quick Reference

| Need to understand... | Read this file |
|---|---|
| "How does a turn work?" | `src/services/turn/turnOrchestrator.ts` |
| "How is a swipe committed?" | `src/services/turn/pendingCommit.ts` |
| "How is context built?" | `src/services/turn/contextGatherer.ts` + `src/services/payload/payloadBuilder.ts` |
| "How is the payload structured?" | `src/services/payload/{payloadBuilder,stable,volatile,world,history,budgets}.ts` |
| "How are scenes archived?" | `server/routes/archive.js` + `server/services/archiveService.js` |
| "How does vector search work?" | `server/lib/vectorStore.js` + `server/lib/embedder.js` |
| "How does RRF fusion work?" | `src/services/archive-memory/recall.ts` + `packages/engine/src/retrieval/lexicalFusion.ts` |
| "How does NPC agency tick?" | `src/services/npc/agency/agencyEngine.ts` |
| "How do reaction menus work?" | `src/services/npc/reactionMenu.ts` + `reactionRepression.ts` |
| "How does the hex roll work?" | `src/services/npc/hexRoll.ts` |
| "How are scenes summarized?" | `src/services/saveFileEngine.ts` (`sealChapterCombined`) |
| "How do chapters auto-seal?" | `src/services/archive-memory/archiveChapterEngine.ts` |
| "How does deep search work?" | `src/services/archive-memory/deepArchiveSearch.ts` |
| "How does TTS work?" | `server/lib/tts.js` + `src/components/tts/TtsPlaybackPanel.tsx` |
| "How does the vault work?" | `server/vault.js` |
| "What are the system rules?" | `src/services/rules/defaultRules.ts` |
| "What data does the store hold?" | `src/store/slices/` (7 slice files) |
| "How are NPCs detected?" | `src/services/npc/npcDetector.ts` |
| "How does the priority queue work?" | `src/services/llm/llmRequestQueue.ts` |
| "How is the world map generated?" | `src/services/mapEngine/worldOrchestrator.ts` + `src/components/map/OverworldCanvas.tsx` |
| "How is the divergence register rendered?" | `src/services/campaign-state/divergenceRegister.ts` |
| "How is the PC created?" | `src/components/pc/PCCreationWizard.tsx` |
| "How is settings state encrypted?" | `src/services/infrastructure/settingsCrypto.ts` |
| "What are the engine packages?" | `packages/engine/src/{json,loot,retrieval,rolls}/` |