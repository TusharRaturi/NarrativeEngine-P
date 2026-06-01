import type { ArchiveChapter, ProviderConfig, EndpointConfig } from '../../types';
import { countTokens } from '../tokenizer';
import { extractJson } from '../payloadBuilder';
import { llmCall } from '../../utils/llmCall';
import { truncateScenesToBudget, CHAPTER_SUMMARY_TOKEN_BUDGET } from './shared';

// ─── Chapter Summary Generator ───

export type ChapterSummaryOutput = {
    title: string;
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
    const truncated = truncateScenesToBudget(scenes, CHAPTER_SUMMARY_TOKEN_BUDGET);
    const sceneContent = truncated.map(s => `--- SCENE ${s.sceneId} ---\n${s.content}`).join('\n\n');
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
    maxRetries = 1
): Promise<ChapterSummaryOutput | null> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const prompt = attempt === 0
            ? buildChapterSummaryPrompt(chapter, scenes, headerIndex)
            : buildChapterSummaryPrompt(chapter, scenes, headerIndex) +
            '\n\nPREVIOUS ATTEMPT FAILED. Output ONLY valid JSON with all required fields.';

        console.log(`[SaveFileEngine] Generating Chapter Summary... (Attempt ${attempt + 1})`, {
            chapterId: chapter.chapterId,
            sceneCount: scenes.length,
            promptTokens: countTokens(prompt)
        });

        const output = await llmCall(provider, prompt, { priority: 'low' });
        const result = parseChapterSummaryOutput(output);

        if (result) {
            return result;
        }
        console.warn(`[SaveFileEngine] Chapter Summary attempt ${attempt + 1} failed parsing`);
    }

    return null;
}
