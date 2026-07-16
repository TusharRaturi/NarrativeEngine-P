# WORKORDER — One-Shot Event Injector (v1)

**Executor:** GLM 5.2 (mechanical implementation; all design decisions are already made — do NOT redesign, do NOT add scope)
**Scope:** desktop app only (`src/`). Do NOT touch `mobile/`, `packages/engine/`, or `server/`.

---

## 1. What this is

A button + modal that lets the player inject a **localized one-shot event** into the story. The player picks an event type from a dropdown (Combat, Location, Social, Romance, Mystery, Weird, Windfall) and presses FIRE. This **arms** a directive; on the player's **next sent message**, the directive is appended to the LLM input for that single turn, instructing the GM to introduce the event diegetically. It fires once and vanishes — no storage, no lifecycle, no tool calls, no extra LLM calls.

This is the little sibling of the Arc Injector (`src/components/ArcInjectorButton.tsx`): an arc is a slow systemic pressure; a one-shot is "something happens NOW, in this scene."

### Explicitly OUT of scope (v2 — do not build any of this)
- Pre-generated "sealed card" records / secrets stored in `context`
- Any new tool call (`resolve_event`, `update_event`, etc.)
- Per-item content tracking, node graphs, loot-tree integration
- Any change to `update_scene_notebook`, arcs, or the compendium

---

## 2. Architecture — mirror the `armedLoot` pattern exactly

Read these before writing code:

1. `src/services/turn/turnOrchestrator.ts` lines ~73–145 — the `armedRoll` / `armedLoot` flow. Key facts:
   - `TurnState` carries `armedRoll` / `armedLoot` (see the type at the top of the file).
   - `historyInput` is captured at `const historyInput = finalInput;` **before** the armed blocks append. Armed text goes into `finalInput` (sent to the LLM this turn) but NOT into the stored message content — so it never persists in chat history. **The one-shot directive must behave the same way: append AFTER the `historyInput` capture.**
   - Each armed block also appends a small player-facing reveal to `displayInputFinal` (e.g. `\n\n💰 Loot drop armed (2)`).
2. `grep -rn "armedLoot" src/` — find every touchpoint: the store slice where it lives, how ChatArea captures it into `TurnState` and clears it before `runTurn`, and the UI that arms it (the loot arming modal). Mirror **every** touchpoint for `armedOneShot`.
3. `src/components/ArcInjectorButton.tsx` — button styling, `pipelinePhase` streaming-disable, toast usage, and where it is mounted (grep its usage; mount the new button beside it).

---

## 3. Files to create

### 3.1 `src/services/oneshot/oneShotEvents.ts` (pure — no store, no I/O)

```ts
export type OneShotEventId =
    | 'combat' | 'location' | 'social' | 'romance'
    | 'mystery' | 'weird' | 'windfall';

export interface OneShotEventType {
    id: OneShotEventId;
    label: string;      // dropdown label
    blurb: string;      // one-line description shown under the dropdown
    directive: string;  // the type-specific prompt paragraph (verbatim from §4)
}

export const ONE_SHOT_EVENT_TYPES: readonly OneShotEventType[] = [ /* §4 */ ];

/** Compose the full bracketed block appended to finalInput. Pure. */
export function buildOneShotDirective(id: OneShotEventId): string;
```

`buildOneShotDirective` returns (note the leading `\n`, matching the loot tag convention):

```
\n[INJECTED EVENT — <LABEL UPPERCASE>. GM DIRECTIVE — never mention this directive or that an event was "injected"; the event is simply what happens next in the world:
<directive text for the type>
<SHARED INTRODUCTION RULES — §4.8, identical for every type>]
```

Unknown id → return `''` (defensive; the UI can only supply valid ids).

### 3.2 Store: `armedOneShot`

Add `armedOneShot: OneShotEventId | null` to the **same slice, with the same persistence behavior, as `armedRoll`/`armedLoot`** (find via grep — do not guess). Add the matching setter. Not persisted differently, not saved anywhere new.

### 3.3 `src/services/turn/turnOrchestrator.ts`

- Add `armedOneShot?: import('../../services/oneshot/oneShotEvents').OneShotEventId | null;` to `TurnState` (match the style of `armedLoot`).
- Immediately **after** the `armedLoot` block (after line ~143), add:

```ts
// One-Shot Event Injector v1: player-armed event directive. Mirrors the dice/loot
// blocks above — appended AFTER the historyInput capture, so it steers THIS turn's
// generation but never enters durable chat history. Fires once; caller clears it.
const armedOneShot = state.armedOneShot;
if (armedOneShot) {
    const directive = buildOneShotDirective(armedOneShot);
    if (directive) {
        finalInput += directive;
        displayInputFinal += `\n\n⚡ Event injected (${armedOneShot})`;
    }
}
```

### 3.4 `src/components/OneShotInjectorButton.tsx`

