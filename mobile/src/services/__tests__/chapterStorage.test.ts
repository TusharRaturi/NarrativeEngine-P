import { describe, it, expect } from 'vitest';
import { backfillSceneIds } from '../storage/chapterStorage';
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

describe('backfillSceneIds', () => {
    it('does not mutate chapters that already have sceneIds', () => {
        const chapters: ArchiveChapter[] = [
            baseChapter({ chapterId: 'CH01', title: 'Ch 1', sceneRange: ['001', '010'] as [string, string], sceneIds: ['001', '002', '003'] }),
        ];
        const result = backfillSceneIds(chapters);
        expect(result.changed).toBe(false);
        expect(result.chapters[0].sceneIds).toEqual(['001', '002', '003']);
    });

    it('backfills sceneIds from sceneRange for legacy chapters', () => {
        const chapters: ArchiveChapter[] = [
            baseChapter({ chapterId: 'CH01', title: 'Ch 1', sceneRange: ['001', '041'] as [string, string], sceneIds: [] }),
        ];
        const result = backfillSceneIds(chapters);
        expect(result.changed).toBe(true);
        expect(result.chapters[0].sceneIds).toHaveLength(41);
        expect(result.chapters[0].sceneIds![0]).toBe('001');
        expect(result.chapters[0].sceneIds![40]).toBe('041');
    });

    it('backfills single-scene chapter', () => {
        const chapters: ArchiveChapter[] = [
            baseChapter({ chapterId: 'CH01', title: 'Ch 1', sceneRange: ['042', '042'] as [string, string], sceneIds: [] }),
        ];
        const result = backfillSceneIds(chapters);
        expect(result.changed).toBe(true);
        expect(result.chapters[0].sceneIds).toEqual(['042']);
    });

    it('handles missing sceneIds field (undefined)', () => {
        const chapters: ArchiveChapter[] = [
            baseChapter({ chapterId: 'CH01', title: 'Ch 1', sceneRange: ['001', '005'] as [string, string] } as any),
        ];
        const ch = chapters[0] as any;
        delete ch.sceneIds;
        const result = backfillSceneIds(chapters);
        expect(result.changed).toBe(true);
        expect(result.chapters[0].sceneIds).toEqual(['001', '002', '003', '004', '005']);
    });

    it('returns empty sceneIds for invalid sceneRange', () => {
        const chapters: ArchiveChapter[] = [
            baseChapter({ chapterId: 'CH01', title: 'Ch 1', sceneRange: ['abc', 'xyz'] as [string, string], sceneIds: [] }),
        ];
        const result = backfillSceneIds(chapters);
        expect(result.changed).toBe(false);
        expect(result.chapters[0].sceneIds).toEqual([]);
    });

    it('backfills only the chapters that need it, leaving others untouched', () => {
        const chapters: ArchiveChapter[] = [
            baseChapter({ chapterId: 'CH01', title: 'Legacy', sceneRange: ['001', '010'] as [string, string], sceneIds: [] }),
            baseChapter({ chapterId: 'CH02', title: 'Modern', sceneRange: ['011', '020'] as [string, string], sceneIds: ['011', '012', '013'] }),
        ];
        const result = backfillSceneIds(chapters);
        expect(result.changed).toBe(true);
        expect(result.chapters[0].sceneIds).toHaveLength(10);
        expect(result.chapters[0].sceneIds![0]).toBe('001');
        expect(result.chapters[0].sceneIds![9]).toBe('010');
        expect(result.chapters[1].sceneIds).toEqual(['011', '012', '013']);
    });
});