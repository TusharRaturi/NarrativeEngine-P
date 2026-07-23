import type { DivergenceRegister, DivergenceEntry, NPCEntry, ArchiveChapter, EndpointConfig, ProviderConfig } from '../../types';
import { llmCall } from '../../utils/llmCall';
import { extractJsonRobust } from '../infrastructure/jsonExtract';
import { api } from '../llm/apiClient';

export type DedupGroup = {
    bucketLabel: string;
    keepId: string;
    disableIds: string[];
    reason?: string;
};

export type DedupCancelled = { cancelled: boolean };

export type DedupResult = {
    groups: DedupGroup[];
    failedBuckets: string[];
};

export async function runFactDedup(
    register: DivergenceRegister,
    npcLedger: NPCEntry[],
    chapters: ArchiveChapter[],
    utilityProvider: EndpointConfig | ProviderConfig,
    cancel: DedupCancelled,
    onProgress: (msg: string, done: number, total: number) => void,
): Promise<DedupResult> {
    const eligible = register.entries.filter(e => !e.pinned && e.enabled !== false);

    if (eligible.length === 0) return { groups: [], failedBuckets: [] };

    const npcNameMap = new Map<string, string>();
    for (const n of npcLedger) {
        npcNameMap.set(n.id, n.name);
    }

    const chapterIndexMap = new Map<string, number>();
    for (let i = 0; i < chapters.length; i++) {
        chapterIndexMap.set(chapters[i].chapterId, i);
    }

    const allGroups: DedupGroup[] = [];
    const localDedupMap = new Map<string, DivergenceEntry[]>();
    const finalEligible: DivergenceEntry[] = [];

    for (const entry of eligible) {
        const normalizedText = entry.text.toLowerCase().replace(/[^\w\s]/g, '').trim();
        const sig = `${entry.sceneRef}|${normalizedText}`;
        if (!localDedupMap.has(sig)) localDedupMap.set(sig, []);
        localDedupMap.get(sig)!.push(entry);
    }

    for (const entries of localDedupMap.values()) {
        if (entries.length > 1) {
            const sortedByRecency = [...entries].sort((a, b) => {
                if (a.source === 'manual' && b.source !== 'manual') return 1;
                if (b.source === 'manual' && a.source !== 'manual') return -1;
                return a.id.localeCompare(b.id);
            });
            const keep = sortedByRecency[sortedByRecency.length - 1];
            const disable = sortedByRecency.slice(0, -1);
            
            allGroups.push({
                bucketLabel: 'Exact Duplicates',
                keepId: keep.id,
                disableIds: disable.map(d => d.id),
                reason: 'Identical fact text in the same scene.',
            });
            finalEligible.push(keep);
        } else {
            finalEligible.push(entries[0]);
        }
    }

    // Phase 1: Fetch embeddings
    onProgress('Generating semantic embeddings for facts...', 0, 100);
    const textsToEmbed = finalEligible.map(e => {
        const parts = [`Category: ${e.category}`];
        if (e.theme) parts.push(`Theme: ${e.theme}`);
        if (e.locations && e.locations.length > 0) parts.push(`Locations: ${e.locations.join(', ')}`);
        if (e.npcIds && e.npcIds.length > 0) {
            const names = e.npcIds.map(id => npcNameMap.get(id) || id);
            parts.push(`NPCs: ${names.join(', ')}`);
        }
        parts.push(`Fact: ${e.text}`);
        return parts.join(' | ');
    });
    const embedRes = await api.embedding.batchCompute(textsToEmbed);
    
    if (cancel.cancelled) throw new Error('Dedup cancelled.');

    if (!embedRes || !embedRes.embeddings) {
        throw new Error('Failed to compute embeddings for facts.');
    }
    const embeddings = embedRes.embeddings;

    // Phase 2: Compute local similarity and form clusters
    onProgress('Clustering facts by semantic similarity...', 10, 100);
    
    const clusters: DivergenceEntry[][] = [];
    const used = new Set<string>();

    for (let i = 0; i < finalEligible.length; i++) {
        if (used.has(finalEligible[i].id)) continue;
        
        const cluster = [finalEligible[i]];
        used.add(finalEligible[i].id);
        const vecA = embeddings[i];

        for (let j = i + 1; j < finalEligible.length; j++) {
            if (used.has(finalEligible[j].id)) continue;
            
            const vecB = embeddings[j];
            const sim = cosineSimilarity(vecA, vecB);
            
            const eA = finalEligible[i];
            const eB = finalEligible[j];
            
            // Boost similarity if they share structured entities
            let entityOverlap = false;
            if (eA.theme && eA.theme === eB.theme) entityOverlap = true;
            if (eA.locations?.some(l => eB.locations?.includes(l))) entityOverlap = true;
            if (eA.items?.some(it => eB.items?.includes(it))) entityOverlap = true;
            
            const threshold = entityOverlap ? 0.80 : 0.88;
            
            if (sim >= threshold) {
                cluster.push(eB);
                used.add(eB.id);
            }
        }
        
        if (cluster.length > 1) {
            clusters.push(cluster);
        }
    }

    if (clusters.length === 0) {
        return { groups: allGroups, failedBuckets: [] };
    }

    // Phase 3: Batch LLM processing
    const BATCH_SIZE = 5; // number of clusters per LLM prompt
    const failedBuckets: string[] = [];
    const seenMergeKeys = new Set<string>();

    for (let i = 0; i < clusters.length; i += BATCH_SIZE) {
        if (cancel.cancelled) throw new Error('Dedup cancelled.');

        const batch = clusters.slice(i, i + BATCH_SIZE);
        onProgress(`Reviewing semantic clusters with LLM (${i + 1} to ${Math.min(i + BATCH_SIZE, clusters.length)} of ${clusters.length})...`, 20 + Math.floor((i / clusters.length) * 80), 100);

        let promptText = `You are a strict data deduplicator. Analyze the following distinct clusters of campaign facts. Each cluster is separated by "---".
Within EACH cluster, identify facts that describe the EXACT SAME EVENT or EXACT SAME STATE in different words.

DO NOT GROUP:
- Different events sharing a trait ("X saved A" + "X saved B")
- Contradictions / arc reversals ("X hates Y" + "X loves Y")
- General + specific ("X is brave" + "X charged the dragon")
- Related but distinct ("Bridge is dangerous" + "Bridge collapsed")

ONLY GROUP:
- Restatements of one event ("X rescued a civilian" + "X saved a bystander")
- Same state in different words ("X has the amulet" + "X carries the amulet")

`;

        for (let b = 0; b < batch.length; b++) {
            promptText += `---\nCLUSTER ${b + 1}:\n`;
            promptText += batch[b].map(e => {
                const names = e.npcIds && e.npcIds.length > 0 ? e.npcIds.map(id => npcNameMap.get(id) || id).join(', ') : 'none';
                const locs = e.locations && e.locations.length > 0 ? e.locations.join(', ') : 'none';
                return `${e.id} | #${e.sceneRef} | [Locs: ${locs}] [NPCs: ${names}] [Theme: ${e.theme || 'none'}] | ${e.text}`;
            }).join('\n') + '\n\n';
        }

        promptText += `Return ONLY a JSON object with this exact schema:
{"duplicates":[{"ids":["<fact_id>","<fact_id>"],"reason":"<one short sentence>"}]}

If there are NO duplicates in ANY cluster, return {"duplicates":[]} exactly.`;

        let raw: string;
        try {
            raw = await llmCall(utilityProvider, promptText, {
                temperature: 0.1,
                maxTokens: 4096,
                trackingLabel: 'fact-dedup-batch',
                timeoutMs: 24 * 60 * 60 * 1000,
            });
        } catch (err) {
            console.warn(`[FactDeduper] LLM batch failed:`, err);
            failedBuckets.push(`Batch ${i / BATCH_SIZE + 1}`);
            continue;
        }

        const { value: parsed, parseOk } = extractJsonRobust<{ duplicates: Array<{ ids: string[]; reason?: string }> }>(
            raw,
            { duplicates: [] },
        );

        if (!parseOk || !Array.isArray(parsed.duplicates)) {
            console.warn('[FactDeduper] Bad response for batch', raw);
            failedBuckets.push(`Batch ${i / BATCH_SIZE + 1}`);
            continue;
        }

        // Map facts back for sorting
        const entryById = new Map<string, DivergenceEntry>();
        for (const cluster of batch) {
            for (const e of cluster) entryById.set(e.id, e);
        }

        for (const group of parsed.duplicates) {
            if (!Array.isArray(group.ids)) continue;

            const validIds = group.ids.filter(id => entryById.has(id));
            if (validIds.length < 2) continue;

            const sortedByRecency = [...validIds].sort((a, b) => {
                const entryA = entryById.get(a);
                const entryB = entryById.get(b);
                if (!entryA || !entryB) return 0;
                const chIdxA = chapterIndexMap.get(entryA.chapterId) ?? 0;
                const chIdxB = chapterIndexMap.get(entryB.chapterId) ?? 0;
                if (chIdxA !== chIdxB) return chIdxA - chIdxB;
                return entryA.sceneRef.localeCompare(entryB.sceneRef);
            });

            const keepId = sortedByRecency[sortedByRecency.length - 1];
            const disableIds = sortedByRecency.slice(0, -1);

            const mergeKey = `${keepId}|${[...disableIds].sort().join('|')}`;
            if (seenMergeKeys.has(mergeKey)) continue;
            seenMergeKeys.add(mergeKey);
            
            const keepEntry = entryById.get(keepId)!;
            const labelStr = keepEntry.theme ? `Theme: ${keepEntry.theme}` : 
                             (keepEntry.npcIds?.length ? `NPCs` : 'Semantic Cluster');

            allGroups.push({
                bucketLabel: labelStr,
                keepId,
                disableIds,
                reason: group.reason,
            });
        }
    }

    onProgress(`Done — ${allGroups.length} duplicate groups found`, 100, 100);
    return { groups: allGroups, failedBuckets };
}

function cosineSimilarity(a: number[], b: number[]) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
}
