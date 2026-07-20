import type { ArchiveChapter, ProviderConfig, EndpointConfig } from '../../types';
import { countTokens } from '../infrastructure/tokenizer';
import { extractJson } from '../infrastructure/jsonExtract';
import { llmCall } from '../../utils/llmCall';
import { chunkScenesToBudget, CHAPTER_SUMMARY_TOKEN_BUDGET } from './shared';
import { AI_CALL_TIMEOUT_MS } from '../llm/timeouts';

// ─── Chapter Summary Generator ───

export type ChapterSummaryOutput = {
    title: string;
    // WO-06: optional synopsis/title-variant fields. Ride the existing
    // ...result.summary spread into the chapters PATCH (Option A placement).
    // Missing → undefined silently (old-output + manual-summary compat).
    // Present-but-empty/wrong-type → undefined with one compact warning.
    synopsis?: string;
    abstractTitle?: string;
    literalTitle?: string;
    summary: string;
    keywords: string[];
    npcs: string[];
    majorEvents: string[];
    unresolvedThreads: string[];
    tone: string;
    themes: string[];
};

function buildChapterSummaryPrompt(
    chapter: ArchiveChapter,
    scenes: { sceneId: string; content: string }[],
    headerIndex: string
): string {
    const sceneContent = scenes.map(s => `--- SCENE ${s.sceneId} ---\n${s.content}`).join('\n\n');
    const sceneRangeStr = `${chapter.sceneRange[0]} to ${chapter.sceneRange[1]}`;

    return [
        'You are a TTRPG campaign archivist. Generate a structured chapter summary.',
        '',
        `CHAPTER: ${chapter.title || 'Untitled'}`,
        `SCENES: ${sceneRangeStr} (${chapter.sceneCount} scenes)`,
        '',
        'OUTPUT FORMAT — respond with a JSON object:',
        '{',
        '    "title": "Short evocative chapter title",',
        '    "summary": "4-8 bullet points covering key events, each on its own line starting with `- `",',
        '    "keywords": ["keyword1", "keyword2", ...],',
        '    "npcs": ["NPC Name 1", "NPC Name 2", ...],',
        '    "majorEvents": ["Event description 1", "Event description 2"],',
        '    "unresolvedThreads": ["Thread 1", "Thread 2"],',
        '    "tone": "one of: combat-heavy, exploration, social, mystery, political, emotional, mixed",',
        '    "themes": ["theme1", "theme2"]',
        '}',
        '',
        'RULES:',
        '1. Keywords should be distinctive nouns/places/factions — not generic words',
        '2. NPCs should include all significant named characters who appeared or were discussed',
        '3. Major events are plot-critical beats only (not every combat round)',
        '4. Unresolved threads are open plot hooks, promises, or mysteries',
        '5. Title should be 2-5 words, evocative',
        '6. Summary should read like a campaign journal entry, not a list',
        '',
        'HEADER INDEX REFERENCE (for thread tracking):',
        headerIndex.slice(0, 2000), // Truncate header index if very long
        '',
        'SCENE CONTENT:',
        sceneContent,
    ].join('\n');
}

function buildStitchSummaryPrompt(
    partialSummaries: ChapterSummaryOutput[],
    chapterTitle: string
): string {
    const summariesText = partialSummaries.map((s, i) => `--- CHUNK ${i + 1} SUMMARY ---\n${JSON.stringify(s, null, 2)}`).join('\n\n');
    return [
        'You are a TTRPG campaign archivist.',
        'I have a long chapter broken into chunks. The AI has already generated a summary for each chunk.',
        'Your task is to synthesize these partial chunk summaries into ONE final, cohesive chapter summary.',
        '',
        `CHAPTER: "${chapterTitle || 'Untitled'}"`,
        '',
        'PARTIAL CHUNK SUMMARIES:',
        summariesText,
        '',
        'OUTPUT FORMAT — respond with a JSON object:',
        '{',
        '    "title": "Short evocative chapter title",',
        '    "summary": "4-8 bullet points covering key events, each on its own line starting with `- `",',
        '    "keywords": ["keyword1", "keyword2", ...],',
        '    "npcs": ["NPC Name 1", "NPC Name 2", ...],',
        '    "majorEvents": ["Event description 1", "Event description 2"],',
        '    "unresolvedThreads": ["Thread 1", "Thread 2"],',
        '    "tone": "one of: combat-heavy, exploration, social, mystery, political, emotional, mixed",',
        '    "themes": ["theme1", "theme2"]',
        '}',
        '',
        'RULES:',
        '- Combine all the major characters, events, and threads from the chunks.',
        '- The narrative summary should cover the beginning, middle, and end of the chapter seamlessly.',
    ].join('\n');
}

