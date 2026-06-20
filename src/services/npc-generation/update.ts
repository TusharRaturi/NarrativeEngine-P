import type { EndpointConfig, ProviderConfig, ChatMessage, NPCEntry, PersonalityHex, HexAxis, RelationGraph } from '../../types';
import type { OpenAIMessage } from '../llm/llmService';
import { sendMessageAndParseJson } from './shared';
import { relationBand, describeHex } from '../npc/agency/agencyBands';
import { hexDelta } from '../npc/agency/agencyDrift';
import { PC_RELATION_MIN, PC_RELATION_MAX, PC_RELATION_MAX_STEP } from '../npc/agency/agencyConstants';

// Mirrors the private descriptor in mobile npcGeneration.ts. Used only for read-only legacy
// display in the LLM context block (so the model understands pre-migration NPCs without us
// ever asking it to write a raw 0-100 affinity number).
function legacyAffinityDescriptor(v: number): string {
    if (v <= 15) return 'Nemesis';
    if (v <= 30) return 'Distrustful';
    if (v <= 45) return 'Wary';
    if (v <= 55) return 'Neutral';
    if (v <= 70) return 'Warm';
    if (v <= 85) return 'Trusted';
    return 'Devoted';
}

const HEX_AXES: readonly HexAxis[] = ['drive', 'diligence', 'boldness', 'warmth', 'empathy', 'composure'];

/**
 * Background auto-update for existing NPCs that were mentioned in the chat.
 * Phase-4 schema: the LLM is shown the new fields (wants / personalityHex / pcRelation / traits /
 * region / relations) and may propose DRIFTS for them. Legacy `drives` and raw `affinity` are
 * read-only — they are shown to the model only so pre-migration NPCs make sense, but never written.
 *
 * Delta-only fields (pcRelation, personalityHex) are clamped on parse: a "+5" still moves +1.
 * `relations` is a sparse shallow-merge, never a wholesale replace. `wants.short` is engine-only
 * and always preserved.
 */
