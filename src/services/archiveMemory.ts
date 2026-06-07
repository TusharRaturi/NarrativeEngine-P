import type { ArchiveIndexEntry, ArchiveScene, ChatMessage, NPCEntry } from '../types';
import { countTokens } from './tokenizer';
import { API_BASE as API } from '../lib/apiBase';
import { safeSceneNum } from '../utils/helpers';
import { fuseRRF } from './retrieval/lexicalFusion';

/**
 * archiveMemory.ts
 *
 * T4 Memory — Index-based hybrid retrieval over lossless .archive.md content.
 *
 * Two independent rankers are fused via Reciprocal Rank Fusion (RRF):
 *   1. an IDF-weighted keyword ranker (3D scoring: activation + recency/importance tiebreak)
 *   2. the server's embedding ranker (cosine order, passed in as semanticCandidateIds)
 *
 * Keyword activations are down-weighted by IDF so common terms count less than rare,
 * distinctive ones. The embedding ranker is a *signal*, not a hard filter — a scene that
 * the keyword ranker finds but the embedding ranker misses can still surface (and vice
 * versa). Divergence scenes are force-surfaced for narrative continuity.
 */

// ─── Recall depth (un-caged for desktop) ───
//
// mobileApp caps recall at 3/4/5 scenes — a phone token/CPU ration. mainApp is desktop +
// server-backed and can recall deeper, so the consensus ceilings are raised. The shape
// (more ranker agreement → more scenes) is preserved from mobileApp; only the ceiling moves.
export type RecallDepth = 'lean' | 'standard' | 'deep';

const DEPTH_TIERS: Record<RecallDepth, { high: number; mid: number; low: number }> = {
    lean: { high: 5, mid: 4, low: 3 },        // mobile parity
    standard: { high: 10, mid: 7, low: 5 },   // desktop default
    deep: { high: 12, mid: 9, low: 7 },
};

// Planner-selected scenes get an additive relevance nudge, scaled to IDF magnitude (~1-6),
// not the old flat +3.5 which would have swamped the keyword score.
const PLANNER_RELEVANCE_BOOST = 2.0;

// ─── IDF cache (signature-gated, campaign-scoped) ───
//
// IDF over the archive only changes when the archive itself changes. The signature is cheap
// to compute and distinguishes "same index" from "index changed". The optional campaignId is
// folded into the signature so two campaigns can never share a stale IDF table even if they
// have identical length + first/last sceneId + timestamp.
let _idfCache: { sig: string; idf: Record<string, number> } | null = null;

function indexSignature(index: ArchiveIndexEntry[], campaignId?: string): string {
    if (index.length === 0) return campaignId ? `${campaignId}:empty` : '';
    const first = index[0].sceneId;
    const last = index[index.length - 1].sceneId;
    const tsLast = index[index.length - 1].timestamp;
    return `${campaignId ?? ''}:${index.length}:${first}:${last}:${tsLast}`;
}

export function computeArchiveIdf(index: ArchiveIndexEntry[], campaignId?: string): Record<string, number> {
    const sig = indexSignature(index, campaignId);
    if (_idfCache && _idfCache.sig === sig) return _idfCache.idf;

    const N = index.length;
    const df: Record<string, number> = {};

    for (const entry of index) {
        const seen = new Set<string>();
        const kwStrengths = entry.keywordStrengths ?? {};
        const npcStrengths = entry.npcStrengths ?? {};
        if (Object.keys(kwStrengths).length > 0 || Object.keys(npcStrengths).length > 0) {
            for (const kw of Object.keys(kwStrengths)) {
                const k = kw.toLowerCase();
                if (!seen.has(k)) { seen.add(k); df[k] = (df[k] || 0) + 1; }
            }
            for (const npc of Object.keys(npcStrengths)) {
                const k = npc.toLowerCase();
                if (!seen.has(k)) { seen.add(k); df[k] = (df[k] || 0) + 1; }
            }
        } else {
            for (const kw of entry.keywords) {
                const k = kw.toLowerCase();
                if (!seen.has(k)) { seen.add(k); df[k] = (df[k] || 0) + 1; }
            }
            for (const npc of entry.npcsMentioned) {
                const k = npc.toLowerCase();
                if (!seen.has(k)) { seen.add(k); df[k] = (df[k] || 0) + 1; }
            }
        }
    }

    const idf: Record<string, number> = {};
    for (const [term, count] of Object.entries(df)) {
        idf[term] = Math.log(1 + (N - count + 0.5) / (count + 0.5));
    }

    _idfCache = { sig, idf };
    return idf;
}

