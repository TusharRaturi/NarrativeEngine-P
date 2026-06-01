import type { EndpointConfig, ProviderConfig, ChatMessage, NPCEntry } from '../../types';
import type { OpenAIMessage } from '../llmService';
import { sendMessageAndParseJson } from './shared';

/**
 * Background auto-update for existing NPCs that were mentioned in the chat.
 * Asks the LLM if any relevant attributes have changed based on recent context.
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
        const vp = npc.visualProfile || { race: '', gender: '', ageRange: '', build: '', symmetry: '', hairStyle: '', eyeColor: '', skinTone: '', gait: '', distinctMarks: '', clothing: '' };
        const missingFields = Object.entries(vp)
            .filter(([key, val]) => key !== 'artStyle' && (!val || val === 'Unknown' || val === 'None'))
            .map(([key]) => key);

        let data = `[NPC: ${npc.name}]\n` +
            `Status: ${npc.status || 'Alive'}\n` +
            `Appearance: ${npc.appearance || 'Unknown'}\n` +
            `Disposition: ${npc.disposition || 'Unknown'}\n` +
            `Goals: ${npc.goals || 'Unknown'}\n` +
            `Affinity: ${npc.affinity ?? 50}/100\n` +
            `Personality: ${npc.personality || npc.disposition || 'Unknown'}\n` +
            `Voice: ${npc.voice || 'not defined'}\n` +
            `Faction: ${npc.faction || 'Unknown'}\n` +
            `Story Relevance: ${npc.storyRelevance || 'Unknown'}\n`;

        if (npc.drives) {
            data += `CoreWant: ${npc.drives.coreWant || 'Unknown'}\n` +
                `SessionWant: ${npc.drives.sessionWant || 'Unknown'}\n` +
                `SceneWant: ${npc.drives.sceneWant || 'Unknown'}\n`;
        } else {
            data += `Drives: NOT YET POPULATED\n`;
        }

        if (npc.behavioralTriggers && npc.behavioralTriggers.length > 0) {
            data += `Triggers: ${npc.behavioralTriggers.map(t => `"${t.keyword}" → ${t.shift}`).join('; ')}\n`;
        }

        if (missingFields.length > 0) {
            data += `NOTE: This NPC has missing or generic "visualProfile" fields: ${missingFields.join(', ')}. You MUST attempt to determine specific values for these based on their "Appearance" and recent context.\n`;
        }
        return data;
    }).join('\n\n');

    const prompt = `You are a background game state analyzer. Your job is to read the RECENT CONTEXT of an RPG session and determine if any of the provided NPCs have undergone a shift in their status, personality, goals, disposition, faction, or relevance.

[RECENT CONTEXT]
${recentContext}
[END CONTEXT]

[CURRENT NPC STATES]
${npcDatas}
[END STATES]

If NO changes occurred for ANY of these NPCs, respond EXACTLY with:
{"updates": []}

If ANY changes occurred, respond with a JSON object containing an "updates" array. Each update must include the basic "name" and ANY attributes that have fundamentally changed (status, disposition, goals, personality, voice, affinity, faction, storyRelevance, visualProfile, drives). DO NOT include attributes that stayed the same.
Valid statuses: Alive, Deceased, Missing, Unknown.
Note: "affinity" is a 0-100 scale of how much they like the player (0=Nemesis, 50=Neutral, 100=Ally). Update this if the player did something to gain or lose favor.
Do NOT change personality or voice unless the scene contains a genuinely transformative event for this character.

DRIVES UPDATE RULES:
- "drives" is an object with "coreWant", "sessionWant", and "sceneWant".
- "coreWant" is a deep character truth — almost never changes. Only update if a transformative event reshapes who this NPC is.
- "sessionWant" is their arc-level objective — update if the story has clearly moved to a new arc or their long-term situation shifted.
- "sceneWant" is their immediate scene-level goal — this changes OFTEN. Update whenever the scene context, NPC's situation, or conversation direction has shifted. Always include a new sceneWant if the old one is clearly resolved or irrelevant.
- If the NPC has "Drives: NOT YET POPULATED", you MUST provide ALL THREE drive fields (coreWant, sessionWant, sceneWant) plus at least one behavioralTrigger, one hardBoundary, and one softBoundary.
- Only include the "drives" field if at least one sub-field changed or needs to be populated.

Example of an NPC dying and getting angry:
{"updates": [{"name": "Captain Vorin", "changes": {"status": "Deceased", "personality": "consumed by rage in final moments, betrayed and broken", "storyRelevance": "His death sparked a rebellion"}}]}

Example of an NPC whose scene context shifted:
{"updates": [{"name": "Senna", "changes": {"drives": {"sceneWant": "convince the party to camp here tonight — she spotted tracks earlier and wants to investigate at dawn"}}}]}

Example of a legacy NPC getting drives for the first time:
{"updates": [{"name": "Aldric", "changes": {"drives": {"coreWant": "to prove his family's honor is worth more than their fallen name", "sessionWant": "secure an alliance with the player's group", "sceneWant": "get the player to agree to meet his lord"}, "behavioralTriggers": [{"keyword": "coward", "shift": "jaw tightens, speaks through clenched teeth, changes subject to his military record"}], "hardBoundaries": ["will not abandon a wounded ally"], "softBoundaries": ["resents being reminded of his family's disgrace"]}}]}

RESPOND ONLY WITH VALID JSON.`;

    const messages: OpenAIMessage[] = [{
        role: 'user',
        content: prompt
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
                    const changes = { ...update.changes };

                    const hasPersonalityChange = changes.personality !== undefined || changes.voice !== undefined;
                    const hasAffinityChange = changes.affinity !== undefined;

                    if (hasPersonalityChange || hasAffinityChange) {
                        changes.previousSnapshot = {
                            personality: targetNpc.personality || targetNpc.disposition || '',
                            voice: targetNpc.voice || '',
                            affinity: targetNpc.affinity,
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

                    if (changes.drives && typeof changes.drives === 'object') {
                        const existingDrives = targetNpc.drives || { coreWant: '', sessionWant: '', sceneWant: '' };
                        changes.drives = {
                            coreWant: changes.drives.coreWant || existingDrives.coreWant,
                            sessionWant: changes.drives.sessionWant || existingDrives.sessionWant,
                            sceneWant: changes.drives.sceneWant || existingDrives.sceneWant,
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
