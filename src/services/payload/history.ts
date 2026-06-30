import type { ChatMessage, GameContext } from '../../types';
import type { OpenAIMessage } from '../llm/llmService';
import { countTokens } from '../infrastructure/tokenizer';
import type { TraceCollector } from './traceCollector';

export function buildHistory(opts: {
    history: ChatMessage[];
    condensedUpToIndex?: number;
    userMessage: string;
    limit: number;
    stableTokens: number;
    currentWorldTokens: number;
    volatileTokens: number;
    context: GameContext;
    collector: TraceCollector;
}): OpenAIMessage[] {
    const {
        history,
        condensedUpToIndex,
        userMessage,
        limit,
        stableTokens,
        currentWorldTokens,
        volatileTokens,
        context,
        collector,
    } = opts;

    // --- 6. Fit History ---
    const userTokens = countTokens(userMessage);
    const reservedTotal = stableTokens + currentWorldTokens + volatileTokens + userTokens;
    const historyBudget = Math.max(0, limit - reservedTotal - 200); // Small safety margin of 200 tokens

    const candidateMessages = (condensedUpToIndex !== undefined && condensedUpToIndex >= 0)
        ? history.slice(condensedUpToIndex + 1)
        : history;

    const fitted: OpenAIMessage[] = [];
    const fittedEphemeral: boolean[] = [];
    let historyUsed = 0;
    for (let i = candidateMessages.length - 1; i >= 0; i--) {
        const msg = candidateMessages[i];
        let content = msg.content ?? null;
        if (msg.role === 'user' && typeof content === 'string') {
            content = content.replace(/\n?\[(?:DICE OUTCOMES:|SURPRISE EVENT:|ENCOUNTER EVENT:|WORLD_EVENT:|LOOT DROP:)[^\]]*\]/g, '');
        }
        const textToEstimate = content || JSON.stringify(msg.tool_calls || '') || '';
        const cost = countTokens(textToEstimate);
        if (historyUsed + cost > historyBudget) break;

        const openAIMsg: OpenAIMessage = {
            role: msg.role as 'system' | 'user' | 'assistant' | 'tool',
            content
        };
        if (msg.name) openAIMsg.name = msg.name;
        if (msg.tool_calls) openAIMsg.tool_calls = msg.tool_calls;
        if (msg.tool_call_id) openAIMsg.tool_call_id = msg.tool_call_id;
        if ((msg as any).reasoning_content) openAIMsg.reasoning_content = (msg as any).reasoning_content;

        fitted.unshift(openAIMsg);
        fittedEphemeral.unshift(!!msg.ephemeral);
        historyUsed += cost;
    }

    let lastToolIdx = -1;
    for (let i = fitted.length - 1; i >= 0; i--) {
        if (fitted[i].role === 'tool') { lastToolIdx = i; break; }
    }
    let ephemeralSaved = 0;
    for (let i = 0; i < fitted.length; i++) {
        if (fittedEphemeral[i] && fitted[i].role === 'tool' && i !== lastToolIdx) {
            const oldContent = fitted[i].content;
            fitted[i].content = ' ';
            if (typeof oldContent === 'string') {
                const oldTokens = countTokens(oldContent);
                historyUsed -= oldTokens;
                ephemeralSaved += oldTokens;
            }
        }
    }
    if (ephemeralSaved > 0) {
        collector.addTrace({ source: 'Ephemeral Cleanup', classification: 'summary', tokens: ephemeralSaved, reason: `Reclaimed from stale tool results`, included: false, position: 'history' });
    }

    // Protect orphaned tools
    while (fitted.length > 0 && fitted[0].role === 'tool') fitted.shift();

    collector.addTrace({ source: 'Fitted History', classification: 'summary', tokens: historyUsed, reason: `Included ${fitted.length} msgs within ${historyBudget} budget`, included: true, position: 'history' });
    const historyLines = fitted.map(m => {
        const tag = m.role === 'tool' && m.name ? `[TOOL: ${m.name}]` : `[${m.role.toUpperCase()}]`;
        const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
        return `${tag}\n${body}`;
    }).join('\n\n---\n\n');
    collector.addSection({
        label: `Fitted History (${fitted.length} msgs)`,
        role: 'mixed',
        tokens: historyUsed,
        content: historyLines,
        classification: 'summary',
    });
    collector.addTrace({ source: 'User Message', classification: 'volatile_state', tokens: userTokens, reason: 'Current turn', included: true, position: 'user' });
    collector.addSection({ label: 'User Message', role: 'user', tokens: userTokens, content: userMessage, classification: 'volatile_state' });

    // --- 7. Depth-Based Scene Note Insertion ---
    if (context.sceneNoteActive && context.sceneNote) {
        const noteText = `[SCENE NOTE: VOLATILE GUIDANCE]\n${context.sceneNote}`;
        const noteMsg: OpenAIMessage = { role: 'system', content: noteText };
        const depth = context.sceneNoteDepth ?? 3;

        // Splice into fitted history
        if (fitted.length > 0) {
            const index = Math.max(0, fitted.length - depth);
            fitted.splice(index, 0, noteMsg);
            collector.addTrace({ source: 'Scene Note (Depth)', classification: 'scene_local', tokens: countTokens(noteText), reason: `Injected at depth ${depth}`, included: true, position: `history_at_${depth}` });
            collector.addSection({ label: 'Scene Note', role: 'system', tokens: countTokens(noteText), content: noteText, classification: 'scene_local' });
        } else {
            // Fallback to end of system prompt if no history
            fitted.push(noteMsg);
            collector.addTrace({ source: 'Scene Note (Fallback)', classification: 'scene_local', tokens: countTokens(noteText), reason: 'Injected after system (no history)', included: true, position: 'dynamic_suffix' });
            collector.addSection({ label: 'Scene Note', role: 'system', tokens: countTokens(noteText), content: noteText, classification: 'scene_local' });
        }
    }

    return fitted;
}