export function clearArchiveIdfCache(): void {
    _idfCache = null;
}

// ─── Keyword relevance scoring ───
//
// Returns { keywordRelevance, recency, importance }. Only `keywordRelevance` drives the
// keyword *rank* (which feeds RRF); recency/importance are demoted to small tiebreakers.
// This split is mandatory: RRF consumes ordinal rank, so a flat importance term added to
// every scene (the old `+1.0×importance`) would make the keyword list importance-sorted and
// the fusion meaningless.
type ScoreResult = {
    keywordRelevance: number;
    recency: number;
    importance: number;
};

function scoreEntry(
    entry: ArchiveIndexEntry,
    contextText: string,
    contextActivations: Record<string, number>,
    totalScenes: number,
    idf: Record<string, number>,
    npcPerspective?: string,
): ScoreResult {
    // Recency (always positive, logarithmic — never zero). Tiebreak only.
    const sceneNum = safeSceneNum(entry.sceneId);
    const turnsSince = totalScenes - sceneNum;
    const recency = 1 / (1 + Math.log(1 + Math.max(0, turnsSince)));

    // Intrinsic importance (permanent, no decay). Tiebreak only.
    const importance = entry.importance ?? 5;

    // Activation strength: IDF-weighted keyword-strength-matrix dot product.
    let activation = 0;
    const kwStrengths = entry.keywordStrengths ?? {};
    for (const [keyword, strength] of Object.entries(kwStrengths)) {
        const a = contextActivations[keyword];
        if (a) activation += a * strength * (idf[keyword] ?? 1);
    }
    const npcStrengths = entry.npcStrengths ?? {};
    for (const [npc, strength] of Object.entries(npcStrengths)) {
        const a = contextActivations[npc];
        if (a) activation += a * strength * 1.5 * (idf[npc] ?? 1);
    }

    // Fallback: legacy keyword matching for old entries without strength matrices.
    if (Object.keys(kwStrengths).length === 0 && Object.keys(npcStrengths).length === 0) {
        for (const kw of entry.keywords) {
            const k = kw.toLowerCase();
            if (contextText.includes(k)) {
                const exactMatch = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
                activation += (exactMatch.test(contextText) ? 2 : 0.5) * (idf[k] ?? 1);
            }
        }
        for (const npc of entry.npcsMentioned) {
            const k = npc.toLowerCase();
            if (contextText.includes(k)) activation += 3 * (idf[k] ?? 1);
        }
    }

    let keywordRelevance = 2.0 * activation;

    // POV-aware boost/penalty (mainApp-specific signal, folded into relevance).
    if (npcPerspective && keywordRelevance > 0) {
        const witnesses = entry.witnesses ?? [];
        const wasWitness = witnesses.some(w => w.toLowerCase() === npcPerspective.toLowerCase());
        const wasMentioned = entry.npcsMentioned.some(m => m.toLowerCase() === npcPerspective.toLowerCase());

        if (wasWitness) keywordRelevance *= 1.5;
        else if (wasMentioned) keywordRelevance *= 0.8;
        else if (witnesses.length > 0) keywordRelevance *= 0.3;
    }

    // Divergence is intentionally NOT boosted here — it is force-surfaced post-fusion in
    // retrieveArchiveMemory. Boosting it here too would double-count it.
    return { keywordRelevance, recency, importance };
}

