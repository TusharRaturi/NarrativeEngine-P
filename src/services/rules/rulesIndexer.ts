import type { LoreChunk, RuleChunkMeta, EndpointConfig, ProviderConfig } from '../../types';
import { chunkLoreFile } from '../lore/loreChunker';
import { api } from '../llm/apiClient';
import { llmCall } from '../../utils/llmCall';
import { extractJsonRobust } from '../infrastructure/jsonExtract';

/*
const STOP_WORDS = new Set([
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'has', 'her',
    'was', 'one', 'our', 'out', 'his', 'had', 'may', 'who', 'been', 'some',
    'them', 'than', 'its', 'into', 'only', 'with', 'from', 'this', 'that',
    'they', 'will', 'each', 'make', 'like', 'been', 'have', 'many', 'most',
    'also', 'made', 'after', 'being', 'their', 'much', 'very', 'when', 'what',
    'which', 'more', 'other', 'about', 'such', 'over', 'just', 'does', 'then',
    'could', 'would', 'should', 'where', 'there', 'those', 'these', 'still',
    'well', 'back', 'even', 'here', 'every', 'both', 'through', 'between',
    'before', 'after', 'during', 'without', 'again', 'because', 'under',
]);
*/

export function deriveDefaultMeta(chunk: LoreChunk, existingMeta?: RuleChunkMeta): RuleChunkMeta {
    const hintTriggers = chunk.triggerKeywords || [];
    const merged = [...new Set([...hintTriggers])].slice(0, 15);

    let defaultModes: ('vector' | 'keyword' | 'always')[];
    if (chunk.ragMode) {
        defaultModes = [chunk.ragMode];
    } else {
        const isAlwaysCategory = chunk.alwaysInclude || chunk.priority >= 9;
        defaultModes = isAlwaysCategory ? ['always'] : ['vector', 'keyword'];
    }

    if (existingMeta) {
        return {
            ...existingMeta,
            activationModes: existingMeta.activationModesUserEdited
                ? existingMeta.activationModes
                : (chunk.ragMode ? [chunk.ragMode] : defaultModes),
            triggerKeywords: existingMeta.keywordsUserEdited
                ? existingMeta.triggerKeywords
                : merged,
            secondaryKeywords: existingMeta.keywordsUserEdited
                ? existingMeta.secondaryKeywords
                : (chunk.secondaryKeywords ?? existingMeta.secondaryKeywords ?? []),
        };
    }

    return {
        id: chunk.id,
        activationModes: defaultModes,
        triggerKeywords: merged,
        secondaryKeywords: chunk.secondaryKeywords ?? [],
        priority: chunk.priority,
        keywordsUserEdited: false,
        activationModesUserEdited: false,
    };
}

async function extractKeywordsViaLLM(
    chunk: LoreChunk,
    utilityEndpoint: EndpointConfig | ProviderConfig
): Promise<{ primary: string[]; secondary: string[] }> {
    try {
        const preview = chunk.content.slice(0, 400).replace(/\n+/g, ' ').trim();
        const prompt = `You are extracting trigger keywords for a tabletop RPG rule retrieval system.
Rule section: "${chunk.header}"
Content preview: "${preview}"

List 3-5 keywords a player would type to trigger this rule, and 1-2 secondary keywords for narrowing if the primary keywords are ambiguous. Reply as JSON: { "primary": [...], "secondary": [...] }`;

        const raw = await llmCall(utilityEndpoint, prompt, {
            temperature: 0.1,
            priority: 'normal',
            maxTokens: 150,
        });

        const { value: parsed } = extractJsonRobust<{ primary?: string[]; secondary?: string[] }>(
            raw,
            { primary: [], secondary: [] },
        );
        return {
            primary: Array.isArray(parsed.primary) ? parsed.primary.map(String) : [],
            secondary: Array.isArray(parsed.secondary) ? parsed.secondary.map(String) : [],
        };
    } catch {
        return { primary: [], secondary: [] };
    }
}

export type IndexingProgress = {
    phase: 'chunking' | 'embedding' | 'keyword-extraction' | 'done';
    current: number;
    total: number;
};

