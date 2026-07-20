import type { LoreChunk, RuleChunkMeta, LLMProvider } from '../../types';
import { chunkLoreFile } from './loreChunker';
import { embeddingStorage, EMBEDDING_VERSION } from '../storage/embeddingStorage';
import { enqueueProgressiveWithExistingCheck } from '../embedding/embeddingScheduler';
import { llmCall } from '../../utils/llmCall';
import { INPUT_DELIMITER } from '../infrastructure';

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

function deriveDefaultMeta(chunk: LoreChunk, existingMeta?: RuleChunkMeta): RuleChunkMeta {
    const hintTriggers = chunk.triggerKeywords || [];
    const merged = [...new Set([...hintTriggers])].slice(0, 15);

    // ragMode from hint is authoritative; fall back to alwaysInclude/priority heuristic
    let defaultModes: ('vector' | 'keyword' | 'always')[];
    if (chunk.ragMode) {
        defaultModes = [chunk.ragMode];
    } else {
        const isAlwaysCategory = chunk.alwaysInclude || chunk.priority >= 9;
        // No hint: default to BOTH semantic + keyword (matches lore default).
        defaultModes = isAlwaysCategory ? ['always'] : ['vector', 'keyword'];
    }

    if (existingMeta) {
        return {
            ...existingMeta,
            // Re-apply authoritative ragMode if present — overrides stale stored mode
            activationModes: chunk.ragMode ? [chunk.ragMode] : existingMeta.activationModes,
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
    };
}

async function extractKeywordsViaLLM(
    chunk: LoreChunk,
    utilityEndpoint: LLMProvider
): Promise<{ primary: string[]; secondary: string[] }> {
    try {
        const preview = chunk.content.slice(0, 400).replace(/\n+/g, ' ').trim();
        const prompt = `You are extracting trigger keywords for a tabletop RPG rule retrieval system.\nList 3-5 keywords a player would type to trigger this rule, and 1-2 secondary keywords for narrowing. Reply as JSON: { "primary": [...], "secondary": [...] }\n\n${INPUT_DELIMITER}\n\nRule section: "${chunk.header}"\nContent preview: "${preview}"`;

        const raw = await llmCall(utilityEndpoint, prompt, {
            temperature: 0.1,
            priority: 'normal',
            maxTokens: 150,
        });

        let clean = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
        const mdMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (mdMatch) clean = mdMatch[1];

        const start = clean.indexOf('{');
        const end = clean.lastIndexOf('}');
        if (start === -1 || end === -1) return { primary: [], secondary: [] };

        const parsed = JSON.parse(clean.substring(start, end + 1));
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
    existingChunkMeta: Record<string, RuleChunkMeta> | undefined,
    utilityEndpoint: LLMProvider | undefined,
    autoGenerateKeywords: boolean,
    onProgress?: (progress: IndexingProgress) => void
): Promise<{ chunks: LoreChunk[]; chunkMeta: Record<string, RuleChunkMeta> }> {
    const chunks = chunkLoreFile(rulesRaw, 'rule');
    const chunkMeta: Record<string, RuleChunkMeta> = { ...existingChunkMeta };

    onProgress?.({ phase: 'chunking', current: 0, total: chunks.length });

    // One-time migration: rule embeddings created before the full-content scheme
    // (version < EMBEDDING_VERSION) were truncated to 500 chars. Delete them so the
    // existing-check below re-embeds them at full content via the (fixed) scheduler path.
    const storedRuleVectors = await embeddingStorage.getAllWithVersion(campaignId, 'rule');
    const staleRuleIds = storedRuleVectors.filter(r => r.version < EMBEDDING_VERSION).map(r => r.id);
    for (const id of staleRuleIds) {
        await embeddingStorage.deleteByTypeAndId(campaignId, 'rule', id).catch(() => {});
    }
    if (staleRuleIds.length > 0) {
        console.log(`[RulesRAG] Migrated ${staleRuleIds.length} truncated rule embedding(s) → full-content re-embed`);
    }

    const existingIds = new Set(
        (await embeddingStorage.getAll(campaignId, 'rule')).map(e => e.id)
    );
    const newOrChanged: LoreChunk[] = [];

    for (const chunk of chunks) {
        if (!existingIds.has(chunk.id)) {
            newOrChanged.push(chunk);
        }
        let meta = chunkMeta[chunk.id];
        if (!meta) {
            meta = deriveDefaultMeta(chunk);
            chunkMeta[chunk.id] = meta;
        }
    }

    onProgress?.({ phase: 'embedding', current: 0, total: newOrChanged.length });

    const vectorChunks = newOrChanged.filter(c => {
        const modes = deriveDefaultMeta(c).activationModes;
        return modes.includes('vector');
    });

    if (vectorChunks.length > 0) {
        await enqueueProgressiveWithExistingCheck({
            campaignId,
            type: 'rule',
            chunks: vectorChunks.map(c => ({
                id: c.id,
                content: c.content,
                modes: deriveDefaultMeta(c).activationModes,
                priority: c.priority,
            })),
        });
    }

    const currentIds = new Set(chunks.map(c => c.id));
    for (const existingId of existingIds) {
        if (!currentIds.has(existingId)) {
            await embeddingStorage.deleteByTypeAndId(campaignId, 'rule', existingId).catch(() => {});
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

export { deriveDefaultMeta };