/**
 * Consensus-based dynamic max, sized for desktop. More agreement between the keyword and
 * embedding rankers → more scenes returned. This is only an upper bound — the actual count
 * is min(ceiling, scenes that actually matched), so a high ceiling never pads with noise.
 */
function computeDynamicMax(
    keywordRanked: string[],
    embeddingRanked: string[],
    depth: RecallDepth,
    topKeywordRelevance: number,
    maxScenes?: number,
): number {
    if (maxScenes !== undefined) return maxScenes;
    const tiers = DEPTH_TIERS[depth];

    // Keyword-only path (no embedding ranker available): size by keyword strength so we don't
    // regress to the floor. Mirrors mainApp's pre-fusion magnitude heuristic, mapped to the
    // depth's raised tiers.
    if (embeddingRanked.length === 0) {
        if (topKeywordRelevance > 15) return tiers.high;
        if (topKeywordRelevance > 8) return tiers.mid;
        return tiers.low;
    }

    const keywordSet = new Set(keywordRanked);
    let consensus = 0;
    for (const id of embeddingRanked) {
        if (keywordSet.has(id)) consensus++;
    }
    if (consensus >= 3) return tiers.high;
    if (consensus >= 1) return tiers.mid;
    return tiers.low;
}

/**
 * Extract graded context activations from the current conversation.
 * Returns a map of keyword -> activation weight (0-1).
 * User message = 1.0, last 3 assistant messages = 0.7, last 10 messages = 0.3.
 */
export function extractContextActivations(
    userMessage: string,
    recentMessages: ChatMessage[],
    npcLedger?: NPCEntry[]
): Record<string, number> {
    const activations: Record<string, number> = {};

    // 2-char minimum to capture short NPC names common in fantasy settings (e.g. "Xi", "Ka", "Al")
    const userWords = userMessage.toLowerCase().match(/[a-z]{2,}/g) || [];
    for (const word of userWords) activations[word] = 1.0;

    const userProperNouns = userMessage.match(/[A-Z][A-Za-z]{1,}(?:\s[A-Z][A-Za-z]{1,})*/g) || [];
    for (const noun of userProperNouns) activations[noun.toLowerCase()] = 1.0;

    const last3 = recentMessages.filter(m => m.role === 'assistant').slice(-3);
    for (const msg of last3) {
        const words = (msg.content || '').toLowerCase().match(/[a-z]{2,}/g) || [];
        const properNouns = (msg.content || '').match(/[A-Z][A-Za-z]{1,}(?:\s[A-Z][A-Za-z]{1,})*/g) || [];
        for (const word of words) { if (!activations[word]) activations[word] = 0.7; }
        for (const noun of properNouns) { if (!activations[noun.toLowerCase()]) activations[noun.toLowerCase()] = 0.7; }
    }

    const last10 = recentMessages.slice(-10);
    for (const msg of last10) {
        const words = (msg.content || '').toLowerCase().match(/[a-z]{2,}/g) || [];
        for (const word of words) { if (!activations[word]) activations[word] = 0.3; }
    }

    if (npcLedger) {
        for (const npc of npcLedger) {
            activations[npc.name.toLowerCase()] = 1.0;
            if (npc.aliases) {
                for (const alias of npc.aliases.split(',').map(a => a.trim().toLowerCase()).filter(Boolean)) {
                    activations[alias] = 1.0;
                }
            }
        }
    }

    return activations;
}

/**
 * Expand context activations using semantic fact relationships.
 * If context mentions "Malachar" and a fact says "X killed_by Malachar",
 * then "x" also gets activated (weaker weight).
 */