export async function updateExistingNPCs(
    provider: EndpointConfig | ProviderConfig,
    history: ChatMessage[],
    npcsToCheck: NPCEntry[],
    updateNPCStore: (id: string, updates: Partial<NPCEntry>) => void
) {
    if (!npcsToCheck.length) return;

    console.log(`[NPC Updater] Checking for attribute shifts on ${npcsToCheck.length} existing NPC(s)...`);

    const recentContext = history.slice(-5).map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');

    const npcDatas = npcsToCheck.map(npc => {
        // WO-05 §A — send the Phase-4 truth, NOT legacy. No raw 0–100 affinity; no drives.
        const pcRelationBand = npc.pcRelation !== undefined
            ? `${relationBand(npc.pcRelation)} (${npc.pcRelation >= 0 ? '+' : ''}${npc.pcRelation})`
            : (npc.affinity !== undefined ? `${legacyAffinityDescriptor(npc.affinity)} (${npc.affinity}/100 legacy)` : 'Neutral (0)');

        let data = `[NPC: ${npc.name}]\n` +
            `Status: ${npc.status || 'Alive'}\n` +
            `Appearance: ${npc.appearance || 'Unknown'}\n` +
            `Disposition: ${npc.disposition || 'Unknown'}\n` +
            `Goals: ${npc.goals || 'Unknown'}\n` +
            `Feeling toward PC: ${pcRelationBand}\n` +
            `Personality: ${npc.personality || npc.disposition || 'Unknown'}\n` +
            `Voice: ${npc.voice || 'not defined'}\n` +
            `Faction: ${npc.faction || 'Unknown'}\n` +
            `Story Relevance: ${npc.storyRelevance || 'Unknown'}\n`;

        // WO-05 §A — wants (Phase-4 source of truth), NOT drives. Send medium/long only; `short`
        // is no-LLM and is preserved on the parse side. Legacy drives are read-only fallback.
        if (npc.wants && (npc.wants.long || npc.wants.medium?.length)) {
            data += `LongWant: ${npc.wants.long || 'Unknown'}\n` +
                `MediumWants: ${npc.wants.medium?.join(' | ') || 'none'}\n`;
        }

        if (npc.personalityHex) {
            data += `PersonalityHex: ${describeHex(npc.personalityHex)}\n`;
        }

        if (npc.traits && npc.traits.length > 0) {
            data += `Traits: ${npc.traits.join(', ')}\n`;
        }

        if (npc.region) {
            data += `Region: ${npc.region}\n`;
        }

        if (npc.behavioralTriggers && npc.behavioralTriggers.length > 0) {
            data += `Triggers: ${npc.behavioralTriggers.map(t => `"${t.keyword}" → ${t.shift}`).join('; ')}\n`;
        }

        // Visual profile fill (unchanged from legacy behaviour).
        const vp = npc.visualProfile || { race: '', gender: '', ageRange: '', build: '', symmetry: '', hairStyle: '', eyeColor: '', skinTone: '', gait: '', distinctMarks: '', clothing: '' };
        const missingFields = Object.entries(vp)
            .filter(([key, val]) => key !== 'artStyle' && (!val || val === 'Unknown' || val === 'None'))
            .map(([key]) => key);
        if (missingFields.length > 0) {
            data += `NOTE: This NPC has missing or generic "visualProfile" fields: ${missingFields.join(', ')}. You MUST attempt to determine specific values for these based on their "Appearance" and recent context.\n`;
        }

        return data;
    }).join('\n\n');

    const prompt = `You are a background game state analyzer. Your job is to read the RECENT CONTEXT of an RPG session and determine if any of the provided NPCs have undergone a shift in their status, personality, goals, disposition, faction, or relevance.

OUTPUT FORMAT — a single JSON object:

If NO changes occurred for ANY of these NPCs, respond EXACTLY with:
{"updates": []}

If ANY changes occurred, respond with:
{"updates": [{"name": "<NPC name>", "changes": { ...only the fields that changed... }}]}

Each update MUST include "name" and only the fields that fundamentally changed. Allowed changes keys:
  status, disposition, goals, storyRelevance, personality (flavor text), voice, appearance,
  wants (medium/long text only — NEVER include "short"; short is engine-managed),
  pcRelation, personalityHex, traits, region, faction, relations, behavioralTriggers, hardBoundaries, softBoundaries, visualProfile.
DO NOT include attributes that stayed the same.

**FORBIDDEN keys** (Phase-4 schema; sending these is a data-model error):
  - "drives" — superseded by "wants". Never send drives.
  - "affinity" — superseded by "pcRelation". Never send a 0–100 affinity number.

PERSONALITY HEX DRIFT (the headline):
  - "personalityHex" is a DELTA MAP, not a full overwrite. Send ONLY the axes that drifted, as
    small integers: e.g. {"personalityHex": {"boldness": +1, "composure": -1}}.
  - Each axis delta is clamped to ±1 by the engine; a "+5" still moves only +1. Drift is rare and
    small — only send a hex delta when the scene contains a genuinely transformative event.
  - NEVER re-emit the full 6-axis hexagon. NEVER send absolute axis values as if setting them.

PC RELATION DRIFT:
  - "pcRelation" is a DELTA: +1, -1, or 0. The engine clamps the result to −3..+3 and rejects any
    larger step. Send +1 when the player gained favor, -1 when they lost it. Skip if unchanged.
  - NEVER send a 0–100 "affinity" number. The legacy field is read-only.

WANTS UPDATE RULES:
  - "wants" is an object with "short" (string[]), "medium" (string[]), and "long" (string).
  - You may ONLY revise "medium" and "long". NEVER include "short" — it is engine-managed and
    always preserved. If you include "short", it will be discarded.
  - "long" is a single overarching life goal — update only if a transformative event reshaped it.
  - "medium" is arc-level goal templates — update if the story moved to a new arc.
  - If the NPC has no "wants" yet, you MUST provide "medium" and "long".

RELATIONS:
  - "relations" is a sparse NPC→NPC edge map (target NPC id → -3..+3). Shallow-merge only;
    never wholesale replace. Add or adjust specific edges that shifted this scene.

GENERAL RULES:
- Valid statuses: Alive, Deceased, Missing, Unknown.
- Do NOT change personality or voice unless the scene contains a genuinely transformative event for this character.
- "affinity" is a 0-100 scale of how much they like the player (0=Nemesis, 50=Neutral, 100=Ally). DO NOT send "affinity" — use "pcRelation" (+1/-1 delta) instead.

EXAMPLES:

GOOD — NPC who died with a transformative emotional arc:
{"updates": [{"name": "Captain Vorin", "changes": {"status": "Deceased", "personality": "consumed by rage in final moments, betrayed and broken", "storyRelevance": "His death sparked a rebellion"}}]}

GOOD — NPC whose mid/long-term ambition shifted after a major scene (only revise "wants" medium/long; NEVER include "short"):
{"updates": [{"name": "Kael", "changes": {"wants": {"long": "seize the Ironwall garrison and rule the pass himself", "medium": ["turn the captain's lieutenants against her", "stockpile blackpowder"]}}}]}

GOOD — NPC who grew bolder after a crit-success on a bold goal (hex DRIFT, delta-only; pcRelation delta):
{"updates": [{"name": "Alden", "changes": {"personalityHex": {"boldness": +1}, "pcRelation": +1}}]}

GOOD — NPC who lost composure after sustained failure (hex DRIFT, delta-only):
{"updates": [{"name": "Senna", "changes": {"personalityHex": {"composure": -1}}}]}

BAD — re-emitting unchanged attributes (status/personality/voice/appearance all unchanged here):
{"updates": [{"name": "Senna", "changes": {"status": "Alive", "personality": "warm and curious", "voice": "soft alto", "appearance": "tall, dark hair"}}]}
Corrected: include ONLY the field that changed —
{"updates": [{"name": "Senna", "changes": {"personality": "warm but watchful after the ambush"}}]}

BAD — sending a FORBIDDEN legacy key (drives/affinity):
{"updates": [{"name": "Senna", "changes": {"drives": {"sceneWant": "investigate the tracks at dawn"}, "affinity": 65}}]}
Corrected — use the Phase-4 fields (wants medium/long; pcRelation delta):
{"updates": [{"name": "Senna", "changes": {"wants": {"medium": ["investigate the tracks at dawn"]}, "pcRelation": +1}}]}

BAD — re-emitting the full hexagon as absolute values (this is a full-overwrite attempt; the engine will clamp it to ±1 anyway, but it signals a misunderstanding):
{"updates": [{"name": "Alden", "changes": {"personalityHex": {"drive": 2, "diligence": 1, "boldness": 3, "warmth": 0, "empathy": 1, "composure": 2}}]}
Corrected — send ONLY the axis that drifted, as a small delta:
{"updates": [{"name": "Alden", "changes": {"personalityHex": {"boldness": +1}}}]}

[RECENT CONTEXT]
${recentContext}
[END CONTEXT]

[CURRENT NPC STATES]
${npcDatas}
[END STATES]

RESPOND ONLY WITH VALID JSON.`;

    const messages: OpenAIMessage[] = [{
        role: 'user',
        content: prompt,
    }];

    try {
        const { parsed } = await sendMessageAndParseJson(provider, messages, 'NPC Updater');

        if (parsed.updates && Array.isArray(parsed.updates)) {
            for (const update of parsed.updates) {
                if (!update.name || !update.changes) continue;

                const targetNpc = npcsToCheck.find(n =>
                    n.name.toLowerCase() === update.name.toLowerCase() ||
                    (n.aliases && n.aliases.toLowerCase().includes(update.name.toLowerCase()))
                );

                if (targetNpc) {
                    const changes = { ...update.changes } as Partial<NPCEntry>;

                    // WO-05 §B — defensively strip the FORBIDDEN legacy keys. The prompt forbids them,
                    // but the parse must never write a superseded field as truth.
                    delete (changes as Partial<NPCEntry>).drives;
                    delete (changes as Partial<NPCEntry>).affinity;

                    // WO-05 §C — capture the pre-change state into `previousSnapshot` so a SHIFT
                    // word-band can be surfaced on the next payload read.
                    const hasPersonalityChange = changes.personality !== undefined || changes.voice !== undefined;
                    const hasHexChange = changes.personalityHex !== undefined;
                    const hasPcRelationChange = changes.pcRelation !== undefined;
                    const hasRungChange = changes.skillRung !== undefined;
                    if (hasPersonalityChange || hasHexChange || hasPcRelationChange || hasRungChange) {
                        changes.previousSnapshot = {
                            personality: targetNpc.personality || targetNpc.disposition || '',
                            voice: targetNpc.voice || '',
                            affinity: targetNpc.affinity,
                            personalityHex: targetNpc.personalityHex,
                            pcRelation: targetNpc.pcRelation,
                            skillRung: targetNpc.skillRung,
                        };
                        changes.shiftTurnCount = 0;
                    } else if (targetNpc.shiftTurnCount !== undefined && targetNpc.shiftTurnCount < 3) {
                        changes.shiftTurnCount = (targetNpc.shiftTurnCount || 0) + 1;
                    }

                    if (changes.visualProfile && typeof changes.visualProfile === 'object') {
                        changes.visualProfile = {
                            ...targetNpc.visualProfile,
                            ...changes.visualProfile,
                            artStyle: targetNpc.visualProfile?.artStyle || 'Anime'
                        };
                    }

                    // WO-05 §A — pcRelation DELTA. Accept +1/-1 (or an absolute target the engine
                    // clamps). Step is clamped to ±PC_RELATION_MAX_STEP; result to [MIN, MAX]. Only
                    // apply when the NPC already has a pcRelation baseline.
                    if (changes.pcRelation !== undefined && typeof changes.pcRelation === 'number'
                        && Number.isFinite(changes.pcRelation) && targetNpc.pcRelation !== undefined) {
                        const current = targetNpc.pcRelation;
                        const step = Math.max(-PC_RELATION_MAX_STEP, Math.min(PC_RELATION_MAX_STEP, Math.round(changes.pcRelation)));
                        const next = Math.max(PC_RELATION_MIN, Math.min(PC_RELATION_MAX, current + step));
                        changes.pcRelation = next;
                    } else {
                        delete (changes as Partial<NPCEntry>).pcRelation;
                    }

                    // WO-05 §A — personalityHex DELTA-ONLY. Each axis value is treated as a delta and
                    // applied via `hexDelta`, which clamps the step to ±HEX_DRIFT_MAX_STEP and the
                    // result to −3..+3. A full-overwrite attempt ("5" on every axis) is neutralized.
                    if (changes.personalityHex !== undefined && changes.personalityHex !== null
                        && typeof changes.personalityHex === 'object' && targetNpc.personalityHex) {
                        const incoming = changes.personalityHex as Record<HexAxis, number>;
                        let merged: PersonalityHex = { ...targetNpc.personalityHex };
                        for (const axis of HEX_AXES) {
                            if (incoming[axis] !== undefined && typeof incoming[axis] === 'number' && Number.isFinite(incoming[axis])) {
                                merged = hexDelta(merged, axis, incoming[axis]);
                            }
                        }
                        changes.personalityHex = merged;
                    } else {
                        delete (changes as Partial<NPCEntry>).personalityHex;
                    }

                    // WO-05 §B — relations: sparse edge add/update, shallow-merge into existing.
                    if (changes.relations !== undefined && changes.relations !== null
                        && typeof changes.relations === 'object') {
                        const existing = targetNpc.relations ?? {};
                        const incoming = changes.relations as RelationGraph;
                        changes.relations = { ...existing, ...incoming };
                    }

                    // Wants — the model may revise medium/long ambition text only. `short` is
                    // no-LLM and is always preserved.
                    if (changes.wants && typeof changes.wants === 'object') {
                        const existingWants = targetNpc.wants || { short: [], medium: [], long: '' };
                        const incoming = changes.wants as Partial<NPCEntry['wants']>;
                        changes.wants = {
                            short: existingWants.short,
                            medium: Array.isArray(incoming?.medium)
                                ? incoming!.medium.map(String).filter(Boolean)
                                : existingWants.medium,
                            long: (typeof incoming?.long === 'string' && incoming.long.trim())
                                ? incoming.long.trim()
                                : existingWants.long,
                        };
                    }

                    if (Array.isArray(changes.behavioralTriggers)) {
                        changes.behavioralTriggers = changes.behavioralTriggers
                            .filter((t: Record<string, unknown>) => t.keyword && t.shift)
                            .map((t: Record<string, unknown>) => ({ keyword: String(t.keyword), shift: String(t.shift) }));
                    }

                    if (Array.isArray(changes.hardBoundaries)) {
                        changes.hardBoundaries = changes.hardBoundaries.map(String).filter(Boolean);
                    }

                    if (Array.isArray(changes.softBoundaries)) {
                        changes.softBoundaries = changes.softBoundaries.map(String).filter(Boolean);
                    }

                    updateNPCStore(targetNpc.id, changes);
                    console.log(`[NPC Updater] Applied changes to ${targetNpc.name}:`, changes);
                }
            }
        } else {
            console.log(`[NPC Updater] No updates required.`);
        }
    } catch (err) {
        console.error('[NPC Updater] Failed to parse generated JSON or fatal error:', err);
    }
}