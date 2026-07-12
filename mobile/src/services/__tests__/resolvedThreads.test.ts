import { describe, it, expect } from 'vitest';
import { computeOpenThreads } from '../payload/payloadWorldContext';
import type { ArchiveChapter } from '../../types';

const baseChapter = (overrides: Partial<ArchiveChapter> & { chapterId: string; title: string }): ArchiveChapter => ({
    sceneRange: ['001', '001'],
    sceneIds: [],
    summary: '',
    keywords: [],
    npcs: [],
    majorEvents: [],
    unresolvedThreads: [],
    tone: '',
    themes: [],
    sceneCount: 1,
    ...overrides,
});

describe('computeOpenThreads', () => {
    it('excludes resolved threads and returns open ones', () => {
        const chapters: ArchiveChapter[] = [
            baseChapter({ chapterId: 'CH01', title: 'Ch 1', unresolvedThreads: ['Thread A', 'Thread B'], resolvedThreads: ['Thread A'] }),
            baseChapter({ chapterId: 'CH02', title: 'Ch 2', unresolvedThreads: ['Thread C'] }),
        ];
        const result = computeOpenThreads(chapters);
        expect(result.map(t => t.text)).toEqual(['Thread B', 'Thread C']);
    });

    it('caps at 12 most recent', () => {
        const threads: string[] = [];
        for (let i = 0; i < 20; i++) threads.push(`Thread ${i}`);
        const chapters: ArchiveChapter[] = [
            baseChapter({ chapterId: 'CH01', title: 'Ch 1', unresolvedThreads: threads }),
        ];
        const result = computeOpenThreads(chapters);
        expect(result).toHaveLength(12);
        expect(result[0].text).toBe('Thread 8');
        expect(result[11].text).toBe('Thread 19');
    });

    it('preserves chapter ids', () => {
        const chapters: ArchiveChapter[] = [
            baseChapter({ chapterId: 'CH01', title: 'Ch 1', unresolvedThreads: ['Thread A'] }),
            baseChapter({ chapterId: 'CH02', title: 'Ch 2', unresolvedThreads: ['Thread B'] }),
        ];
        const result = computeOpenThreads(chapters);
        expect(result.find(t => t.text === 'Thread A')?.chapterId).toBe('CH01');
        expect(result.find(t => t.text === 'Thread B')?.chapterId).toBe('CH02');
    });

    it('returns empty for no threads', () => {
        const chapters: ArchiveChapter[] = [
            baseChapter({ chapterId: 'CH01', title: 'Ch 1' }),
        ];
        expect(computeOpenThreads(chapters)).toEqual([]);
    });

    it('returns empty for empty array', () => {
        expect(computeOpenThreads([])).toEqual([]);
    });

    it('resolved on later chapter excludes from earlier', () => {
        const chapters: ArchiveChapter[] = [
            baseChapter({ chapterId: 'CH01', title: 'Ch 1', unresolvedThreads: ['Thread A'] }),
            baseChapter({ chapterId: 'CH02', title: 'Ch 2', resolvedThreads: ['Thread A'] }),
        ];
        const result = computeOpenThreads(chapters);
        expect(result).toEqual([]);
    });

    it('skips threads from invalidated chapters but honors their resolvedThreads', () => {
        const chapters: ArchiveChapter[] = [
            baseChapter({ chapterId: 'CH01', title: 'Ch 1', unresolvedThreads: ['Thread A'] }),
            baseChapter({ chapterId: 'CH02', title: 'Ch 2', unresolvedThreads: ['Stale thread'], resolvedThreads: ['Thread A'], invalidated: true }),
        ];
        const result = computeOpenThreads(chapters);
        expect(result).toEqual([]);
    });

    it('manual dismiss: appending to resolvedThreads excludes thread', () => {
        const chapters: ArchiveChapter[] = [
            baseChapter({ chapterId: 'CH01', title: 'Ch 1', unresolvedThreads: ['Thread A', 'Thread B'] }),
        ];
        const before = computeOpenThreads(chapters);
        expect(before.map(t => t.text)).toEqual(['Thread A', 'Thread B']);
        const afterDismiss = [
            { ...chapters[0], resolvedThreads: ['Thread A'] },
        ];
        const after = computeOpenThreads(afterDismiss);
        expect(after.map(t => t.text)).toEqual(['Thread B']);
    });
});