export function expandActivationsWithFacts(
    activations: Record<string, number>,
    facts?: { subject: string; predicate: string; object: string; importance: number }[]
): Record<string, number> {
    if (!facts || facts.length === 0) return activations;

    const expanded = { ...activations };

    // 1-hop expansion
    for (const fact of facts) {
        const sLower = fact.subject.toLowerCase();
        const oLower = fact.object.toLowerCase();
        if (expanded[sLower] && !expanded[oLower]) {
            expanded[oLower] = expanded[sLower] * 0.5;
        }
        if (expanded[oLower] && !expanded[sLower]) {
            expanded[sLower] = expanded[oLower] * 0.5;
        }
    }

    // 2-hop expansion: entities connected via an intermediate entity
    const hop2Activations: Record<string, number> = {};
    for (const [entity, weight] of Object.entries(expanded)) {
        if (weight < 0.3) continue;
        const hop1Facts = facts.filter(f =>
            f.subject.toLowerCase() === entity || f.object.toLowerCase() === entity
        );
        for (const hop1Fact of hop1Facts) {
            const hop1Entity = hop1Fact.subject.toLowerCase() === entity
                ? hop1Fact.object.toLowerCase() : hop1Fact.subject.toLowerCase();
            const hop2Facts = facts.filter(f =>
                f.subject.toLowerCase() === hop1Entity || f.object.toLowerCase() === hop1Entity
            );
            for (const h2f of hop2Facts) {
                const hop2Entity = h2f.subject.toLowerCase() === hop1Entity
                    ? h2f.object.toLowerCase() : h2f.subject.toLowerCase();
                if (!expanded[hop2Entity] && hop2Entity !== entity) {
                    hop2Activations[hop2Entity] = (hop2Activations[hop2Entity] || 0) + weight * 0.25;
                }
            }
        }
    }
    for (const [entity, weight] of Object.entries(hop2Activations)) {
        if (!expanded[entity]) {
            expanded[entity] = weight;
        }
    }

    return expanded;
}

export function applyEventBoost(
    candidates: ArchiveIndexEntry[],
    query: string,
    recentMessages: ChatMessage[],
): Map<string, number> {
    const boostMap = new Map<string, number>();
    const contextText = [
        query,
        ...recentMessages.slice(-3).map(m => m.content || '')
    ].join('\n').toLowerCase();

    for (const entry of candidates) {
        if (!entry.events || entry.events.length === 0) continue;
        let bonus = 0;
        for (const event of entry.events) {
            if (event.importance >= 7) {
                bonus += 1.5;
            }
            if (event.characters) {
                for (const char of event.characters) {
                    if (char && contextText.includes(char.toLowerCase())) {
                        bonus += 1.0;
                    }
                }
            }
            if (event.locations) {
                for (const loc of event.locations) {
                    if (loc && contextText.includes(loc.toLowerCase())) {
                        bonus += 1.0;
                    }
                }
            }
        }
        if (bonus > 0) {
            boostMap.set(entry.sceneId, bonus);
        }
    }
    return boostMap;
}

/**
 * Search the archive index with hybrid retrieval: an IDF-weighted keyword ranker fused with
 * the server's embedding ranker via RRF. Divergence scenes are force-surfaced. Returns the
 * matched scene IDs in fused (front-loaded) order, best first.
 */
