/**
 * Shared constants and helpers for utility-AI prompts (planner, archivist,
 * fact clusterer, NPC drift, lore check, etc.). These are NOT used for the
 * main story turn.
 *
 * Design: every utility prompt is built as
 *   [STATIC PERSONA] / [STATIC TASK + SCHEMA] / [STATIC RULES] /
 *   [STATIC FEW-SHOTS?] / [STATIC FOOTER] / INPUT_DELIMITER / [DYNAMIC DATA]
 *
 * Everything above the INPUT_DELIMITER is byte-identical across calls of the
 * same prompt type, which lets infrastructure prompt-caches reuse it.
 *
 * Output contract is unchanged: utilities still emit free-text JSON which is
 * parsed by extractJson / extractJsonRobust downstream.
 */

export const INPUT_DELIMITER = '----- INPUT -----';

/**
 * Strictest existing JSON-only phrasing in the codebase. Matches the wording
 * used by the retrieval planner today, which is the most carefully tuned.
 */
export const JSON_ONLY_FOOTER =
    'Respond with ONE JSON object only. No prose, no markdown fences.';

export const JSON_ARRAY_ONLY_FOOTER =
    'Respond with ONE JSON array only. No prose, no markdown fences.';

/** Anchor line to put immediately before INPUT_DELIMITER to keep attention on the schema. */
export const ANCHOR_BEFORE_INPUT =
    'Now produce the JSON described above for the INPUT below.';

// ─────────────────────────────────────────────────────────────────────────
// Personas (kept short — task + role only; the schema/rules carry the rest)
// ─────────────────────────────────────────────────────────────────────────

export const TTRPG_PERSONA_ARCHIVIST = 'You are a TTRPG campaign archivist.';
export const TTRPG_PERSONA_GM_ASSISTANT = 'You are a background GM assistant running silently.';
export const TTRPG_PERSONA_STATE_ANALYZER = 'You are a background game state analyzer.';
export const TTRPG_PERSONA_RETRIEVAL_PLANNER =
    'You are a retrieval planner for a TTRPG campaign archive. Output a JSON object that helps focus memory recall for the GM\'s next turn.';

// ─────────────────────────────────────────────────────────────────────────
// De-duplicated rule blocks (verbatim text pulled from current prompts so
// every callsite sees byte-identical instructions)
// ─────────────────────────────────────────────────────────────────────────

/** Canonical event types — kept as a single source so any future change updates all callers. */
export const EVENT_TYPES_LIST =
    'combat, discovery, item_acquired, item_lost, relationship_shift, travel, promise, betrayal, death, revelation, quest_milestone, other';

/**
 * knownBy rules — INVERTED DEFAULT for sensitive categories (NPC omniscience cage, WO2).
 * Sensitive categories seed knownBy from the source scene's witnesses; broadcasting
 * requires either a rules_lore/locations category OR an explicit public-in-fiction signal.
 * Token grammar: "player" | "npc:<id>" | "faction:<name-normalized>".
 */
export const KNOWNBY_RULES = `KNOWNBY RULES:
- knownBy: a JSON array of who currently KNOWS this fact. Token forms:
  "npc:<id>" — a specific ledger NPC by canonical id (e.g. "npc_42").
  "faction:<name>" — any on-stage NPC of that faction (lowercase, spaces collapsed; e.g. "faction:ironspire knights").
  "player" — the player character (use for the player's own secrets; NOT an NPC id).
- For rules_lore and locations categories: OMIT knownBy (broadcast / common knowledge — everyone can know).
- For npc_events, promises_debts, party_facts, world_state, and misc (sensitive/personal facts):
  DEFAULT = the witnesses of the fact's source scene (use the AUDIT — PER-SCENE NPC WITNESSES list;
  emit each witness as "npc:<id>"). Seed from witnesses; you MAY widen (add NPCs told later,
  a faction that learned of it) or narrow (drop an NPC who only overheard unrelated chatter).
  Broadcasting (omitting knownBy) is allowed ONLY when the fact is explicitly public in-fiction
  (announced publicly, observed by a crowd, common gossip) — when in doubt, scope to witnesses.
- Prefer OVER-RESTRICTION for sensitive/personal facts (a quiet NPC who "should know via gossip"
  not acting on it is a minor missed beat; the player's secret leaking is a major spoiler). Prefer
  broadcast for world/rules. Asymmetry is intentional.
- Empty array "knownBy": [] means SECRET — no NPC knows it (only the player / GM as narrator).
  Use sparingly; usually "player" is the right token for player-only secrets.`;