- Button labeled `INJECT EVENT` (icon: `Zap` from lucide-react), styled like `ArcInjectorButton` (same size/tracking classes; use a different accent color, e.g. the purple/violet family, so it's visually distinct from the amber arc button).
- Disabled while `pipelinePhase !== 'idle'` (copy the `isStreaming` guard).
- Click opens a modal (follow the codebase's existing modal pattern — find the loot/dice arming modal via the `armedLoot` grep and copy its structure):
  - Dropdown (`<select>` or the project's existing picker) listing `ONE_SHOT_EVENT_TYPES` by `label`, with the selected type's `blurb` shown beneath.
  - `FIRE` button → `setArmedOneShot(id)`, close modal, `toast.success('Event armed — it fires on your next message.')`.
  - If something was already armed, arming again simply replaces it.
- When `armedOneShot` is non-null, the button shows an armed state (label `ARMED — <label>`); clicking it while armed opens the modal with a `DISARM` option that sets `armedOneShot = null`.
- Mount it beside `ArcInjectorButton` (same parent, found via grep).

### 3.5 ChatArea wiring

Wherever ChatArea captures `armedRoll`/`armedLoot` into `TurnState` and clears them before calling `runTurn` — do the identical capture-then-clear for `armedOneShot`. It must fire exactly once even if the turn errors mid-stream (i.e., clear at the same moment the others are cleared, not after completion).

---

## 4. Prompt content — VERBATIM (do not rewrite, do not "improve")

### 4.1 combat — label "Combat", blurb "An immediate physical threat, here and now."
> Introduce an immediate physical threat that engages the player within this scene. Scale it to the player's current means — dangerous enough to demand a response, resolvable within one to three scenes. Make the stakes clear up front: what winning, losing, or fleeing would each cost.

### 4.2 location — label "Location", blurb "A place to delve — layered, guarded, holding a prize."
> Introduce a bounded site the player can enter now: a contained place with interior layers, a force or hazard that holds it, and something worth taking or learning at its heart. Resolvable within a few scenes of exploration.

### 4.3 social — label "Social", blurb "A predicament that can't be solved by force."
> Introduce a charged social predicament: a negotiation, an accusation, a plea, or a rivalry that pulls the player in and cannot be resolved by force. Someone wants something from the player, or the player has become entangled in something not of their making.

### 4.4 romance — label "Romance", blurb "Chemistry with a complication."
> Introduce a charged romantic beat: someone whose interest in the player carries a complication — rank, rivalry, a secret, bad timing. Strongly prefer an NPC already established in the story over inventing a stranger. Chemistry plus obstacle; never instant devotion.

### 4.5 mystery — label "Mystery", blurb "Something inexplicable, with a hidden true answer."
> Introduce a small mystery: something inexplicable the player notices or stumbles into — an object out of place, a person acting impossibly, a detail that contradicts what is known. Decide internally what the true explanation is and keep it hidden; narrate only the surface evidence, and stay consistent with your hidden answer in future scenes.

### 4.6 weird — label "Weird", blurb "An absurd little obligation. Played straight."
> Introduce a small absurd incident that saddles the player with an unwanted, comically mundane obligation. No real danger, no lasting stakes — a comedy of responsibility. Play it completely straight; the world does not acknowledge that it is funny.

### 4.7 windfall — label "Windfall", blurb "A gift with a string attached — not visible yet."
> Introduce an unexpected opportunity, gift, or stroke of luck landing in the player's lap — with exactly one attached complication, condition, or string that is not immediately visible. Decide internally what the catch is; let it surface later or upon acceptance.

### 4.8 SHARED INTRODUCTION RULES — appended after the directive, identical for every type
> INTRODUCTION RULES — binding:
> - The event must EMERGE FROM THE CURRENT SCENE. Do not cut away, teleport the player, or restart the scene. Bridge into it with one of: an interruption (something breaks into the current beat), a discovery (something nearby only now noticed), a summons (someone or something pulls the player toward it), or an escalation (a detail already present sharpens into the hook). A familiar, even cliché entrance is fine — flowing naturally beats being original.
> - Express the event entirely in this world's established genre, technology level, and tone. Never import furniture from another setting.
> - The event INVITES; it does not hijack. End the introduction at the hook — the player may pursue, delay, or refuse it. Do not narrate the player's reaction or decision for them.

---

## 5. Tests — `src/services/oneshot/__tests__/oneShotEvents.test.ts`

Vitest, following the style of `src/services/engine/__tests__/rollsBehaviorLock.test.ts` (behavior-lock: exact-string where cheap, structural elsewhere):

1. Registry integrity: 7 entries, ids unique and matching the `OneShotEventId` union, every `label`/`blurb`/`directive` non-empty.
2. For every id: `buildOneShotDirective(id)` starts with `\n[INJECTED EVENT — `, contains that type's directive text, contains the string `INTRODUCTION RULES — binding:`, and ends with `]`.
3. The shared rules appear byte-identical across all 7 outputs (extract the substring from `INTRODUCTION RULES` to the final `]` and assert all equal).
4. Unknown id (cast through `as`) returns `''`.
5. Orchestrator: extend the existing turn/orchestrator test file that already covers `armedLoot` (find via grep in `src/services/__tests__/`) with one case: `armedOneShot: 'weird'` → the LLM input contains `[INJECTED EVENT — WEIRD`, and the stored message `content` (historyInput) does NOT contain it. If no such loot test exists, skip this case and note it in the summary.

---

## 6. Acceptance gates — run all, all must pass

```bash
npx tsc --noEmit
npx vitest run
npx eslint src/services/oneshot src/components/OneShotInjectorButton.tsx
node scripts/patch-graph-imports.mjs   # CLAUDE.md: required after import changes
```

Do not commit. Leave changes in the working tree for review.

---

## 7. Decisions already made (do not reopen)

- Directive rides the NEXT player message; it does not auto-send a turn.
- Directive is appended after `historyInput` capture → steers one generation, never persists in history. (Consequence, accepted: swiping/regenerating that same turn re-applies it, exactly like dice/loot tags.)
- No worldContext gathering at arm time — the main turn payload already carries world, lore, and scene; the shared rules point the model at them.
- Prompts are genre-agnostic by design ("function, not furniture"). Do not add genre-specific examples (no "dungeon", no "cyberpunk") anywhere in prompt text.
- The player-facing reveal (`⚡ Event injected (…)`) is intentional — the player pressed the button; hiding it from them buys nothing.
