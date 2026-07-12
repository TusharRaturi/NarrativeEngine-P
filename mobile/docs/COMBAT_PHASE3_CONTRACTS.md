# Combat Mode — Phase 3 Authored Contracts (Opus)

> **STATUS: authoritative. Wire these in VERBATIM.**
> The scanner prompt, the adjudicator tool description, the bounded-enum schema, and the
> npcDetector rubric below are authored by Opus per COMBAT_MODE_PLAN.md coordination rule #2.
> The wiring agent (GLM/Sonnet) MUST NOT alter the prompt wording, enum values, thresholds,
> or clamping rules. Wire them exactly as written; only the surrounding TypeScript plumbing
> (imports, dispatch, JSON parse/return) is yours to write.

---

## 1. Scanner — `src/services/turn/combatScanner.ts`

Cheap aux-model classifier. Reuses the `charIntroEngine.ts` aux-provider pattern:
`llmCall(provider, promptString, { temperature: 0.1, priority: 'high', maxTokens: 200 })`,
strip any `<think>…</think>` block, parse JSON, **fail safe to `narrative` on ANY error**.

### 1.1 Output contract (exact shape)
```ts
export type CombatIntent = 'combat_start' | 'combat_action' | 'narrative';

export type CombatScanResult = {
    intent: CombatIntent;        // default 'narrative'
    confidence: number;          // 0.0–1.0
    entitiesReferenced: string[];// names/labels of foes or targets named in the text
};
```

### 1.2 Routing (v1)
- `intent === 'combat_start'` **AND** `confidence >= 0.6` → trigger combat-entry path
  (story-AI `initiate_combat` backstop if no combatAssistant configured; otherwise the
  scanner result itself is the signal). `entitiesReferenced` seeds the enemy roster hint.
- `intent === 'combat_action'` → only meaningful when already in combat; if not in combat,
  **treat as `narrative`**.
- Everything else, low confidence, empty/garbled output, parse failure, or thrown error →
  **`narrative`** (false positives are worse than false negatives; never auto-start a fight
  on a weak signal).

### 1.3 Scanner prompt — VERBATIM
```
You are a combat-intent classifier for a text RPG. Read the player's latest input in the
context of recent scene history and decide whether it initiates or constitutes physical combat.

Classify into exactly one intent:
- "combat_start": the player is starting a fight or violence is breaking out — drawing a
  weapon on someone, throwing the first strike, ambushing, or clearly committing to attack.
- "combat_action": a combat maneuver when a fight is ALREADY underway (attack, defend, move,
  use a technique).
- "narrative": anything else — dialogue, exploration, social pressure, threats WITHOUT a
  committed attack, description, travel, shopping, investigation. This is the default.

Rules:
- Verbal threats, posturing, intimidation, or "I ready my sword" WITHOUT a committed strike
  are "narrative", not "combat_start". Only commit to "combat_start" when an attack is
  actually launched or violence is unambiguously beginning.
- When uncertain, choose "narrative" with low confidence.
- entitiesReferenced: list the names or short labels of any foes/targets the player names or
  clearly points at (e.g. ["the pirate", "Sasuke"]). Empty array if none.

Respond with ONLY a JSON object, no prose, no markdown:
{"intent":"combat_start|combat_action|narrative","confidence":0.0,"entitiesReferenced":[]}
```

---

## 2. Adjudicator — `adjudicate_action` tool in `src/services/turn/toolHandlers.ts`

Turns ONE freeform maneuver (the creativity escape hatch / MOV:SETUP free text) into
**bounded labels only**. The story-AI fills this tool; the engine owns every magnitude.
**The tool MUST NOT emit damage, HP, dice counts, or any number except the capped
`momentumToken`.**

### 2.1 Bounded-enum schema (exact — these are the ONLY legal values)
```ts
export type AdjudicatedAction = {
    stat: 'PWR' | 'SPD' | 'WIL' | 'VIT' | 'RES' | 'FOC';
    advantage: 'advantage' | 'normal' | 'disadvantage';
    positionTag: 'cover' | 'elevated' | 'exposed' | 'none';
    momentumToken: 0 | 1;            // capped at 1 in v1 — grants the NEXT ATK, never damage
    riskOnFail: 'none' | 'prone' | 'exposed' | 'drop_weapon' | 'self_stagger';
};
```

### 2.2 Handler clamping rules (the handler is the safety net — do NOT trust raw model output)
- Any value outside its enum → coerce to the safe default: `stat→'PWR'`, `advantage→'normal'`,
  `positionTag→'none'`, `riskOnFail→'none'`.
