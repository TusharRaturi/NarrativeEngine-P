/**
 * lexicalFusion.ts
 *
 * Generic IDF + RRF primitives extracted from the scene retrieval path
 * so lore and rules retrievers can share the same ranking logic.
 *
 * These are independent copies — scene is NOT refactored.
 *
 * RRF (Reciprocal Rank Fusion) uses a constant parameter k (default 60).
 * k is the standard constant from the original Cormack et al. (2009) paper,
 * which serves to penalize low-ranked items while avoiding over-weighting
 * top ranks in short lists.
 */

/**
 * Compute IDF weights from per-document term lists.
 * Formula: idf[t] = log(1 + (N - df + 0.5) / (df + 0.5))
 * Mirrors computeArchiveIdf in archiveMemory.ts but accepts plain string arrays.
 */
export function computeIdf(docTerms: string[][]): Record<string, number> {
    const N = docTerms.length;
    if (N === 0) return {};

    const df: Record<string, number> = {};

    for (const terms of docTerms) {
        const seen = new Set<string>();
        for (const raw of terms) {
            const k = raw.toLowerCase();
            if (!seen.has(k)) {
                seen.add(k);
                df[k] = (df[k] || 0) + 1;
            }
        }
    }

    const idf: Record<string, number> = {};
    for (const [term, count] of Object.entries(df)) {
        idf[term] = Math.log(1 + (N - count + 0.5) / (count + 0.5));
    }

    return idf;
}

/**
 * Reciprocal Rank Fusion of two ranked id lists.
 * Mirrors fuseRecall in archiveMemory.ts.
 *
 * If one list is empty, returns the other as-is.
 */
export function fuseRRF(
    keywordRanked: string[],
    embeddingRanked: string[],
    k = 60,
    kwWeight = 1,
    embWeight = 1
): string[] {
    if (keywordRanked.length === 0 && embeddingRanked.length === 0) return [];
    if (keywordRanked.length === 0) return [...embeddingRanked];
    if (embeddingRanked.length === 0) return [...keywordRanked];

    // Pre-build rank lookups once (O(n)) instead of indexOf per id (O(n²)).
    const kwRankMap = new Map<string, number>();
    for (let i = 0; i < keywordRanked.length; i++) {
        if (!kwRankMap.has(keywordRanked[i])) kwRankMap.set(keywordRanked[i], i);
    }
    const embRankMap = new Map<string, number>();
    for (let i = 0; i < embeddingRanked.length; i++) {
        if (!embRankMap.has(embeddingRanked[i])) embRankMap.set(embeddingRanked[i], i);
    }

    const allIds = new Set<string>([...keywordRanked, ...embeddingRanked]);

    const scores = new Map<string, number>();

    for (const id of allIds) {
        let score = 0;
        const kwRank = kwRankMap.get(id);
        if (kwRank !== undefined) score += kwWeight / (k + kwRank + 1);
        const embRank = embRankMap.get(id);
        if (embRank !== undefined) score += embWeight / (k + embRank + 1);
        scores.set(id, score);
    }

    return Array.from(scores.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([id]) => id);
}