export async function indexRules(
    campaignId: string,
    rulesRaw: string,
    existingChunkMeta: Record<string, RuleChunkMeta>,
    utilityEndpoint?: EndpointConfig | ProviderConfig,
    autoGenerateKeywords = true,
    onProgress?: (progress: IndexingProgress) => void
): Promise<{ chunks: LoreChunk[]; chunkMeta: Record<string, RuleChunkMeta> }> {
    const chunks = chunkLoreFile(rulesRaw, true);
    const chunkMeta: Record<string, RuleChunkMeta> = { ...existingChunkMeta };

    onProgress?.({ phase: 'chunking', current: 0, total: chunks.length });

    // REST server is always available.
    // Loop through rule chunks, deriving defaults and performing individual REST embedding uploads
    const newOrChanged: LoreChunk[] = [];
    for (const chunk of chunks) {
        let meta = chunkMeta[chunk.id];
        if (!meta || !meta.hasEmbedding) {
            newOrChanged.push(chunk);
        }
        if (!meta) {
            meta = deriveDefaultMeta(chunk);
            chunkMeta[chunk.id] = meta;
        }
    }

    onProgress?.({ phase: 'embedding', current: 0, total: newOrChanged.length });

    let embeddedCount = 0;
    const CONCURRENCY = 3;
    const embedQueue = [...newOrChanged];
    const embedResults = new Map<string, { modelId?: string; version?: number }>();
    await new Promise<void>((resolveAll) => {
        let inFlight = 0;
        let idx = 0;
        function next() {
            while (inFlight < CONCURRENCY && idx < embedQueue.length) {
                const chunk = embedQueue[idx++];
                inFlight++;
                (async () => {
                    try {
                        const textToEmbed = `${chunk.header}\n${chunk.content}`;
                        const res = await api.rules.upsertEmbedding(campaignId, chunk.id, textToEmbed);
                        if (res) embedResults.set(chunk.id, { modelId: res.modelId, version: res.version });
                    } catch (e) {
                        console.warn(`[RulesIndexer] REST embedding failed for ${chunk.id}:`, e);
                    } finally {
                        inFlight--;
                        embeddedCount++;
                        onProgress?.({ phase: 'embedding', current: embeddedCount, total: newOrChanged.length });
                        if (embedQueue.length - idx + inFlight === 0 && inFlight === 0) {
                            resolveAll();
                        } else {
                            next();
                        }
                    }
                })();
            }
            if (idx >= embedQueue.length && inFlight === 0) resolveAll();
        }
        next();
    });
    for (const [id, res] of embedResults) {
        const meta = chunkMeta[id];
        if (meta) {
            meta.hasEmbedding = true;
            if (res.modelId) meta.modelId = res.modelId;
            if (res.version) meta.version = res.version;
        }
    }

    // Clean up meta entries for removed chunks
    const currentIds = new Set(chunks.map(c => c.id));
    for (const key of Object.keys(chunkMeta)) {
        if (!currentIds.has(key)) {
            await api.rules.deleteEmbedding(campaignId, key).catch(() => {});
            delete chunkMeta[key];
        }
    }

    if (autoGenerateKeywords && utilityEndpoint?.endpoint) {
        const chunksNeedingLLM = chunks.filter(c => {
            const meta = chunkMeta[c.id];
            return meta && !meta.keywordsUserEdited && !meta.llmGenerated;
        });

        onProgress?.({ phase: 'keyword-extraction', current: 0, total: chunksNeedingLLM.length });

        let extractedCount = 0;
        for (const chunk of chunksNeedingLLM) {
            if (extractedCount >= 1) {
                await new Promise(r => setTimeout(r, 300));
            }
            const result = await extractKeywordsViaLLM(chunk, utilityEndpoint);
            const meta = chunkMeta[chunk.id];
            if (meta && result.primary.length > 0) {
                const merged = [...new Set([
                    ...chunk.triggerKeywords,
                    ...result.primary.map(k => k.toLowerCase())
                ])].slice(0, 15);
                meta.triggerKeywords = merged;
                meta.secondaryKeywords = result.secondary.map(k => k.toLowerCase()).slice(0, 5);
                meta.llmGenerated = true;
            }
            extractedCount++;
            onProgress?.({ phase: 'keyword-extraction', current: extractedCount, total: chunksNeedingLLM.length });
        }
    }

    onProgress?.({ phase: 'done', current: chunks.length, total: chunks.length });
    return { chunks, chunkMeta };
}

export function computeRulesThreshold(contextLimit: number, rulesBudgetPct: number): number {
    const rulesBudget = Math.floor(contextLimit * rulesBudgetPct);
    return Math.floor(rulesBudget * 1.2);
}

