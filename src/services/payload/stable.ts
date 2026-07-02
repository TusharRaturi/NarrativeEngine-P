import type { AppSettings, GameContext, LoreChunk } from '../../types';
import { countTokens } from '../infrastructure/tokenizer';
import { DEFAULT_RULES } from '../rules/defaultRules';
import type { TraceCollector } from './traceCollector';

const TOOL_MODE_ACTION_RESOLUTION = `### ACTION RESOLUTION

Trigger: Player attempts an action with an uncertain outcome — combat hits, skill checks, saves, contested actions.

1. Identify core intent of the player's action.
2. If the outcome depends on chance, CALL the \`roll_dice\` tool BEFORE narrating. Do NOT narrate the outcome first.
   - \`dice\`: typically \`1d20\` for skill checks/attacks; use \`NdM\` form for damage or special rolls
   - \`reason\`: short label (e.g. "Stealth check vs guard", "Longsword attack")
   - \`category\`: one of Combat / Stealth / Social / Perception / Movement / Knowledge / Mundane (for d20 only)
3. Use the returned \`tier\` (Catastrophe / Failure / Success / Triumph / Narrative Boon) to shape the narrative — same outcome semantics as pool mode.
4. Do NOT call \`roll_dice\` for descriptive moments, dialogue, or trivial actions. Mundane actions resolve as plain success without a roll.

**Advantage selection (tool mode):** if the player explicitly leverages a known weakness or superior tool, call \`roll_dice\` twice and use the higher result. If explicitly impaired (blinded, wounded, overwhelmed), call twice and use the lower. Otherwise, single roll.

**Outcomes:**
- Catastrophe: severe unexpected failure, consequences beyond simple loss.
- Failure: fails. Damage, setback, or resource loss.
- Success: succeeds exactly as intended.
- Triumph: succeeds with an unexpected additional benefit.
- Narrative Boon: flawless. Massive strategic or narrative advantage.`;

function swapActionResolutionForToolMode(rules: string): string {
    const marker = '### Action Resolution';
    const idx = rules.indexOf(marker);
    if (idx === -1) return rules;
    const nextSectionMatch = rules.substring(idx + marker.length).match(/\n### /);
    const endIdx = nextSectionMatch ? idx + marker.length + nextSectionMatch.index! : rules.length;
    return rules.substring(0, idx) + TOOL_MODE_ACTION_RESOLUTION + rules.substring(endIdx);
}

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
    const effectiveRules = context.rulesRaw || DEFAULT_RULES;
    const rulesWithMode = context.diceFairnessActive === false
        ? swapActionResolutionForToolMode(effectiveRules)
        : effectiveRules;

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
        const rulesText = rulesWithMode;
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
    const activePreset: any = (settings as any).presets?.find?.((p: any) => p.id === (settings as any).activePresetId);
    const storyProviderId: string | undefined = activePreset?.storyAIProviderId;
    const storyProvider: any = storyProviderId ? (settings as any).providers?.find?.((p: any) => p.id === storyProviderId) : undefined;
    const modelName = storyProvider?.modelName ?? activePreset?.storyAI?.modelName ?? '';
    const isReasoningModel = /deepseek-r|qwq|qwen.*think|r1/i.test(modelName);
    if (isReasoningModel) {
        stableParts.push("IMPORTANT: If you use a 'thinking' or 'reasoning' block (<think>...</think>), you MUST still provide the full narrative response AFTER the closing tag. Never end a turn with only a thinking block.");
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
