# Combat Mode — Master Spec & Implementation Plan

## Context

**The problem that started this:** the story AI, left to narrate freely, resolves combat too fast — "you cut down all three hooligans" in one line. No tension, no attrition, no stakes. We want **meaty, engine-governed combat** where the *engine* (not the AI) owns HP/FOC, pacing, and termination, while the AI does what it's good at: narrating outcomes the engine has already computed, and translating freeform creativity into bounded mechanics.

**Core principle (the thesis):** *Every number comes from the engine; the AI only ever supplies a bounded label.* The AI adjudicates fiction → enums; the engine owns all magnitudes. A fight cannot end until HP conditions are met — the HP pool is the pacing governor.

**Formula stance:** Adopt **D&D 5e RAW** for the math (proven tuning, gives a unit-test oracle), content stripped, with one swap — **FOC replaces Vancian spell slots** (DMG "Spell Points" variant), because slot tracking is a nightmare. Not fully genre-agnostic by choice; genre is a flavor/label layer on top.

This is a large multi-phase feature. This doc is both the **consolidated design spec** (decisions locked through extended design discussion) and the **phased build roadmap** grounded in the actual codebase.

---

## Part 0 — Execution Model (multi-agent)

Built by **multiple model-tier agents sharing the same repo + this plan as the common brief**. The cheap models share the same code view, so the plan file is their handoff brief — no conversation context needed.

- **Opus (Claude Code):** architecture/spec owner; writes test oracles + hard design (Phase 0 formula constants, Phase 3 prompts & bounded-enum contracts); reviews critical merges.
- **GLM 5.1 (Sonnet-tier) + Sonnet** via **Opencode**: medium-judgment integration glue (Phase 0 impl, Phase 2 loop, Phase 3 wiring, ChatArea swap). Two interchangeable workhorses — parallelize medium phases across them.
- **Gemini Flash 3.5** (cheap/fast) via **Gemini Antigravity** (same code view): boilerplate only — Phase 1 slices, Phase 4 UI, test scaffolding. Pin with tests first.

**Tier-by-phase:** P0 = Opus oracle + GLM/Sonnet impl · P1 = Flash · P2 = GLM/Sonnet · P3 = Opus design + GLM/Sonnet wiring · P4 = Flash (+GLM/Sonnet for ChatArea swap).

**Coordination rules:**
1. Higher-tier model writes each phase's **test contract first**; Flash implements against pinned tests (TDD is what makes cheap-model delegation safe).
2. Flash must **not** author Phase 3 scanner/adjudicator prompts or the bounded-enum contracts (Opus designs those; GLM/Sonnet wire them).
3. Respect each brief's `Depends on`. Briefs in Part C are self-contained for cold pickup.

---

## Part A — Locked Design Spec

### A1. The 6-stat model
Six abstract stats (genre-agnostic engine; flavor via per-campaign label map, e.g. FOC→"mana"/"chakra"/"energy cells"):

| Stat | D&D role adopted | Offense | Defense |
|---|---|---|---|
| **VIT** | CON | — | HP pool, CON saves |
| **PWR** | STR | melee attack + damage | — |
| **SPD** | DEX | finesse/ranged attack, **initiative**, MOV | (evasion folded into AC via RES, not SPD) |
| **RES** | natural armor | — | **AC = 10 + RES-mod + worn armor** |
| **WIL** | INT+WIS+CHA merged | magic/social/summon potency | mental "saves" (WIL↔WIL opposed) |
| **FOC** | spell-points | fuels skills/specials | — |

