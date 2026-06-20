import type { SemanticFact, NPCEntry } from '../../types';
import { countTokens } from '../infrastructure/tokenizer';
import { PROPER_NOUN_STOP_WORDS } from '../../utils/stopWords';

export function extractContextEntities(
    input: string,
    recentMessages: { content?: string | null }[],
    npcLedger: NPCEntry[]
): Set<string> {
    const entities = new Set<string>();

    for (const npc of npcLedger) {
        if (npc.archived) continue;
        if (npc.name) entities.add(npc.name.toLowerCase());
        if (npc.aliases) {
            npc.aliases.split(',').map(a => a.trim().toLowerCase()).filter(Boolean)
                .forEach(a => entities.add(a));
        }
    }

    const text = input + ' ' + recentMessages.slice(-5)
        .map(m => (typeof m.content === 'string' ? m.content : '')).join(' ');
    const matches = text.match(/[A-Z][A-Za-z]{2,}(?:\s[A-Z][A-Za-z]{2,})*/g) || [];
    for (const match of matches) {
        if (!PROPER_NOUN_STOP_WORDS.has(match)) {
            entities.add(match.toLowerCase());
        }
    }

    return entities;
}

export function queryFacts(
    facts: SemanticFact[],
    input: string,
    recentMessages: { content?: string | null }[],
    npcLedger: NPCEntry[],
    tokenBudget = 500
): SemanticFact[] {
    const entities = extractContextEntities(input, recentMessages, npcLedger);
    const scored = facts.map(fact => {
        let score = 0;
        const sLower = fact.subject.toLowerCase();
        const oLower = fact.object.toLowerCase();

        for (const entity of entities) {
            if (entity === sLower) score += fact.importance;
            else if (entity === oLower) score += fact.importance * 0.8;
            else if (sLower.includes(entity) || entity.includes(sLower)) score += 2;
            else if (oLower.includes(entity) || entity.includes(oLower)) score += 1.5;
        }

        return { fact, score };
    });

    const selected = scored
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score);

    const result: SemanticFact[] = [];
    let tokens = 0;
    for (const { fact } of selected) {
        const factTokens = countTokens(formatFactLine(fact));
        if (tokens + factTokens > tokenBudget) break;
        result.push(fact);
        tokens += factTokens;
    }
    return result;
}

function formatFactLine(fact: SemanticFact): string {
    return `\u25b8 ${fact.subject} \u2014${fact.predicate}\u2192 ${fact.object} [${fact.importance}]`;
}

export function formatFactsForContext(facts: SemanticFact[]): string {
    if (facts.length === 0) return '';
    const sorted = [...facts].sort((a, b) => b.importance - a.importance);
    const lines = sorted.map(formatFactLine);
    return `[SEMANTIC MEMORY - ${sorted.length} verified facts]\n${lines.join('\n')}\n[END SEMANTIC MEMORY]`;
}