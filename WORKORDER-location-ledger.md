# WORKORDER — Location Ledger (v1)

**Executor:** GLM (mechanical implementation; all design decisions are already made — do NOT redesign, do NOT add scope)
**Scope:** desktop app only (`src/`). Do NOT touch `mobile/`, `packages/engine/`, or `server/` (except nothing — no server changes are needed; persistence rides the existing campaignStore API).

---

## 1. What this is

A **Location Ledger** — the place-analogue of the NPC Ledger. Structured entries for places the story has visited (name, aliases, parent region, features, connections to other places), populated automatically by a post-turn **state estimator** and editable by the player in a modal. One pointer (`currentPlaceId` + optional `currentFeature`) tracks where the PC is right now, and a compact `[LOCATION]` block is injected into the volatile payload so the story AI stops teleporting people and reuses consistent geography.

**Design doctrine (do not violate):**
- The engine is the **sole writer** of the ledger and the current-place pointer. The LLM only proposes; the player can always override.
- The estimator is **state estimation, not event detection**: every commit it answers "where is the PC now?" from recent text against a **closed vocabulary** (known places + their features + connections + `new`/`unclear` escapes). Wrong answers are cheap and self-heal next turn; `unclear` keeps the last known place.
- **Nothing gates on location.** No movement buttons, no legality checks, no travel costs. The ledger observes the fiction; it never permits or forbids it.

### Explicitly OUT of scope (later tiers — do not build any of this)
- Any map rendering: no grid, no tokens, no canvas, no images
- Anchor maps / scene-scale positioning, combat coupling, position tags
- Movement buttons, travel actions, pathfinding, distance costs
- Seeding from campaign lore at init; coupling to the overworld `mapEngine`
- Binding NPC `region`/`haunt` to ledger entries
- Any new tool call for the story model

---

## 2. Architecture — patterns to mirror (read these before writing code)

1. `src/services/inventoryParser.ts` — the whole shape of the estimator: `scanX(provider, messages, currentState) → newState`, `llmCall` with `priority: 'low'` + `trackingLabel` + `AI_CALL_TIMEOUT_MS`, markdown-fence stripping, JSON parse, **return current state unchanged on ANY error**. `applyOps` as a pure exported function for tests.
2. `src/services/turn/postTurnPipeline.ts` — grep where `scanInventory` is invoked: background queue usage, `makeGuarded` / `assertStillActive` campaign-switch guards, `tierAllows` gating. Wire the location scan **identically, in the same place, with the same guards**.
3. `src/store/campaignStore.ts:102` (`saveNPCLedger`) — persistence. Add `saveLocationLedger` / load with key `locations_${campaignId}`, mirroring the NPC ledger's save/load/debounce and its hydration point in `setActiveCampaign` (find via grep — do not guess).
4. `grep -rn "npcLedger" src/store/` — where the ledger array + its setters live in the store. `locationLedger` goes in the same slice with the same setter style.
5. `src/services/payload/volatile.ts:48` — the `[INVENTORY]` block. The `[LOCATION]` block is built the same way, in the same file.
6. `src/components/NPCLedgerModal.tsx` + `src/components/npc-ledger/NPCSuggestionsPanel.tsx` — modal structure and the "detected but not added" suggestion UX to copy.
7. `src/types/character.ts` `NpcSuggestion` — the suggestion type pattern.

---

## 3. Data model — `src/types/location.ts` (new file, re-export from `types/index`)

```ts
export type LocationConnection = {
    toId: string;                       // id of another LocationEntry
    band?: 'adjacent' | 'short' | 'long'; // travel-distance texture; default 'short'
    note?: string;                      // "locked at night", "guarded gate"
};

export type LocationEntry = {
    id: string;                         // `loc_${Date.now()}_${rand}` (mirror inventory id style)
    name: string;                       // "Ninja Academy"
    aliases: string;                    // comma-separated, same convention as NPCEntry.aliases
    broadLocation: string;              // parent region as plain string v1, e.g. "Konoha"
    features: string[];                 // ["Class A","Class B","training yard","teacher lounge"]
    connections: LocationConnection[];
    description: string;               // 1–2 sentences of texture; injected
    status?: string;                    // "burned down in ch. 12" — optional, injected when set
    firstSeenScene: string;
    lastSeenScene: string;
    source: 'llm' | 'manual';
};

/** A place the estimator noticed but did NOT add — the player decides. (Mirrors NpcSuggestion.) */
export type LocationSuggestion = { name: string; connectedTo?: string; context?: string; firstSeen: number };
```

**Current-place pointer:** add to `GameContext` (`src/types/gamecontext.ts`), optional → lazy migration, house style:

```ts
currentPlaceId?: string | null;
currentFeature?: string | null;   // free-string feature within the current place
```

Persist exactly like the other `context` fields (no new persistence path).

---

## 4. Files to create

### 4.1 `src/services/locationParser.ts` (estimator — mirrors inventoryParser.ts)

```ts
export type LocationScanResult = {
    ledger: LocationEntry[];            // updated ledger (features/connections merged into existing entries)
    currentPlaceId: string | null;      // resolved id, or unchanged input value when 'unclear'
    currentFeature: string | null;
    suggestions: LocationSuggestion[];  // NEW places — never auto-added
};

export async function scanLocation(
    provider: ProviderConfig | EndpointConfig,
    messages: ChatMessage[],            // last 6 committed messages
    ledger: LocationEntry[],
    currentPlaceId: string | null,
): Promise<LocationScanResult>;

export function applyLocationOps(/* pure — see rules below; unit-tested */): LocationScanResult;
```