- `momentumToken`: coerce to integer, clamp to `[0, 1]`. Anything truthy-but-out-of-range → 1; negative/NaN → 0.
- Strip any field the model invents (e.g. `damage`, `hp`, `dice`) — never pass it through.
- Return the validated object as a JSON string (same pattern as `handleDiceTool`).

### 2.3 Tool definition — VERBATIM (name, description, parameter enums)
```ts
const ADJUDICATE_ACTION_TOOL = {
  type: 'function' as const,
  function: {
    name: 'adjudicate_action',
    description:
      "Translate a player's freeform combat maneuver into bounded mechanical labels. Use ONLY " +
      "when the player describes a creative action (e.g. a MOV:SETUP free-text stunt) that the " +
      "fixed combat buttons don't cover. You decide WHICH stat governs it, whether the fiction " +
      "earns advantage/disadvantage, what position it ends in, whether it grants a one-use " +
      "momentum token for the NEXT attack, and what goes wrong on failure. NEVER output damage, " +
      "HP, or dice — the engine owns all numbers. You only supply labels.",
    parameters: {
      type: 'object' as const,
      properties: {
        stat:        { type: 'string', enum: ['PWR','SPD','WIL','VIT','RES','FOC'], description: 'Which stat the maneuver is resolved against (PWR=force, SPD=agility/acrobatics, WIL=mental/magic, VIT=endurance, RES=bracing, FOC=technique fuel).' },
        advantage:   { type: 'string', enum: ['advantage','normal','disadvantage'], description: "advantage if the fiction is clever/favorable (high ground, clear opening); disadvantage if reckless/awkward; otherwise normal." },
        positionTag: { type: 'string', enum: ['cover','elevated','exposed','none'], description: 'Position the actor ends the maneuver in. elevated = high ground (benefits the actor); exposed = open/vulnerable; cover = shielded vs ranged; none = neutral.' },
        momentumToken: { type: 'integer', enum: [0,1], description: '1 if the setup clearly earns a one-use boon for the NEXT attack (consumed immediately); else 0. Never more than 1.' },
        riskOnFail:  { type: 'string', enum: ['none','prone','exposed','drop_weapon','self_stagger'], description: 'What befalls the actor if the maneuver fails its check.' },
      },
      required: ['stat','advantage','positionTag','momentumToken','riskOnFail'],
    },
  },
} as const;
```

### 2.4 `initiate_combat` backstop tool — VERBATIM
Story-AI fallback used only when no `combatAssistant` is configured (tooltip elsewhere:
"MUCH more accurate with a combatAssistant model").
```ts
const INITIATE_COMBAT_TOOL = {
  type: 'function' as const,
  function: {
    name: 'initiate_combat',
    description:
      "Signal that physical combat is beginning. Call this the moment a fight actually starts " +
      "(a strike is launched, an ambush triggers), NOT for threats or posturing. List the " +
      "hostile parties so the engine can build the encounter. The engine owns all stats and " +
      "resolution — you are only flagging that combat mode should open.",
    parameters: {
      type: 'object' as const,
      properties: {
        foes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name:       { type: 'string', description: 'Name or short label, e.g. "Drunk Pirate".' },
              count:      { type: 'integer', description: 'How many of this foe (mooks). Default 1.' },
              combatTier: { type: 'string', enum: ['minion','grunt','elite','boss','legendary'], description: 'Threat level.' },
              archetype:  { type: 'string', enum: ['bulwark','assassin','caster','skirmisher','brute'], description: 'Fighting style.' },
            },
            required: ['name'],
          },
          description: 'The hostile combatants entering the fight.',
        },
      },
      required: ['foes'],
    },
  },
} as const;
```
Handler: validate/clamp `count` (≥1, default 1), coerce bad `combatTier`/`archetype` to
`'grunt'`/`'skirmisher'`, return the cleaned `{ foes }` as JSON. Do NOT roll stats here —
materialization is the combat slice's job.

