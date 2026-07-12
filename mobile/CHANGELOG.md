# Changelog

This changelog covers the updates to NarrativeEngine-M from commit `360e6006823fef872b002028400fec8e4564cefb` onwards, concluding with the release of version **v1.5.0 (vc25)**.

---

## 🚀 Engine-Governed Combat Mode v1.1 (Phases A-G)
The repository has received a complete text-RPG combat system governed entirely by the local engine, replacing open-ended narrative combat with bounded mechanical systems (D&D 5e RAW rules, custom FOC resource replacing spell slots).

### 🗡️ Phase A: Deterministic Enemy AI Turn Resolver (`259dcf4`)
- Implemented a 3-tier cascade for enemy action selection: **Personal Override** $\rightarrow$ **Archetype Conditional** $\rightarrow$ **Archetype Weighted Roll & Target Selection**.
- Runs purely deterministically on the engine side without auxiliary LLM calls.
- Automated positional handling: melee characters on `Apart` range automatically close the gap; casters strike at any distance; defense actions downgrade to bracing.
- Formalized the `NPCOverride` type and integrated it into the combat slice.

### 🛡️ Phase B: Compendium-Driven Gear Resolution (`be0e996`)
- Integrated weapon, armor, and skill maps directly into combat round adjudication.
- Added scaling stats and weapon bonuses to both to-hit rolls and damage output.
- Gated skill triggers on Focus (FOC), implementing FOC cost deduction and insufficient focus checks.
- Developed end-to-end healing skills (capped at maximum HP) and resolved armor AC from item definitions.
- Ensured skill-less mental attacks are treated as saving throws (causing zero base damage), preventing enemy casters from getting free damage.

### 🧠 Phase C: Context Pipeline & Story Narration Integration (`1069100`)
- Rerouted combat round narration through the primary story payload rather than isolated one-shot LLM prompts.
- Injected volatile `[COMBAT STATE: VOLATILE]` blocks containing active combatant stats, ranges, and context directly into the prompt history before appending the round outcome.
- Configured history fitting to retain the last 6 lines of the combat ledger to maintain narrative flow once a combat session ends.

### ⚕️ Phases D-F: AI Recovery Adjudication & NPC Gen (`bb5d76e`)
- Built an auxiliary LLM-based `recoveryAdjudicator` to evaluate post-encounter health status (healthy/wounded/critical) with a fallback to the last-known conditions.
- Enabled configurable mook-jitter (default 10%) on health pools.
- Added a full Compendium UI for authoring skills and items, alongside combat-stats-aware NPC generation scaffolding.

### 🧙‍♂️ Phase G: Guided PC Creation Wizard (`8d133d0`)
- Built a 3-step character creation wizard and point-buy attribute allocator (normal 27-point or overpowered 37-point budgets).
- Enabled automated archetype drafting and interactive lore browsing.
- Overrode LLM profile generations with strict engine-level statistics when generating characters.
- Raised the maximum stat cap for overpowered PCs from 18 to 20.

---

## ⚡ Performance & Caching Upgrades (`360e600`)
- Refactored prompt building to support a **stable prefix architecture** to optimize LLM prompt cache hits.
- Separated pinned memories and scene notes: pinned memories are emitted as stable system messages with `cache_control` headers; scene notes reside strictly within the volatile prompt section.
- Split fitted dialogue history to keep it append-only with zero inline system messages.
- Updated `EngineTraceView` to visualize caching boundaries (Cached Prefix vs. History vs. Current Turn).

---

## 🔧 AI Preset & Provider Decoupling (`27f7eb4`)
- Decoupled `LLMProvider` objects from `AIPreset` objects, creating a unified global providers list.
- Configured presets to refer to provider IDs, allowing users to configure API keys and endpoints once and reuse them across presets.
- Added automatic deduplication migrations on startup.
- Introduced a dedicated **ProvidersPanel** tab and updated presets config with 4 role dropdowns.

---

## 🛡️ Stability, UX, and Bug Fixes
- **Freeform Combat Refinements** (`0c88ac6`): Fully wired freeform paths using an adjudicator prompt, proper stat checks, and specific risk evaluations on failures (e.g., prone, exposed, disarmed, staggered).
- **Combat Toggle Fix** (`4390bd7`): Separated `combatModeActive` (feature enabled) from `combatState.active` (actively in combat) to prevent the HUD from hijacking the chat input when no combat was active.
- **Turn Re-entrancy & No-PC Guard** (`8e5f310`, `30a814a`): Claims turns synchronously to block duplicate taps during scans, and restricted combat entry to rosters containing at least one PC.
- **Escape Route** (`7b74592`): Added an explicit **End Combat** escape button to the HUD to clear stranded combat state safely.
- **Build Quality**: Cleared all strict compilation errors (`tsc -b` and ESLint) across multiple commits (`f41fdd0`, `5447053`, `8d133d0`).

---

## 🏷️ Release History
- **v1.4.0 (vc23)** (`d18b607`): Initial introduction of engine-governed Combat Mode v1.1.
- **v1.4.1 (vc24)** (`7ec4553`): Version bump for playtest round 2.
- **v1.5.0 (vc25)** (`2209e6e`): Feature-complete Combat Mode release (covering Phases C-G).