**Hard rules (the parser is the safety net — do not trust raw model output):**
- Resolve the model's `current.place` string against ledger `name` + `aliases` (case-insensitive). No match and not declared new → treat as `unclear`.
- `unclear` (or parse failure, or empty output, or thrown error) → return everything unchanged. **Never blank the pointer.**
- New places go to `suggestions` ONLY — never directly into the ledger. Cap at **2 suggestions per scan**; drop the rest.
- `addFeatures` / `addConnections` may only target **existing** entries; dedupe case-insensitively; cap features at 20/entry, connections at 8/entry.
- Connections are stored one-directionally as emitted; when adding `A→B` also add the reverse `B→A` if absent (bidirectional default).
- Touch `lastSeenScene` on the resolved current entry.

**Estimator prompt — VERBATIM (do not rewrite):**

```
You are a location tracker for a text RPG. Determine where the player character is NOW, at the end of the recent chat below. This is state estimation, not event detection: answer from the text's current situation, not from movement verbs.

=== KNOWN PLACES ===
{for each ledger entry: {"id":"...","name":"...","aliases":"...","features":[...],"connectedTo":["<names>"]}}
CURRENT (last known): {name of currentPlaceId, or "unknown"}

=== RECENT CHAT ===
{last 6 messages, [ROLE]: content}

=== INSTRUCTIONS ===
Return ONLY a JSON object, no prose, no markdown:
{
  "current": {"place": "<known place name/alias | NEW place name | unclear>", "feature": "<feature name within that place, or null>"},
  "newPlaces": [{"name": "", "broadLocation": "", "connectedTo": "<known place name>", "context": "<5-10 word quote>"}],
  "updates": [{"place": "<known place name>", "addFeatures": [], "addConnections": ["<known place name>"]}]
}

Rules:
- Prefer a KNOWN place over declaring a new one. Match loosely against names and aliases.
- "unclear" if the text does not establish where the PC is. When in doubt, "unclear" — the last known place then stands.
- newPlaces: only places the PC is AT or that are concretely established as adjacent scenery. Never places merely mentioned in dialogue, memories, or stories.
- updates: only rooms/features and connections the text actually establishes for known places.
- If nothing changed: {"current":{"place":"unclear","feature":null},"newPlaces":[],"updates":[]}
```

### 4.2 `src/components/LocationLedgerModal.tsx`

Mirror `NPCLedgerModal.tsx` structure/styling at a simpler scale:
- Entry list (name + broadLocation), click to edit: name, aliases, broadLocation, description, status, features (add/remove chips or comma field — match whatever the codebase already uses for `keywords`), connections (pick another entry from a dropdown + band select + note).
- Manual add (`source: 'manual'`), delete (confirm), and a **"Set as current"** button per entry (writes `currentPlaceId`, clears `currentFeature`).
- A suggestions section listing `LocationSuggestion`s with Accept (creates entry with `source: 'llm'`, pre-filled connection to `connectedTo` when it resolves) / Dismiss. Copy `NPCSuggestionsPanel.tsx`.
- Mount the open-button wherever `NPCLedgerModal`'s trigger lives (grep its usage; place beside it, `MapPin` icon from lucide-react).

### 4.3 Store + persistence

- `locationLedger: LocationEntry[]`, `locationSuggestions: LocationSuggestion[]` + setters in the same slice as `npcLedger` (found via grep §2.4).
- `saveLocationLedger` / load in `campaignStore.ts`, key `locations_${campaignId}`, mirroring `saveNPCLedger` including debounce; hydrate in `setActiveCampaign` beside the NPC ledger load. Missing/absent data → `[]` (existing campaigns unaffected).

---

## 5. Files to modify

### 5.1 `src/services/turn/postTurnPipeline.ts`
Invoke `scanLocation` exactly where and how `scanInventory` is invoked (same background queue, same `makeGuarded`/`assertStillActive` guards, same `tierAllows` gate class). Apply results: setters for ledger + suggestions, and `callbacks.updateContext` (or the established context-patch path) for `currentPlaceId`/`currentFeature`. Runs on commit only → swipe-safe by construction.

### 5.2 `src/services/payload/volatile.ts`
Beside the `[INVENTORY]` block: when `context.currentPlaceId` resolves against the ledger, emit

```
[LOCATION]
At: <name> (<broadLocation>)<currentFeature ? ` — <feature>` : ''><status ? ` — <status>` : ''>
<description>
Nearby: <connection names, band in parens when not 'short', comma-separated>
Known rooms/features: <features, comma-separated>
```

Hard cap the whole block at **~400 characters** (truncate `features` first, then `Nearby`). Emit nothing when there is no resolved current place — zero regression for campaigns that never use the ledger.

---

## 6. Tests (vitest — write alongside, mirror `postTurnPipeline.test.ts` / inventory tests)

`src/services/__tests__/locationParser.test.ts`:
1. `applyLocationOps` — alias resolution (case-insensitive, loose match), `unclear` leaves pointer + ledger untouched, parse-garbage → unchanged, new place lands in suggestions not ledger, suggestion cap of 2, feature/connection dedupe + caps, bidirectional connection mirroring, `lastSeenScene` touch.
2. Volatile block: fixed format, 400-char cap honored, absent when no current place.
3. Guard behavior: campaign-switch during scan drops the write (reuse the `campaignGuard.test.ts` approach).

---

## 7. Verification

- `npm run lint`, `npx vitest` green.
- Manual smoke (dev: `npm run dev`): play 3–4 turns naming a place ("I head to the ninja academy for the test") → suggestion appears → accept → `[LOCATION]` block visible in the payload (dev tooling/log) on the next turn → travel to a second place → pointer follows → revisit the first → same entry, same features. Edit an entry in the modal and confirm persistence across app reload.
