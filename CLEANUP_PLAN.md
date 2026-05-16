# Cleanup Plan — TRIM / Divergence port follow-up

## Context

The TRIM + Divergence `knownBy` port (replacing the LLM condenser with synchronous trim,
adding witness tracking) is implemented and working in `mainApp`. A code review surfaced 8
observations. After verification against `mobileApp` (the source of truth), **only 4 are
genuine** — all trivial dead-code / parity nits, no runtime bugs.

This plan covers exactly those 4. Apply them and nothing else.

## Scope: 4 fixes

### Fix 1 — `src/components/hooks/useCondenser.ts`: dead imports + window constant

Three imports are unused, and the trim window is hardcoded as `6` instead of using the
shared constant (`mobileApp` uses `getVerbatimWindow()`, which returns `10`).

- **Line 2** — change:
  ```ts
  import { computeTrimIndex, shouldCondense, getCondenseBudgetRatio } from '../../services/condenser';
  ```
  to:
  ```ts
  import { computeTrimIndex, getVerbatimWindow } from '../../services/condenser';
  ```
- **Line 3** — delete entirely (`useAppStore` is never used):
  ```ts
  import { useAppStore } from '../../store/useAppStore';
  ```
- **Line 15** — change:
  ```ts
  if (deps.messages.length <= 6) return;
  ```
  to:
  ```ts
  if (deps.messages.length <= getVerbatimWindow()) return;
  ```

### Fix 2 — `src/services/payloadBuilder.ts`: orphaned `budgetMap.summary`

The `summary` budget key is computed but no longer read (it was consumed by the removed
`condensedSummary` block). Only `budgetMap.world` is actually used.

- In `budgetMap` (the `deepContextSummary ? {...} : {...}` ternary, ~lines 183-195),
  delete the `summary: Math.floor(limit * 0.10),` line from **both** branches.

Leave `stable` and `volatile` keys alone — they are pre-existing unused keys, out of scope.

### Fix 3 — `src/services/condenser.ts`: `shouldCondense` default ratio

The default `budgetRatio` is `0.85`; `mobileApp`'s default is `0.75`. No runtime effect today
(every caller passes the ratio explicitly), but align for parity.

- **Line 18** — change `budgetRatio: number = 0.85` to `budgetRatio: number = 0.75`.

### Fix 4 — verify no leftover references

After Fixes 1-3, confirm `getVerbatimWindow` is now imported/used (Fix 1) so it is no longer
an unused export, and that `shouldCondense` / `getCondenseBudgetRatio` are still used by
`turnOrchestrator.ts` (they are — leave them in `condenser.ts`).

## Do NOT change

- **Trim gate in `turnOrchestrator.ts`** — the review flagged the `condenser` snapshot as
  "stale". It is not a bug: `mobileApp` uses the identical snapshot pattern, and within a
  single turn `condensedUpToIndex` has exactly one writer (trim itself, which has not yet
  run). `allMsgs2` is correctly read fresh. Leave it as-is.
- **`knownBy` resolution in `saveFileEngine.ts`** — the review suggested surfacing unmatched
  `knownBy` names via `reviewFlag` / `unrecognizedNpcNames`. Do NOT do this. `mobileApp`
  deliberately resolves `knownBy` best-effort and silently drops unmatched values (falling
  back to broadcast). `knownBy` is a soft witness hint, not authoritative like `npcIds`.
  Changing it would diverge from the source of truth.
- `resetCondenser` in `UseCondenserDeps`, the redundant `sections` computation in
  `divergenceRegister.ts`, and the pre-existing unused `safeSceneNum` import — all cosmetic,
  several inherited verbatim from `mobileApp`. Skip.

## Verification

1. `npx tsc --noEmit` — must pass (catches any remaining unused imports / missing symbols).
2. `npm test` — existing condenser/divergence tests must stay green.
3. Sanity: send 12+ messages in a campaign, confirm trim still advances
   `condenser.condensedUpToIndex` after the budget threshold, and the manual Condense button
   still works.