/**
 * Extract JSON from LLM output, handling markdown fences and common errors.
 */
export function parseChapterSummaryOutput(raw: string): ChapterSummaryOutput | null {
    const cleaned = extractJson(raw.trim());

    try {
        const parsed = JSON.parse(cleaned);

        // Validate required fields
        const required: (keyof ChapterSummaryOutput)[] = [
            'title', 'summary', 'keywords', 'npcs',
            'majorEvents', 'unresolvedThreads', 'tone', 'themes'
        ];

        for (const field of required) {
            if (!(field in parsed)) {
                console.warn(`[ChapterSummary] Missing field: ${field}`);
                parsed[field] = field === 'summary' || field === 'tone' ? '' : [];
            }
        }

        if (Array.isArray(parsed.summary)) parsed.summary = parsed.summary.join('\n');
        if (Array.isArray(parsed.tone)) parsed.tone = parsed.tone.join(', ');

        // WO-06: validate the three optional synopsis/title-variant fields independently.
        // Missing → stay undefined silently (old-output and manual-summary compatibility).
        // Present but empty or wrong type → coerce to undefined with one compact warning.
        // Present and a non-empty string → trim and preserve.
        const OPTIONAL_STRING_FIELDS: (keyof ChapterSummaryOutput)[] = [
            'synopsis', 'abstractTitle', 'literalTitle',
        ];
        for (const field of OPTIONAL_STRING_FIELDS) {
            if (!(field in parsed)) continue;
            const v = parsed[field];
            if (typeof v !== 'string' || v.trim() === '') {
                console.warn(`[ChapterSummary] Optional field "${field}" present but empty/wrong-type — coerced to undefined`);
                delete parsed[field];
                continue;
            }
            parsed[field] = v.trim();
        }

        return parsed as ChapterSummaryOutput;
    } catch (e) {
        console.error('[ChapterSummary] Failed to parse JSON:', e);
        return null;
    }
}

export async function generateChapterSummary(
    provider: ProviderConfig | EndpointConfig,
    chapter: ArchiveChapter,
    scenes: { sceneId: string; content: string }[],
    headerIndex: string,
    maxRetries = 1,
    contextLimit?: number
): Promise<ChapterSummaryOutput | null> {
    const budget = contextLimit && contextLimit > 0 ? contextLimit : CHAPTER_SUMMARY_TOKEN_BUDGET;
    const chunks = chunkScenesToBudget(scenes, budget);

    if (chunks.length === 0) return null;

    const partialSummaries: ChapterSummaryOutput[] = [];

    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
        const chunkScenes = chunks[chunkIdx];
        let chunkResult: ChapterSummaryOutput | null = null;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const prompt = attempt === 0
                ? buildChapterSummaryPrompt(chapter, chunkScenes, headerIndex)
                : buildChapterSummaryPrompt(chapter, chunkScenes, headerIndex) +
                '\n\nPREVIOUS ATTEMPT FAILED. Output ONLY valid JSON with all required fields.';

            console.log(`[SaveFileEngine] Generating Chapter Summary Chunk ${chunkIdx + 1}/${chunks.length}... (Attempt ${attempt + 1})`, {
                chapterId: chapter.chapterId,
                sceneCount: chunkScenes.length,
                promptTokens: countTokens(prompt)
            });

            const output = await llmCall(provider, prompt, { priority: 'low', timeoutMs: AI_CALL_TIMEOUT_MS });
            const result = parseChapterSummaryOutput(output);

            if (result) {
                chunkResult = result;
                break;
            }
            console.warn(`[SaveFileEngine] Chapter Summary Chunk ${chunkIdx + 1} attempt ${attempt + 1} failed parsing`);
        }

        if (chunkResult) {
            partialSummaries.push(chunkResult);
        }
    }

    if (partialSummaries.length === 0) return null;

    if (chunks.length === 1) {
        return partialSummaries[0];
    }

    // Stitch chunks together
    console.log(`[SaveFileEngine] Stitching ${partialSummaries.length} partial summaries...`);
    const stitchPrompt = buildStitchSummaryPrompt(partialSummaries, chapter.title);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const output = await llmCall(provider, stitchPrompt, { priority: 'low', maxTokens: 1000, trackingLabel: 'chapter-seal-stitch', timeoutMs: AI_CALL_TIMEOUT_MS });
        const finalResult = parseChapterSummaryOutput(output);
        if (finalResult) {
            return finalResult;
        }
        console.warn(`[SaveFileEngine] Stitch attempt ${attempt + 1} failed parsing`);
    }

    return null;
}
