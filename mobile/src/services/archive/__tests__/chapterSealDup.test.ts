import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { sealChapter } from '../archiveChapterEngine';
import { chapterStorage } from '../../storage/chapterStorage';
import { del, get as idbGet } from 'idb-keyval';
import type { ArchiveChapter } from '../../../types';

function makeOpenChapter(overrides: Partial<ArchiveChapter> = {}): ArchiveChapter {
    return {
        chapterId: 'CH01',
        title: 'Chapter 1',
        sceneRange: ['001', '025'],
        sceneIds: ['001', '002', '003', '024', '025'],
        summary: '', keywords: [], npcs: [], majorEvents: [], unresolvedThreads: [],
        tone: '', themes: [], sceneCount: 5,
        ...overrides,
    } as ArchiveChapter;
}

describe('B4 — sealChapter dedupes sceneIds and reconciles sceneCount', () => {
    it('collapses a duplicate boundary scene id on seal', () => {
        // Simulate the bug: scene 025 (the boundary) recorded twice in the open chapter.
        const open = makeOpenChapter({
            sceneIds: ['001', '002', '003', '024', '025', '025'],
            sceneCount: 6, // inflated by the dup
        });
        const chapters = [open];

        const { sealedChapter } = sealChapter(chapters);
        expect(sealedChapter.sceneIds).toEqual(['001', '002', '003', '024', '025']);
        expect(sealedChapter.sceneIds.length).toBe(5);
        expect(sealedChapter.sceneCount).toBe(5);
        expect(sealedChapter.sceneCount).toBe(sealedChapter.sceneIds.length);
    });

    it('a clean chapter (no dup) is unchanged by the dedupe', () => {
        const open = makeOpenChapter({ sceneIds: ['001', '002', '003'], sceneCount: 3 });
        const { sealedChapter } = sealChapter([open]);
        expect(sealedChapter.sceneIds).toEqual(['001', '002', '003']);
        expect(sealedChapter.sceneCount).toBe(3);
        expect(sealedChapter.sealedAt).toBeDefined();
    });
});

describe('B4 — chapterStorage.seal dedupes + the append path does not double-record', () => {
    beforeEach(async () => {
        await del('b4-test_chapters');
        await del('b4-test_scenes');
        await del('b4-test_archive_index');
    });

    it('chapterStorage.seal dedupes sceneIds and reconciles sceneCount', async () => {
        const { setList, k } = await import('../../storage/_helpers');
        const open = makeOpenChapter({
            chapterId: 'CH01',
            sceneRange: ['001', '025'],
            sceneIds: ['001', '002', '025', '025'], // 025 dup
            sceneCount: 4,
        });
        await setList(k('b4-test', 'chapters'), [open]);

        const result = await chapterStorage.seal('b4-test');
        expect(result).not.toBeNull();
        expect(result!.sealedChapter.sceneIds).toEqual(['001', '002', '025']);
        expect(result!.sealedChapter.sceneIds.length).toBe(3);
        expect(result!.sealedChapter.sceneCount).toBe(3);
        expect(result!.sealedChapter.sceneCount).toBe(result!.sealedChapter.sceneIds.length);
        // new open chapter starts clean
        expect(result!.newOpenChapter.sceneIds).toEqual([]);
        expect(result!.newOpenChapter.sceneCount).toBe(0);
    });

    it('archive.append does not push the boundary scene twice into a fresh open chapter', async () => {
        const { setList, k } = await import('../../storage/_helpers');
        // Simulate the post-seal state: a fresh open chapter whose sceneRange is seeded
        // to the next scene id, with sceneIds pre-seeded with that id (the legacy backfill
        // path). The append guard must not push it again.
        const open = makeOpenChapter({
            chapterId: 'CH02',
            sealedAt: undefined,
            sceneRange: ['026', '026'],
            sceneIds: ['026'], // pre-seeded (e.g. by a legacy backfill)
            sceneCount: 0,
        });
        await setList(k('b4-test', 'chapters'), [open]);
        // Seed 25 scenes so appendCore produces sceneId '026'.
        const scenes = Array.from({ length: 25 }, (_, i) => ({
            sceneId: String(i + 1).padStart(3, '0'),
            userContent: 'u', assistantContent: 'a', timestamp: 0,
        }));
        await setList(k('b4-test', 'scenes'), scenes);

        const { offlineStorage } = await import('../../storage/index');
        await offlineStorage.archive.append('b4-test', 'new user', 'new assistant');

        const onDisk = await idbGet<ArchiveChapter[]>('b4-test_chapters');
        const ch02 = onDisk!.find(c => c.chapterId === 'CH02')!;
        // The boundary scene '026' must appear exactly once.
        const count026 = ch02.sceneIds.filter((id: string) => id === '026').length;
        expect(count026).toBe(1);
        expect(ch02.sceneIds).toEqual(['026']);
        expect(ch02.sceneCount).toBe(1);
    });
});