/**
 * subjectToken rules — injected into the seal prompt with the campaign's existing
 * tokens so the LLM reuses them for facts about the same subject. WO2.
 */
export function buildSubjectTokenRules(existingTokens: string[] | undefined): string {
    const list = existingTokens && existingTokens.length > 0
        ? existingTokens.join(', ')
        : '(none yet — invent fresh tokens for new subjects)';
    return `SUBJECT TOKEN RULES:
- subjectToken: a stable snake_case slug for WHAT this fact is ABOUT, used to group facts about the
  same subject across time. The scene number is the version axis — do NOT number tokens
  (use "alex.identity", never "alex.identity2").
- REUSE an existing token from the list below if this fact is about the same subject as one already
  tokened. Existing tokens this campaign: ${list}
- Form: lowercase, dot-or-underscore separated, no spaces. Examples: alex_chen.identity,
  count.debt, ruby_of_doom.location, world.weather.
- If unsure, emit your best single slug; the system normalizes it. Missing/empty is acceptable but
  avoid it when a clear subject exists.`;
}

/** Pulled from saveFileEngine.ts NPC INNER STATE RULES. */
export const NPC_INNER_STATE_RULES = `NPC INNER STATE RULES:
- "npcInnerState" captures an NPC's beliefs, posture, and attitude AFTER this chapter's events — NOT a list of events ("X happened").
- Write what is true about the NPC's inner world now: what they believe, how they regard other characters, what has shifted in them.
- 1-2 sentences max per NPC. Aim for texture and specificity, not plot recaps.
- Include ONLY NPCs whose inner state meaningfully shifted during this chapter. Omit NPCs with no arc movement.
- Example: "Helena Broadmarsh": "Pale, processing the violation of natural order; trusts Grey absolutely but now fears him."
- If no NPC inner state shifted meaningfully, output "npcInnerState": {}.`;

/** Pulled from saveFileEngine.ts SCENE EVENT RULES. */
export const SCENE_EVENT_RULES = `SCENE EVENT RULES:
- eventType MUST be one of: ${EVENT_TYPES_LIST}
- importance is 1-10 (same scale as chapter importance)
- text is one short sentence describing what happened
- characters/locations/items/concepts are optional arrays of canonical names (use NPC names from the ledger above when possible)
- cause/result are short plain-text causal beats (one short clause each, optional)
- Cap at MAXIMUM 3 events per scene. Skip scenes with nothing meaningful (use [] or omit the scene key).
- Only include scenes from this chapter's scene IDs.`;

/** Pulled from npcGeneration.ts APPEARANCE UPDATE RULES. */
export const APPEARANCE_UPDATE_RULES = `APPEARANCE UPDATE RULES:
- "appearance" should only be updated if the prose explicitly describes a CHANGE to the NPC's physical state (e.g., they received a new scar, changed clothing, aged). Do NOT update appearance just because the AI re-describes them — preserve the original canonical description.
- If appearance is currently blank or "[inferred]" and the new prose provides concrete details, update it with those grounded details.`;

/** Pulled from npcGeneration.ts DRIVES UPDATE RULES. */
export const DRIVES_UPDATE_RULES = `DRIVES UPDATE RULES:
- "drives" is an object with "coreWant", "sessionWant", and "sceneWant".
- "coreWant" is a deep character truth — almost never changes. Only update if a transformative event reshapes who this NPC is.
- "sessionWant" is their arc-level objective — update if the story has clearly moved to a new arc or their long-term situation shifted.
- "sceneWant" is their immediate scene-level goal — this changes OFTEN. Update whenever the scene context, NPC's situation, or conversation direction has shifted. Always include a new sceneWant if the old one is clearly resolved or irrelevant.
- If the NPC has "Drives: NOT YET POPULATED", you MUST provide ALL THREE drive fields (coreWant, sessionWant, sceneWant) plus at least one behavioralTrigger, one hardBoundary, and one softBoundary.
- Only include the "drives" field if at least one sub-field changed or needs to be populated.`;

// ─────────────────────────────────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────────────────────────────────

/**
 * Joins prompt sections with a blank line between them, skipping any
 * empty / null / undefined entries. Keeps callsites readable.
 */
export function joinPromptSections(...sections: Array<string | null | undefined>): string {
    return sections
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .map(s => s.trim())
        .join('\n\n');
}
