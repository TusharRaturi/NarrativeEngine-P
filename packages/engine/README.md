# @narrative/engine

Shared Narrative Engine core — pure TypeScript game logic consumed by both shells:
**desktop** (`../../mainApp`, Vite + Express/better-sqlite3) and **mobile**
(`../../mobileApp`, Capacitor + IndexedDB). Part of the Monorepo plan at
`mobileApp/Upgrade/OpusPlans/Monorepo/`.

## Rules (enforced)

- **No platform code.** No React, Zustand, Capacitor, DOM, Node APIs, or storage.
  Enforced twice: tsconfig has no DOM/Node libs, and `scripts/boundary-gate.mjs`
  (runs before `npm test`) rejects platform imports.
- **Apps consume `dist/`** via `"@narrative/engine": "file:../packages/engine"`
  (installed as a junction). After editing engine source run `npm run build` here —
  both apps see the new dist instantly through the junction.
- **Per-app divergences are injected, never baked in.** Example: `rollEngines`
  takes each shell's default tag lists and world-tag formatter as options; the
  apps' thin wrappers (`src/services/engine/engineRolls.ts` in each) supply them.
- **Types are structural twins** of the app types. Apps keep their own `src/types`
  as source of truth for UI code; the engine declares only the fields it reads.
- **Never change behavior during a move.** Both apps carry behavior-lock tests
  (`rollsBehaviorLock.test.ts`) written before extraction; they must pass unchanged.

## Modules

| Folder | Contents | Canon origin |
|---|---|---|
| `rolls/` | 3-gate dice, world/surprise/encounter engines, tier mapping | identical in both apps; tag format per-app |
| `loot/` | loot tree walker (`resolveLootDrop`) | byte-identical |
| `retrieval/` | IDF + RRF fusion | desktop (Map rank lookup) |
| `json/` | LLM JSON extraction + repair | merge of both + parse-first guard |
| `npc/` | hex envelope tables, voice directive | byte-identical |

## Commands

```
npm run build   # tsc → dist (required after source edits)
npm test        # boundary gate + vitest
```
