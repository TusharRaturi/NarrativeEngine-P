import type { AppSettings, GameContext, LoreChunk } from '../../types';
import { countTokens } from '../infrastructure/tokenizer';
import { DEFAULT_RULES } from '../rules/defaultRules';
import type { TraceCollector } from './traceCollector';

// Reasoning/thinking-model detector (DeepSeek-R1, Qwen QwQ, etc.). Resolves the
// active preset's storyAI slot — first via the two-tier `storyAIProviderId`
// provider lookup, then falls back to the legacy inline `activePreset.storyAI.modelName`.
// Exported so payloadBuilder.ts can gate the per-turn CoT invocation line on the
// same test without re-implementing the resolution chain.
export function isReasoningModel(settings: AppSettings): boolean {
    const activePreset = settings.presets?.find((p) => p.id === settings.activePresetId);
    const storyProviderId: string | undefined = activePreset?.storyAIProviderId;
    const storyProvider = storyProviderId ? settings.providers?.find((p) => p.id === storyProviderId) : undefined;
    const modelName = storyProvider?.modelName ?? activePreset?.storyAI?.modelName ?? '';
    return /deepseek-r|qwq|qwen.*think|r1/i.test(modelName);
}

// [FABLE-AUTHORED] — verbatim. Block labels verified against world.ts / volatile.ts:
//   [ACTIVE NPC CONTEXT] (world.ts:387), [FACTS KNOWN TO ON-STAGE CHARACTERS] (world.ts:439),
//   [DICE OUTCOMES: ...] (engineRolls.ts:194 — emitted as a user-message prefix, stripped by history.ts),
//   [LOCATION] (volatile.ts:189). [DIRECTOR BRIEF] does not exist yet — left verbatim per spec
//   (Director Brief service lands in WO-04); the conditional "if present" wording keeps it forward-compatible.
const WRITER_COT = `[WRITER REASONING FRAMEWORK]
Work through these steps inside your thinking block before writing. Never show the steps in the narrative output. Always produce the full narrative response after the thinking block ends.
Step 1 — Deconstruct: break the player's input into discrete intents. Judge each against the rules and MC boundaries. Impossible or implausible demands are narrated as attempts with consequences, not successes.
Step 2 — Director Brief: if a [DIRECTOR BRIEF] block is present, list its directives, mark each MANDATORY or SUGGESTION as tagged, and plan where each lands in the scene.
Step 3 — On-stage minds: for each character in [ACTIVE NPC CONTEXT]: current emotional state; what they know and do not know (check [FACTS KNOWN TO ON-STAGE CHARACTERS]); which reaction from their reaction menu fits; whether the player's action crosses their boundaries. A crossed boundary produces push-back, not accommodation.
Step 4 — Engine truth: honor [DICE OUTCOMES] exactly as resolved — never soften failures or upgrade successes. Check each on-stage character against their signature kit. Check [LOCATION] logistics: travel time, weather, era-appropriate technology.
Step 5 — Beat map: draft 5-8 beats. Include every MANDATORY directive from Step 2 and every required reaction from Step 3. End on a hook or a question the world poses — not a summary.
Step 6 — Final audit: the player's action drives the scene; at least one NPC acts on their own agenda rather than reacting; no clichés or purple prose. Then write the scene.`;

export function buildStable(opts: {
    settings: AppSettings;
    context: GameContext;
    relevantRules?: LoreChunk[];
    rulesManifest?: string;
    rulesBudget: number;
    budgetStable: number;
    collector: TraceCollector;
}): { stableContent: string; stableTokens: number; retrievedRulesContent?: string } {
    const { settings, context, relevantRules, rulesManifest, rulesBudget, budgetStable, collector } = opts;

    const stableParts: string[] = [];
    let retrievedRulesContent: string | undefined;

    // Inject either selected Rules RAG chunks or complete raw rules.
    // RAG-retrieved rules are DYNAMIC (re-selected per turn by semantic match to user input),
    // so they MUST ride in the volatile block below the cache boundary — putting them in
    // stable busts the prefix cache every turn. Only the verbatim full-rules fallback is
    // stable (it's byte-identical across turns). Mirrors mobileApp payloadStableContent.ts.
    //
    // The user's custom Action Resolution rules are NEVER overwritten — die-type guidance
    // lives in the roll_dice tool description (toolHandlers.ts). This fixes the issue where
    // enabling the dice tool silently nuked non-d20 campaign rules.
    const effectiveRules = context.rulesRaw || DEFAULT_RULES;

    const hasRulesRAG = (context.rulesChunks?.length ?? 0) > 0;
    if (hasRulesRAG && relevantRules && relevantRules.length > 0) {
        let rulesTokens = 0;
        const acceptedChunks: LoreChunk[] = [];
        for (const chunk of relevantRules) {
            if (rulesTokens + chunk.tokens <= rulesBudget) {
                acceptedChunks.push(chunk);
                rulesTokens += chunk.tokens;
            }
        }
        const chunksText = acceptedChunks.map(c => `### ${c.header}\n${c.content}`).join('\n\n');
        let ragText = `## RULES\n\n${chunksText}`;
        if (rulesManifest) {
            ragText += `\n\n${rulesManifest}`;
        }
        retrievedRulesContent = ragText;
        collector.addTrace({ source: 'RAG Rules', classification: 'volatile_state', tokens: rulesTokens, reason: `RAG injected (${acceptedChunks.length} chunks) — volatile (per-turn selection)`, included: true, position: 'system_dynamic' });
    } else {
        const rulesText = effectiveRules;
        stableParts.push(rulesText);
        collector.addTrace({ source: 'Raw Rules', classification: 'stable_truth', tokens: countTokens(rulesText), reason: 'Complete rules list (RAG not loaded or below threshold)', included: true, position: 'system_static' });
    }

    if (context.canonStateActive && context.canonState) {
        stableParts.push(context.canonState);
    }
    if (context.headerIndexActive && context.headerIndex) stableParts.push(context.headerIndex);
    if (context.starterActive && context.starter) stableParts.push(context.starter);
    if (context.continuePromptActive && context.continuePrompt) stableParts.push(context.continuePrompt);

    // Only inject if using a known reasoning/thinking model (DeepSeek-R1, Qwen QwQ, etc.)
    if (isReasoningModel(settings)) {
        stableParts.push("IMPORTANT: If you use a 'thinking' or 'reasoning' block (<think>...</think>), you MUST still provide the full narrative response AFTER the closing tag. Never end a turn with only a thinking block.");
        stableParts.push(WRITER_COT);
    }

    const stableContent = stableParts.join('\n\n');
    const stableTokens = countTokens(stableContent);
    // Stable holds essential, non-droppable campaign state (rules already capped by rulesBudget; canon,
    // header, starter cause amnesia if silently truncated mid-turn). Rather than drop it, surface a
    // budget-overrun warning in the trace so an oversized preamble is visible in debug mode.
    if (budgetStable > 0 && stableTokens > budgetStable) {
        collector.addTrace({ source: 'Stable Preamble', classification: 'stable_truth', tokens: stableTokens, reason: `Over stable budget (${stableTokens} t > ${budgetStable} t) — kept (essential state, not trimmable)`, included: true, position: 'system_static', preview: stableContent });
    }
    collector.addTrace({ source: 'Stable Preamble', classification: 'stable_truth', tokens: stableTokens, reason: 'Preamble & Core state', included: true, position: 'system_static', preview: stableContent });
    collector.addSection({ label: 'Stable Preamble', role: 'system', tokens: stableTokens, content: stableContent, classification: 'stable_truth' });

    return { stableContent, stableTokens, retrievedRulesContent };
}