export function retrieveArchiveMemory(
    index: ArchiveIndexEntry[],
    userMessage: string,
    recentMessages: ChatMessage[],
    npcLedger?: NPCEntry[],
    maxScenes?: number,
    semanticFacts?: { subject: string; predicate: string; object: string; importance: number }[],
    sceneRanges?: [string, string][],
    npcPerspective?: string,
    semanticCandidateIds?: string[],
    divergenceSceneIds?: Set<string>,
    excludeSceneIds?: Set<string>,
    plannerSceneIds?: string[],
    recallDepth: RecallDepth = 'standard',
    campaignId?: string,
): string[] {
    if (!index || index.length === 0) {
        console.log('[Archive Retrieval] Index is empty — no recall.');
        return [];
    }

    const contextText = [
        userMessage,
        ...recentMessages.slice(-3).map(m => m.content || '')
    ].join('\n').toLowerCase();

    let contextActivations = extractContextActivations(userMessage, recentMessages, npcLedger);
    contextActivations = expandActivationsWithFacts(contextActivations, semanticFacts);

    // Filter to scenes within provided scene ranges (if any).
    let scopedIndex = index;
    if (sceneRanges && sceneRanges.length > 0) {
        scopedIndex = index.filter(entry => {
            const sceneNum = safeSceneNum(entry.sceneId);
            return sceneRanges.some(([start, end]) => {
                const s = safeSceneNum(start);
                const e = safeSceneNum(end);
                return sceneNum >= s && sceneNum <= e;
            });
        });
    }

    // NOTE: the old `semanticCandidateIds` hard-filter is intentionally removed. The embedding
    // ranker is now a fusion signal, not a gate (see file header). Excluded scenes are still
    // filtered out below, and the embedding ranker is scope-filtered before fusion.
    if (excludeSceneIds && excludeSceneIds.size > 0) {
        const before = scopedIndex.length;
        scopedIndex = scopedIndex.filter(entry => !excludeSceneIds.has(entry.sceneId));
        if (before !== scopedIndex.length) {
            console.log(`[Archive Retrieval] Excluded ${before - scopedIndex.length} scene(s) already in fitted history.`);
        }
    }

    const idf = computeArchiveIdf(index, campaignId);
    const totalScenes = scopedIndex.length;
    const eventBoosts = applyEventBoost(scopedIndex, userMessage, recentMessages);
    const plannerSet = plannerSceneIds && plannerSceneIds.length > 0 ? new Set(plannerSceneIds) : null;

    // ─── Keyword ranker (IDF-weighted, with mainApp signals folded into relevance) ───
    const scored = scopedIndex.map(entry => {
        const { keywordRelevance, recency, importance } = scoreEntry(
            entry, contextText, contextActivations, totalScenes, idf, npcPerspective,
        );
        let relevance = keywordRelevance;
        relevance += eventBoosts.get(entry.sceneId) ?? 0;
        if (plannerSet?.has(entry.sceneId)) relevance += PLANNER_RELEVANCE_BOOST;
        return {
            sceneId: entry.sceneId,
            relevance,
            tiebreak: (0.1 * recency) + (0.05 * importance),
        };
    });

    const keywordRelevant = scored
        .filter(s => s.relevance > 0)
        .sort((a, b) => (b.relevance + b.tiebreak) - (a.relevance + a.tiebreak));
    const keywordRanked = keywordRelevant.map(s => s.sceneId);
    const topKeywordRelevance = keywordRelevant[0]?.relevance ?? 0;

    // ─── Embedding ranker (cosine order from server), scope-filtered ───
    // Guard: filter to the post-exclude, post-range scoped scenes so excluded / out-of-range
    // scenes cannot leak back in through the embedding ranker.
    const scopedSceneIds = new Set(scopedIndex.map(e => e.sceneId));
    const embeddingRanked = (semanticCandidateIds ?? []).filter(id => scopedSceneIds.has(id));

    // ─── RRF fusion ───
    const fused = fuseRRF(keywordRanked, embeddingRanked);

    // ─── Divergence front-loading ───
    // Divergence scenes (where the story left canon) must surface for continuity even when
    // they don't match the current turn's keywords or embeddings. Matched ones keep their
    // fused order; unmatched ones are injected after, by recency.
    let ordered = fused;
    if (divergenceSceneIds && divergenceSceneIds.size > 0) {
        const fusedSet = new Set(fused);
        const divInScope = scopedIndex
            .map(e => e.sceneId)
            .filter(id => divergenceSceneIds.has(id));
        if (divInScope.length > 0) {
            const divSet = new Set(divInScope);
            const matchedDiv = fused.filter(id => divSet.has(id));
            const unmatchedDiv = divInScope
                .filter(id => !fusedSet.has(id))
                .sort((a, b) => safeSceneNum(b) - safeSceneNum(a));
            const rest = fused.filter(id => !divSet.has(id));
            ordered = [...matchedDiv, ...unmatchedDiv, ...rest];
        }
    }

    const dynamicMax = computeDynamicMax(keywordRanked, embeddingRanked, recallDepth, topKeywordRelevance, maxScenes);
    const result = ordered.slice(0, dynamicMax);

    console.log(
        `[Archive Retrieval] Hybrid over ${index.length} entries: ` +
        `${keywordRanked.length} keyword, ${embeddingRanked.length} embedding hits ` +
        `(depth=${recallDepth}, max ${dynamicMax}). Top: [${result.join(', ')}]`
    );

    return result;
}