### 2.5 Worked example for the test (chandelier) — expected adjudicator output
Input: *"I jump onto the bar table, swing on the chandelier to build momentum, then drop onto
the pirate aiming for his face."*
Expected bounded enums:
```json
{ "stat": "SPD", "advantage": "advantage", "positionTag": "elevated", "momentumToken": 1, "riskOnFail": "prone" }
```
Rationale (for the test's intent, not asserted literally beyond these values): acrobatic →
SPD; clever high-ground drop → advantage + elevated; flashy combo earns the one-use token;
a botched swing drops you prone. **No damage field present** — the test must assert the
result has no `damage`/`hp`/`dice` keys.

---

## 3. npcDetector rubric — `src/services/npc/npcDetector.ts`

When detecting/generating a **combat-relevant** NPC, also assign `combatTier` and `archetype`.
Append this rubric to the existing detection/generation prompt (do not replace existing fields;
do not touch the unrelated narrative `tier` field — this is `combatTier`).

### Rubric — VERBATIM
```
For any NPC who could plausibly fight, also assign:

combatTier (raw threat / how dangerous in a fight):
- "minion": fodder, untrained, dies fast (street thug, conscript).
- "grunt": competent rank-and-file (trained soldier, seasoned bandit). DEFAULT if unsure.
- "elite": a standout threat (captain, veteran duelist, skilled mage).
- "boss": a major antagonist who anchors an encounter.
- "legendary": world-class, a fight against them is a set-piece.
NOTE: combatTier is COMBAT threat, independent of narrative importance — a beloved harmless
shopkeeper is "minion"; a feared assassin cameo can be "elite".

archetype (how they fight — drives their AI behavior):
- "bulwark": tanky defender, protects allies (knight, bodyguard).
- "brute": raw offense, heavy hits (berserker, ogre).
- "assassin": fast, precise, burst (rogue, ninja).
- "skirmisher": mobile, adaptable, ranged/hit-and-run. DEFAULT if unsure.
- "caster": magic/tech ranged, fragile (mage, hacker, sniper-mystic).

Only assign these for combat-relevant NPCs. If the NPC is purely social/narrative and would
never fight, you may omit them (the store backfills defaults).
```

---

## 4. Orchestration notes (for the wiring agent)
- **Scanner runs as step 0** in `executeTurn`, before any narration call, only when combat
  mode is enabled and a `combatAssistant` provider exists. Its result gates the combat path.
- **2 LLM calls per round, flat** in active combat: (1) adjudicate the player's freeform
  action *if* freeform (button actions = 0 calls), (2) narrate the engine-computed outcome.
  Enemies are deterministic (Phase 2 engine) — no per-enemy calls.
- **Engine resolves BEFORE narration.** Dispatch `adjudicate_action` → feed bounded enums to
  the engine (`runCombatTurn`) → THEN narrate from the resolved ledger. Never narrate first.
- Dispatch `initiate_combat` / `adjudicate_action` in the recursive tool loop beside
  `roll_dice` / `update_scene_notebook`, returning JSON strings like the other handlers.
- Use `tool_choice` to force `adjudicate_action` when routing a known freeform-in-combat input.
```

---

## 5. Adjudicator completion prompt — `handleCombatAction` freeform path (Phase 4.1)

The freeform/SETUP path in `handleCombatAction` makes a **raw aux-model completion** (not a
tool call), so it needs a prompt string — the same way the scanner does. The bare
`llmCall(auxProvider, source.freeformText, …)` with no instructions was wrong (the model has
no idea it must emit the enum JSON, so everything collapsed to defaults). Use this VERBATIM,
then pass the player's freeform text after the delimiter.

### 5.1 Adjudicator prompt — VERBATIM
```
You are a combat maneuver adjudicator for a text RPG. The player has described a freeform
action mid-combat. Translate the fiction into bounded mechanical labels. You do NOT decide
damage, hit/miss, or any number — the engine owns all of that. You only choose labels.

Given the player's described maneuver, output:
- stat: which stat governs it — PWR (raw force), SPD (agility/acrobatics/finesse), WIL
  (mental/magic/willpower), VIT (endurance/toughness), RES (bracing/guarding), FOC (technique fuel).
- advantage: "advantage" if the fiction is clever or sets up a clear edge (high ground, an
  opening, a distraction); "disadvantage" if it's reckless, clumsy, or off-balance; otherwise "normal".
- positionTag: where the actor ends up — "elevated" (high ground, benefits them), "cover"
  (shielded vs ranged), "exposed" (open/vulnerable), or "none".
- momentumToken: 1 if this is clearly a setup that earns a one-use boon for the follow-up
  attack; otherwise 0. Never more than 1.
- riskOnFail: what befalls the actor if the maneuver flops — "prone", "exposed",
  "drop_weapon", "self_stagger", or "none". Bolder/riskier stunts should carry a real risk.

Respond with ONLY a JSON object, no prose, no markdown:
{"stat":"PWR","advantage":"normal","positionTag":"none","momentumToken":0,"riskOnFail":"none"}
```
Build the call as: `${ADJUDICATOR_PROMPT}\n\n----- PLAYER MANEUVER -----\n${source.freeformText}`.
Keep `temperature: 0.3`, `maxTokens: 200`. Strip `<think>` blocks before `handleAdjudicateTool`.

### 5.2 Use the adjudicated `stat` (currently dropped)
`handleCombatAction` reads `adjudicated.stat` then discards it (the dead `VALID_STATS.has(...)`
line). Instead, resolve the maneuver against the chosen stat: look up the actor in
`combatState.combatants[baseAction.actorId]`, compute `mod = abilityMod(actor.stats[stat])`,
and set on the action `attackBonus = mod + actor.proficiencyBonus` and `scalingStatMod = mod`.
Coerce an invalid/missing stat to `'PWR'` first.

### 5.3 Apply `riskOnFail` (the creativity penalty — currently ignored)
`riskOnFail` is plumbed but nothing consumes it, so botched stunts cost nothing. Make it real
in the ENGINE (testable), not the orchestrator: add optional `riskOnFail?: RiskOnFail` to
`CombatAction`; in `runCombatRound`, when an attack action carries `riskOnFail` and the
attack **misses** (`!result.hit`), apply the consequence to the ACTOR before pushing the
resolution:
- `'prone'`        → push `'prone'` onto `actor.statusEffects`
- `'exposed'`      → set `actor.position = 'exposed'`
- `'drop_weapon'`  → push `'disarmed'` onto `actor.statusEffects`
- `'self_stagger'` → push `'staggered'` onto `actor.statusEffects`
- `'none'`         → nothing
Echo what was applied on the resolution (e.g. `riskApplied: 'prone'`) so narration can mention it.

---

## 6. Foe-classifier prompt — `src/services/turn/combatEntry.ts` classifyUnknownFoes

Used when combat entry encounters foe names **not found in the NPC ledger**. A single cheap aux-model
completion infers `{combatTier, archetype, count}` for each unknown foe, so the engine can
materialize mooks without requiring the story-AI `initiate_combat` tool.

### 6.1 Output contract
```ts
export type ClassifiedFoe = {
    name: string;          // original unreduced name from entitiesReferenced
    combatTier: CombatTier;
    archetype: Archetype;
    count: number;         // ≥ 1, default 1
};
```

Handler clamps: `combatTier` → one of `'minion'|'grunt'|'elite'|'boss'|'legendary'` (default `'grunt'`);
`archetype` → one of `'bulwark'|'assassin'|'caster'|'skirmisher'|'brute'` (default `'skirmisher'`);
`count` → integer ≥ 1 (default 1).

### 6.2 Foe-classifier prompt — VERBATIM

```
You are a combat encounter classifier for a text RPG. Given a list of unknown foe names and the
recent scene, infer each foe's combat threat level, fighting style, and quantity.

Use these rubrics EXACTLY:

combatTier (raw threat / how dangerous in a fight):
- "minion": fodder, untrained, dies fast (street thug, conscript, rat, mob goon).
- "grunt": competent rank-and-file (trained soldier, seasoned bandit, city guard). DEFAULT if unsure.
- "elite": a standout threat (captain, veteran duelist, skilled mage, gang boss).
- "boss": a major antagonist who anchors an encounter (warlord, dragon, crime lord).
- "legendary": world-class, a fight against them is a set-piece (ancient wyrm, demigod).

archetype (how they fight — drives AI behavior):
- "bulwark": tanky defender, protects allies (knight, bodyguard, shield-bearer).
- "brute": raw offense, heavy hits (berserker, ogre, brawler).
- "assassin": fast, precise, burst (rogue, ninja, sniper).
- "skirmisher": mobile, adaptable, hit-and-run. DEFAULT if unsure.
- "caster": magic/tech ranged, fragile (mage, hacker, mystic sniper).

Rules:
- If the foe name is plural or collective ("three hooligans", "guards"), set count accordingly;
  otherwise default count to 1.
- If you cannot confidently determine tier or archetype, default to "grunt" and "skirmisher".
- Do NOT invent foes not in the input list. Classify ONLY the names given.

Respond with ONLY a JSON array, no prose, no markdown:
[{"name":"<exact name from input>","combatTier":"grunt","archetype":"skirmisher","count":1}]
```

Build the call as: `${FOE_CLASSIFIER_PROMPT}\n\n----- INPUT -----\n\n[Foe names]\n${foeNames.join(', ')}\n\n[Recent scene]\n${recentScene}`.
Use `temperature: 0.2`, `maxTokens: 300`. Strip `<think>` blocks before parsing.
On parse failure or any error, fall back to a single `{ name: foeNames[0] ?? 'Unknown Foe', combatTier: 'grunt', archetype: 'skirmisher', count: 1 }` entry.