- Physical attack: `d20 + PWR (or SPD if finesse) + prof` vs `AC (10 + RES + armor)`.
- Mental/magic/social: attacker DC `8 + WIL + prof` vs defender `d20 + WIL`.
- Stats are D&D ability scores (8–20 → modifiers). Keep the score→mod layer for v1 (that's where D&D tuning lives).

### A2. NPC power model — Tier × Archetype
- **combatTier** sets the total stat/HP budget (≈ D&D level/CR; drives proficiency bonus, HP, stat bumps). Maps to a level band.
- **archetype** distributes that budget (Bulwark→VIT/RES, Assassin→SPD/PWR, Caster→WIL/FOC, etc.) AND defines enemy behavior tables.
- AI assigns *combatTier + archetype* (qualitative judgment it's good at); engine expands to numbers from budget tables.
- ⚠️ **Naming collision:** `NPCEntry.tier` already exists (`'recurring'|'oneshot'|'walkon'`, narrative importance). Use **`combatTier`** for power level — do NOT reuse `tier`.

### A3. Compendiums (definitions) + ledger references (instances)
- **Item Compendium** + **Skill Compendium** = global *definitions*, stored once. Ledger references by ID.
- Item: `{ damageDice, scalingStat, bonus, properties[], range, rarity }`. Excalibur vs iron sword = pure data (bigger dice + bonus + properties). `rarity` → dice budget (anti-inflation, mirrors combatTier).
- Skill: `{ focCost, type, damageDice|healDice, scaling, properties[], range }`. One schema for spell/jutsu/tech. Cantrips = `focCost: 0` (free basics → attrition pressure).
- Elements = bounded tag set with mechanical riders + flavor labels (fire→burn DoT, lightning→pierce/paralyze).

### A4. FOC resource model
- One pool, max scales with WIL + combatTier. No slot levels.
- Costs from DMG spell-point table (1st=2, 2nd=3, 3rd=5…) as baseline.
- **Regen (locked):** none in-combat; full restore on rest; **DEF/brace recovers a little FOC** (gives DEF a second purpose). Attrition = meatiness.

### A5. Combatant lifecycle — materialize → resolve → discard
Three combatant kinds:

| Kind | Ledger? | Stats from | At combat end |
|---|---|---|---|
| **PC / named NPC** | yes | copy ledger stats → combatState instance | write back coarse `condition` |
| **Ephemeral mook** ("3 hooligans") | no | **materialized just-in-time** (combatTier+archetype hint → budget + ±10% jitter) | **discarded entirely** |
| **Summon** | no | derived from summoner's WIL | discarded |

- **`combatState` = ephemeral live instance** (round, turnOrder, combatants[live HP/FOC/status/position], range relations). Wiped at combat end.
- **Ledger = persistent template.** Only thing crossing the boundary: a coarse `condition`.
- **Cross-combat HP (locked):** no numeric carryover. Ledger stores `lastCondition` + `lastSeenTimestamp` + optional `recoveryNote`. On reappearance the **AI adjudicates a recovery band** (healthy/wounded/critical) from time+context; engine sets starting maxHP % (100/50/25). No recovery *system* — AI narrative judgment replaces it, lazy-evaluated at re-encounter. **Death is absolute** and feeds the existing witness/archive system.

### A6. Range & position (no grid, no facing)
- **Range gates action legality** (not just modifies). Weapon/skill carries `range: Close|Reach|Ranged`. Engine pre-check rejects illegal actions (katana at Ranged → rejected; HUD greys it out).
- Range is **binary per-target**: Engaged (Close) / Apart (Ranged). MOV closes/opens the gap. Start binary; Reach/mid later.
- **Position tags** (chosen via MOV): `cover / elevated / exposed` — modify hit/defense.
- **`suppressed` is a STATUS, not a position** (has source+duration; lives in the condition/status system).
- **Cover rule:** cover defends vs Ranged; **melee ignores cover** → emergent killzone tactics (the cyberpunk minigun-vs-katana scene falls out of 2 rules).
- MOV = change range and/or position; mechanically essential (it's how gated actions get enabled).

### A7. Enemy AI — deterministic, zero LLM (3-tier cascade)
Checked in priority order:
1. **NPC personal override** (ledger-authored `{trigger, action}` from bounded vocab, e.g. Michiko `onAllyFatal(Chie)→interpose`).
2. **Archetype conditional** (e.g. Bulwark: protect ally <30% VIT).
3. **Archetype weighted roll** (e.g. 55% guard / 25% defend-attack / 20% reposition).

- Plus a **target-selection** table per archetype. Keep a little randomness (anti-exploit).
- **LLM calls per round = 2, flat** (adjudicate player + narrate), regardless of enemy count — enemies are pure functions.
- Overrides need a **provisional-resolve → peek → re-resolve** interrupt step (same primitive as REACT and dodge/parry). *Deferred past v1* (see A11).

### A8. The two AI jobs (distinct!)
| Job | Answers | Trigger | Model |
|---|---|---|---|
| **Scanner** (combatAssistant) | "is this combat? what intent?" | open player text | cheap/aux provider |
| **Adjudicator** | "turn this maneuver into bounded params" | freeform inside a known action (SETUP / "describe…") | aux or story AI |

- Scanner output: `{ intent, confidence, entitiesReferenced[] }`. Routes per the routing table; **fails safe → default `narrative`** (false positives worse than false negatives). Story-AI `initiate_combat` tool = backstop if no combatAssistant configured (tooltip: "MUCH more accurate with combatAssistant").
- Adjudicator output = **bounded enums only** (`stat, advantage, calledShot, positionTag, momentumToken(capped), riskOnFail`). Never damage numbers.

### A9. Combat HUD (hybrid input)
On combat start, swap chat input → combat HUD; flip back on end.
- **Buttons** (engine-direct, 0 input AI calls): `ATK ▾` (weapon basics + knownSkills from ledger), `MOV`, `DEF`, `TARGET` selector (from combatState roster + condition), live `HP/FOC` bars. Illegal actions greyed by range.
- **Freeform box** ("…or describe your action") → adjudicator. This is the creativity escape hatch. Also catches social/info/flee-by-description.
- **MOV:SETUP** = freeform maneuver → adjudicator → grants position/advantage/capped momentum token to next ATK (never direct damage). Can fail (SPD check → prone/exposed). Token is transient (consumed by next ATK).

### A10. Combat ledger display (engine-authored)
- Engine emits a ledger line per round into fitted history, e.g. `⚔️ Round 3 · Sasuke 24/30 · Hooligan#2 12/30 [Guarding]`. AI **sees** it (narration continuity) but never authors numbers. This is the meatiness made visible.
- Reuses existing precedent: `ChatMessage.name` marker + `fitHistory` skip. Live HP/FOC in **volatile** payload block only.

### A11. Deferred past v1 (designed, not built yet)
- **REACT / interrupt subsystem** (readied actions, dodge/parry, override interpose) — the provisional-resolve→peek→re-resolve primitive. *v1.1.*
- **Breakthrough** (mid-combat improvised technique; overreach combatTier with WIL-check backfire + recoil; creates nascent skill).
- **Downtime Forge** (player-authored skills/items, budget-capped, mastery ramp).
- **5-slot queued actions** (SPD-driven slot count, staleness/round-robin rules). *Engine should be built queue-shaped from day 1 (resolve an ordered action list), expose single-slot first.*
- Mook→named promotion at combat end.

---

## Part B — Codebase Integration Map

### Patterns to reuse (confirmed by exploration)
- **Store:** manual slice-creator (`createXSlice: StateCreator<...>`), per-slice `debouncedSaveX()` (500ms) → `campaignStore.ts` CRUD with key `x_${campaignId}`, auto-loaded in `setActiveCampaign()`. Wire into `src/store/useAppStore.ts`.
- **Engine:** pure functions in `src/services/engine/`, barrel-exported from `engine/index.ts` (cf. `engineRolls.ts`, `diceTier.ts`, `mapTier`). New `combatEngine.ts` follows this — fully unit-testable.
- **Tools:** `getToolDefinitions()` + `handleXTool(args, ctx)` returning JSON string; dispatched in `turnOrchestrator.executeTurn()` recursive loop beside `roll_dice`/`update_scene_notebook`.
- **Aux/cheap LLM:** `charIntroEngine.ts` already uses a `utilityProvider` for `resolveLocation()` — the **scanner reuses this aux-provider pattern**. `llmService.sendMessage(provider, msgs, …, tools)` is model-agnostic.
- **Engine-authored chat:** `ChatMessage.name` (e.g. `'scene-marker'`) + `fitHistory()` skip-list. Combat ledger = `name: 'combat-ledger'`.
- **Tests:** vitest pure-unit (`src/services/__tests__/diceTool.test.ts`, `engineRolls.test.ts`) — property + config-variation + edge cases.

### Files to create
- `src/services/engine/combatEngine.ts` — resolveAction/resolveAttack, rollInitiative, materializeCombatant, archetype tables, recovery band, AC/HP/FOC math (D&D RAW).
- `src/services/turn/combatScanner.ts` — cheap classifier call (aux provider), routing.
- `src/store/slices/combatSlice.ts` — ephemeral `combatState`.
- `src/store/slices/itemSlice.ts`, `src/store/slices/skillSlice.ts` — compendium definitions.
- `src/components/combat/CombatHUD.tsx` — buttons + target + HP/FOC + freeform box.
- `src/services/__tests__/combatEngine.test.ts`, `combatScanner.test.ts` (labeled intent corpus).

### Files to modify
- `src/types/index.ts` — add `CombatState`, `Combatant`, `CombatAction`, `ItemDef`, `SkillDef`; extend `NPCEntry` (`isPC`, `combatTier`, `archetype`, 6 base stats, `equippedWeapon`, `knownSkills[]`, `inventory[]`, `condition`, `lastCondition`/`lastSeenTimestamp`/`recoveryNote`, `overrides[]`); extend `GameContext` (`combatModeActive`, `combatConfig`, stat label-map).
- `src/store/slices/settingsSlice.ts` + `settingsMigration.ts` — `combatAssistantAI` provider/preset; DEFAULT_COMBAT_* constants; migration backfill for existing NPCs (stat defaults).
- `src/store/useAppStore.ts` + `src/store/campaignStore.ts` — wire 3 new slices + CRUD keys `combat_/items_/skills_${id}`.
- `src/services/turn/toolHandlers.ts` — `initiate_combat` + `adjudicate_action` defs + handlers.
- `src/services/turn/turnOrchestrator.ts` — combat-mode branch: scanner step 0; engine-resolve-before-narrate ordering; ledger-line injection.
- `src/services/npc/npcDetector.ts` (+ generation) — teach AI to assign `combatTier` + `archetype` for combat-relevant NPCs.
- `src/services/payload/payloadHistoryFitting.ts` — skip `name === 'combat-ledger'`; keep live state volatile.
- `src/components/ChatArea.tsx` — conditional `<CombatHUD/>` vs `<ChatInput/>`.
- `src/components/chat/MessageBubble.tsx` — render `name === 'combat-ledger'` styling.
- `src/components/context-drawer/EnginesTab.tsx` — Combat Mode toggle + combatAssistant picker + config.
- `src/components/npc-ledger/NPCEditForm.tsx` — combat-stats section + PC creation (`isPC`) guided form.

---

## Part C — Per-Phase Build Briefs (delegatable)

Each brief is self-contained for cold pickup by an agent sharing the repo. Sequential by `Depends on`.

### Phase 0 — Engine spike (pure functions, ZERO ai/ui)
- **Model:** Opus writes the test oracle + RES→AC / combatTier / FOC / HP constants; **GLM 5.1 / Sonnet** implement functions against the oracle.
- **Depends on:** nothing.
- **Spec:** A1, A2, A4, A5 (materialize), A6 (range math), A7 (archetype tables).
- **Author constants:** RES→AC (`10 + RES-mod + armor`), combatTier→level band, FOC pool sizes + DMG spell-point costs, HP scaling (`base + VIT×k + tier`).
- **Test contract (write FIRST) — `combatEngine.test.ts`:** D&D expected values (e.g. +4 vs AC13 ≈ 60% hit), damage ranges, advantage/disadvantage distribution, initiative by SPD, materialize jitter ±10% of budget, recovery band → maxHP% (100/50/25).
- **Create:** `src/services/engine/combatEngine.ts` (resolveAttack, to-hit vs AC / WIL-save, damage, adv/disadv, initiative, materializeCombatant, archetype budget+behavior tables, recovery band) + export in `engine/index.ts`. **Build queue-shaped** (resolve an ordered action list) though v1 exposes single actions.
- **Done when:** vitest green vs oracle; zero imports of store/UI/LLM.

### Phase 1 — State + lifecycle (no AI)
- **Model:** **Gemini Flash 3.5** (cheap pattern-replication).
- **Depends on:** Phase 0 (types + materialize).
- **Spec:** A1–A5.
- **Test contract:** slice persist/hydrate round-trip; init copies ledger stats + materializes mooks + rolls initiative; terminate writes back `condition`/death + discards ephemerals; state survives reload.
- **Create:** `combatSlice.ts`, `itemSlice.ts`, `skillSlice.ts` (+ `campaignStore` keys `combat_/items_/skills_${id}`, wire into `useAppStore.ts`).
- **Modify:** `types/index.ts` (CombatState/Combatant/ItemDef/SkillDef + NPCEntry combat fields incl. **`combatTier` NOT `tier`**, `isPC`, 6 base stats, `equippedWeapon`, `knownSkills[]`, `inventory[]`, `condition`, `lastCondition`/`lastSeenTimestamp`/`recoveryNote`, `overrides[]`; GameContext `combatModeActive`/`combatConfig`/label-map), `settingsSlice.ts` + `settingsMigration.ts` (combat defaults + NPC stat backfill).
- **Done when:** slices persist/hydrate, init/terminate tested, lint green.

### Phase 2 — Turn loop + verbs (no AI; hardcoded actions)
- **Model:** **GLM 5.1 / Sonnet** (unforgiving integration glue).
- **Depends on:** Phase 0+1.
- **Spec:** A6, A7, A9 (verbs MOV/ATK/DEF only), A10 (ledger line), A4 (DEF→FOC).
- **Test contract:** drive a full combat with hardcoded action lists; assert termination only on HP conditions, range-rejection (katana@Ranged), cover defends-vs-Ranged + melee-ignores, DEF→FOC recovery, ledger line emitted with `name:'combat-ledger'`.
- **Modify:** `turnOrchestrator.ts` (combat branch, SPD order, engine-resolve-before-narrate), `payloadHistoryFitting.ts` (skip `combat-ledger`, keep live state volatile).
- **Done when:** scripted combats resolve correctly end-to-end in tests.

### Phase 3 — AI seam (scanner + adjudicator) ← v1's real test
- **Model:** **Opus designs prompts + bounded-enum contracts**; **GLM 5.1 / Sonnet** wire. Flash MUST NOT author prompts/enums.
- **Depends on:** Phase 0–2.
- **Spec:** A8 (both AI jobs), A9 (SETUP). Overrides/REACT excluded (deferred).
- **Test contract:** `combatScanner.test.ts` labeled-intent corpus → precision/recall on `combat_start`, fail-safe default `narrative`; adjudicator maps sample maneuvers (chandelier) → expected bounded enums (`stat/advantage/positionTag/momentumToken/riskOnFail`), never damage; assert engine-resolves-before-narration + 2-calls-per-round.
- **Create:** `combatScanner.ts` (reuse `charIntroEngine` aux-provider pattern), `combatScanner.test.ts`.
- **Modify:** `toolHandlers.ts` (`initiate_combat` backstop + `adjudicate_action` defs/handlers), `turnOrchestrator.ts` (scanner step 0; `tool_choice` where apt), `npcDetector.ts`/generation (assign `combatTier`+`archetype`).
- **Done when:** scanner hits target precision/recall; adjudicator round-trips bounded enums; ordering verified.

### Phase 4 — UI
- **Model:** **Gemini Flash 3.5** for HUD/forms/rendering; **GLM 5.1 / Sonnet** for the ChatArea conditional swap.
- **Depends on:** Phase 1–3.
- **Spec:** A9 (HUD), A10 (ledger render).
- **Verify (preview tools):** HUD swaps in, button → engine-direct resolution, HP/FOC bars update, range-greying, freeform SETUP round-trips, ledger renders; screenshot proof.
- **Create:** `src/components/combat/CombatHUD.tsx`.
- **Modify:** `ChatArea.tsx` (conditional HUD vs ChatInput), `MessageBubble.tsx` (`combat-ledger` styling), `EnginesTab.tsx` (toggle + combatAssistant picker), `NPCEditForm.tsx` (combat stats + `isPC` PC-creation form).
- **Done when:** end-to-end combat playable in preview; lint/test/build green.

### Deferred (post-v1)
REACT/interrupt subsystem → Breakthrough → Downtime Forge → 5-slot queue → mook promotion. (See A11.) Engine already queue-shaped from Phase 0.

---

## Part D — v1 Scope (locked with user)

**IN:** Phases 0–4 with verbs **MOV / ATK / DEF + MOV:SETUP**; **scanner IN v1** (front-load AI-risk validation); AC = `10 + RES + armor`; FOC = no in-combat regen, DEF recovers; full D&D 5e math minus content, FOC for slots.

**OUT (v1.1+):** REACT/interrupts, Breakthrough, Forge, 5-slot queue. (Engine still built queue-shaped.)

---

## Part E — Verification

- **Phase 0:** `npx vitest src/services/__tests__/combatEngine.test.ts` — assert against D&D published expected values (e.g. "+4 vs AC13 ≈ 60% hit"), damage ranges, advantage math, materialize jitter bounds, recovery-band → maxHP%.
- **Phase 1–2:** vitest drive a full combat with hardcoded actions; assert HP/FOC/condition write-back, termination only on HP conditions, range-rejection of illegal actions, cover/melee interaction, DEF→FOC recovery.
- **Phase 3:** `combatScanner.test.ts` labeled fixtures → precision/recall on `combat_start`; adjudicator maps sample maneuvers (chandelier) to expected bounded enums; verify engine-before-narration ordering and 2-calls-per-round.
- **Phase 4 (preview tools):** start dev server, trigger combat, confirm HUD swap, button → engine-direct resolution, ledger line renders, HP bars update, range-greying, freeform SETUP round-trips. Screenshot proof.
- **Lint/build:** `npm run lint`, `npm run test`, `npm run build` green before APK.

## Part F — Open tuning knobs (not blockers)
combatTier→level band exact mapping; FOC pool/cost constants; archetype behavior-table weights & roster (ship with ~3); element rider set; HP scaling constant `k`; scanner model choice + context window size.