/**
 * Fetch full verbatim scene content from the server for a set of scene IDs.
 * Returns scenes within the token budget, sorted chronologically.
 */
export async function fetchArchiveScenes(
    campaignId: string,
    sceneIds: string[],
    tokenBudget = 3000
): Promise<ArchiveScene[]> {
    if (sceneIds.length === 0) return [];

    try {
        const idsParam = sceneIds.join(',');
        const res = await fetch(`${API}/campaigns/${campaignId}/archive/scenes?ids=${idsParam}`);
        if (!res.ok) {
            console.warn('[Archive Retrieval] Failed to fetch scenes:', res.status);
            return [];
        }

        const raw: { sceneId: string; content: string }[] = await res.json();

        const sorted = raw.sort((a, b) => safeSceneNum(a.sceneId) - safeSceneNum(b.sceneId));
        const selected: ArchiveScene[] = [];
        let usedTokens = 0;

        for (const scene of sorted) {
            const tokens = countTokens(scene.content);
            if (usedTokens + tokens > tokenBudget) {
                // Partially include the scene if there's a meaningful amount of budget remaining
                const remaining = tokenBudget - usedTokens;
                if (remaining > 150) {
                    // ~4 chars per token; truncate to fit remaining budget
                    const maxChars = Math.floor(remaining * 4);
                    const truncated = scene.content.slice(0, maxChars) + '\n[...scene truncated for context budget...]';
                    selected.push({ sceneId: scene.sceneId, content: truncated, tokens: remaining });
                }
                break;
            }
            selected.push({ sceneId: scene.sceneId, content: scene.content, tokens });
            usedTokens += tokens;
        }

        console.log(
            `[Archive Retrieval] Fetched ${selected.length}/${raw.length} scenes ` +
            `(${usedTokens} tokens used of ${tokenBudget} budget).`
        );

        return selected;
    } catch (err) {
        console.warn('[Archive Retrieval] Error fetching scenes:', err);
        return [];
    }
}

/**
 * Convenience: search + fetch in one call.
 * Used in ChatArea before buildPayload().
 */
export async function recallArchiveScenes(
    campaignId: string,
    index: ArchiveIndexEntry[],
    userMessage: string,
    recentMessages: ChatMessage[],
    tokenBudget = 3000,
    npcLedger?: NPCEntry[],
    semanticFacts?: { subject: string; predicate: string; object: string; importance: number }[],
    npcPerspective?: string,
    semanticCandidateIds?: string[],
    divergenceSceneIds?: Set<string>,
    excludeSceneIds?: Set<string>,
    plannerSceneIds?: string[],
    recallDepth: RecallDepth = 'standard',
): Promise<ArchiveScene[]> {
    const matchedIds = retrieveArchiveMemory(index, userMessage, recentMessages, npcLedger, undefined, semanticFacts, undefined, npcPerspective, semanticCandidateIds, divergenceSceneIds, excludeSceneIds, plannerSceneIds, recallDepth, campaignId);
    if (matchedIds.length === 0) return [];
    return fetchArchiveScenes(campaignId, matchedIds, tokenBudget);
}
