import type { EndpointConfig, ProviderConfig, ChatMessage, NPCEntry } from '../../types';
import type { OpenAIMessage } from '../llmService';
import { uid } from '../../utils/uid';
import { sendMessageAndParseJson } from './shared';

export async function generateNPCProfile(
    provider: EndpointConfig | ProviderConfig,
    history: ChatMessage[],
    npcName: string,
    addNPCToStore: (npc: NPCEntry) => void
): Promise<void> {
    console.log(`[NPC Generator] Initiating background profile generation for: ${npcName}`);

    const recentHistory = history.slice(-15).map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');

    const systemPrompt = `You are a background GM assistant running silently.
The game mentioned a new character named "${npcName}".
Your job is to generate a profile for this character based on the recent chat history.
If the character is barely mentioned, invent a plausible, tropes-appropriate profile that fits the current scene context.

RESPOND ONLY WITH VALID JSON. NO MARKDOWN FORMATTING. NO EXPLANATIONS.
The JSON must perfectly match this structure:
{
  "name": "String (The primary name)",
  "aliases": "String (Comma separated aliases or titles)",
  "status": "String (Alive, Deceased, Missing, or Unknown)",
  "faction": "String (The faction, group, or origin this NPC belongs to)",
  "storyRelevance": "String (Why this NPC matters to the current story)",
  "visualProfile": {
    "race": "String (e.g. Human, Elf)",
    "gender": "String",
    "ageRange": "String",
    "build": "String",
    "symmetry": "String (e.g. symmetrical features for handsome, rugged, asymmetrical/pockmarked for ugly)",
    "hairStyle": "String",
    "eyeColor": "String",
    "skinTone": "String",
    "gait": "String",
    "distinctMarks": "String",
    "clothing": "String"
  },
  "disposition": "String (current mood/attitude: Helpful, Hostile, Suspicious, etc)",
  "goals": "String (Core motive)",
  "voice": "String — describe HOW this NPC speaks: sentence length, vocabulary level, verbal quirks, catchphrases, accent notes. Be specific.",
  "personality": "String — core personality traits in plain language. What drives them? How do they treat others? What do they fear?",
  "exampleOutput": "String — one line of in-character dialogue that demonstrates their voice and personality. Include a brief action in brackets if needed.",
  "drives": {
    "coreWant": "String — one sentence: a deep character truth this NPC carries (NOT a goal). Example: 'to be seen as capable, not just loyal'",
    "sessionWant": "String — one sentence: what this NPC is working toward in the current arc. Example: 'convince the party to take the northern route'",
    "sceneWant": "String — one sentence: what this NPC wants from the immediate scene. Example: 'get the player to trust her enough to share information'"
  },
  "behavioralTriggers": [
    { "keyword": "String — a word or phrase that, when it appears in player input or narrative, activates this trigger", "shift": "String — a PHYSICAL or VERBAL behavioral shift (NOT an emotion). Good: 'crosses arms, answers in single syllables'. Bad: 'becomes angry'." }
  ],
  "hardBoundaries": ["String — something this NPC will never do. Example: 'will not betray her sister'"],
  "softBoundaries": ["String — something this NPC dislikes but may tolerate under pressure. Example: 'dislikes being excluded from plans'"]
}`;

    const messages: OpenAIMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `RECENT CHAT HISTORY:\n${recentHistory}\n\nGenerate the JSON profile for "${npcName}".` }
    ];

    try {
        const { parsed } = await sendMessageAndParseJson(provider, messages, 'NPC Generator');

        const newEntry: NPCEntry = {
            id: uid(),
            name: parsed.name || npcName,
            aliases: parsed.aliases || '',
            status: parsed.status || 'Alive',
            faction: parsed.faction || 'Unknown',
            storyRelevance: parsed.storyRelevance || 'Unknown',
            appearance: '',
            visualProfile: parsed.visualProfile || {
                race: 'Unknown', gender: 'Unknown', ageRange: 'Unknown', build: 'Unknown', symmetry: 'Unknown', hairStyle: 'Unknown', eyeColor: 'Unknown', skinTone: 'Unknown', gait: 'Unknown', distinctMarks: 'None', clothing: 'Unknown', artStyle: 'Anime'
            },
            disposition: parsed.disposition || 'Neutral',
            goals: parsed.goals || 'Unknown',
            voice: parsed.voice || '',
            personality: parsed.personality || parsed.disposition || 'Unknown',
            exampleOutput: parsed.exampleOutput || '',
            affinity: 50,
            drives: parsed.drives ? {
                coreWant: parsed.drives.coreWant || '',
                sessionWant: parsed.drives.sessionWant || '',
                sceneWant: parsed.drives.sceneWant || '',
            } : undefined,
            behavioralTriggers: Array.isArray(parsed.behavioralTriggers)
                ? parsed.behavioralTriggers.filter((t: Record<string, unknown>) => t.keyword && t.shift).map((t: Record<string, unknown>) => ({ keyword: String(t.keyword), shift: String(t.shift) }))
                : undefined,
            hardBoundaries: Array.isArray(parsed.hardBoundaries)
                ? parsed.hardBoundaries.map(String).filter(Boolean)
                : undefined,
            softBoundaries: Array.isArray(parsed.softBoundaries)
                ? parsed.softBoundaries.map(String).filter(Boolean)
                : undefined,
        };

        addNPCToStore(newEntry);
        console.log(`[NPC Generator] Successfully generated and added profile for: ${newEntry.name}`);

    } catch (err) {
        console.error('[NPC Generator] Failed to generate NPC profile:', err);
    }
}
