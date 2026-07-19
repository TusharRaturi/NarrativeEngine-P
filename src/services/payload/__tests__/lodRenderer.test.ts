import { describe, it, expect } from 'vitest';
import { renderLodChapters } from '../lodRenderer';
import { countTokens } from '../../infrastructure/tokenizer';
import type { ArchiveChapter, ArchiveIndexEntry, ChatMessage } from '../../../types';

// ─────────────────────────────────────────────────────────────────────────────
// WO-08 — tests for the pure LOD chapter renderer.
// Covers: tier split, importance-bonus promotion, witness exclusion, broadcast
// inclusion, synopsis fallback chain, demotion cascade, determinism, dedup rule.
// ─────────────────────────────────────────────────────────────────────────────

function mkChapter(over: Partial<ArchiveChapter> & { chapterId: string }): ArchiveChapter {
    return {
        title: `Chapter ${over.chapterId}`,
        sceneRange: [over.chapterId.replace('CH', '').padStart(3, '0'), over.chapterId.replace('CH', '').padStart(3, '0')],
        sceneIds: [over.chapterId.replace('CH', '').padStart(3, '0')],
        summary: `Summary of ${over.chapterId}.`,
        keywords: [],
        npcs: [],
        majorEvents: [],
        unresolvedThreads: [],
        tone: '',
        themes: [],
        sceneCount: 1,
        sealedAt: 1,
        ...over,
    } as ArchiveChapter;
}

function mkIndexEntry(sceneId: string, over: Partial<ArchiveIndexEntry> = {}): ArchiveIndexEntry {
    return {
        sceneId,
        timestamp: 0,
        keywords: [],
        npcsMentioned: [],
        witnesses: [],
        userSnippet: '',
        ...over,
    } as ArchiveIndexEntry;
}

function mkMessage(sceneId: string | undefined, role: 'user' | 'assistant' = 'assistant'): ChatMessage {
    return {
        id: `msg_${sceneId ?? 'none'}_${Math.random().toString(36).slice(2, 8)}`,
        role,
        content: 'x',
        timestamp: 0,
        sceneId,
    } as ChatMessage;
}

const DEFAULT_CONFIG = { summaryChapters: 7, importanceBonus: 2 };

describe('WO-08 — renderLodChapters', () => {
    function broadcastIndex(sceneIds: string[]): ArchiveIndexEntry[] {
        return sceneIds.map(s => mkIndexEntry(s, { witnesses: [] }));
    }

    it('tier split: most-recent sealed chapters → summary, older → synopsis', () => {
        // Build a 4-chapter sealed campaign; the open chapter is unsealed.
        const sealed: ArchiveChapter[] = [
            mkChapter({ chapterId: 'CH01', sceneRange: ['001', '003'], sceneIds: ['001', '002', '003'] }),
            mkChapter({ chapterId: 'CH02', sceneRange: ['004', '006'], sceneIds: ['004', '005', '006'] }),
            mkChapter({ chapterId: 'CH03', sceneRange: ['007', '009'], sceneIds: ['007', '008', '009'] }),
            mkChapter({ chapterId: 'CH04', sceneRange: ['010', '012'], sceneIds: ['010', '011', '012'] }),
        ];
        // Boundary at scene 012 (all four chapters wholly behind).
        const msgs: ChatMessage[] = [];
        for (let i = 1; i <= 12; i++) msgs.push(mkMessage(String(i).padStart(3, '0')));
        const archiveIndex = broadcastIndex(['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012']);

        const result = renderLodChapters({
            chapters: sealed,
            archiveIndex,
            onStageNpcIds: ['npc_a'],
            condensedUpToIndex: 11,
            messages: msgs,
            budgetTokens: 100000,
            config: { summaryChapters: 2, importanceBonus: 0 },
        });
        // Newest 2 by effective age → summary: CH04, CH03. Older → synopsis: CH01, CH02.
        expect(result.tierByChapterId['CH04']).toBe('summary');
        expect(result.tierByChapterId['CH03']).toBe('summary');
        expect(result.tierByChapterId['CH02']).toBe('synopsis');
        expect(result.tierByChapterId['CH01']).toBe('synopsis');
    });

    it('importance-bonus promotion: a high-importance older chapter gets summary tier', () => {
        const sealed: ArchiveChapter[] = [
            mkChapter({ chapterId: 'CH01', sceneRange: ['001', '003'], sceneIds: ['001', '002', '003'] }),
            mkChapter({ chapterId: 'CH02', sceneRange: ['004', '006'], sceneIds: ['004', '005', '006'] }),
            mkChapter({ chapterId: 'CH03', sceneRange: ['007', '009'], sceneIds: ['007', '008', '009'] }),
            mkChapter({ chapterId: 'CH04', sceneRange: ['010', '012'], sceneIds: ['010', '011', '012'] }),
        ];
        const msgs: ChatMessage[] = [];
        for (let i = 1; i <= 12; i++) msgs.push(mkMessage(String(i).padStart(3, '0')));
        // CH01 has a scene with importance 9 → bonus −2 to its effective age.
        const archiveIndex: ArchiveIndexEntry[] = [
            ...broadcastIndex(['002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012']),
            mkIndexEntry('001', { importance: 9, witnesses: [] }),
        ];
        // summaryChapters = 2; without the bonus the summaries would be CH04 + CH03.
        // With the bonus, CH01's effective age = (4-1-0) − 2 = 1, tied with CH03's
        // (4-2-0) = 2... CH01's age = 1, CH03's age = 2, CH04's age = 0 → CH01 and
        // CH04 get summary tier.
        const result = renderLodChapters({
            chapters: sealed,
            archiveIndex,
            onStageNpcIds: ['npc_a'],
            condensedUpToIndex: 11,
            messages: msgs,
            budgetTokens: 100000,
            config: { summaryChapters: 2, importanceBonus: 2 },
        });
        expect(result.tierByChapterId['CH04']).toBe('summary');
        expect(result.tierByChapterId['CH01']).toBe('summary');
        expect(result.tierByChapterId['CH03']).toBe('synopsis');
        expect(result.tierByChapterId['CH02']).toBe('synopsis');
    });

    it('witness exclusion: a chapter whose scenes were all witnessed only by off-stage NPCs is excluded', () => {
        const sealed: ArchiveChapter[] = [
            mkChapter({ chapterId: 'CH01', sceneRange: ['001', '003'], sceneIds: ['001', '002', '003'] }),
        ];
        const msgs: ChatMessage[] = [];
        for (let i = 1; i <= 3; i++) msgs.push(mkMessage(String(i).padStart(3, '0')));
        const archiveIndex: ArchiveIndexEntry[] = [
            mkIndexEntry('001', { witnesses: ['npc_offstage'] }),
            mkIndexEntry('002', { witnesses: ['npc_offstage'] }),
            mkIndexEntry('003', { witnesses: ['npc_offstage'] }),
        ];
        const result = renderLodChapters({
            chapters: sealed,
            archiveIndex,
            onStageNpcIds: ['npc_onstage'],
            condensedUpToIndex: 2,
            messages: msgs,
            budgetTokens: 100000,
            config: DEFAULT_CONFIG,
        });
        expect(result.tierByChapterId['CH01']).toBeUndefined();
        expect(result.text).toBe('');
        expect(result.tokens).toBe(0);
    });

    it('broadcast inclusion: a chapter whose scenes have no witness data is always included', () => {
        const sealed: ArchiveChapter[] = [
            mkChapter({ chapterId: 'CH01', sceneRange: ['001', '003'], sceneIds: ['001', '002', '003'] }),
        ];
        const msgs: ChatMessage[] = [];
        for (let i = 1; i <= 3; i++) msgs.push(mkMessage(String(i).padStart(3, '0')));
        const archiveIndex: ArchiveIndexEntry[] = [
            mkIndexEntry('001', { witnesses: [] }),
            mkIndexEntry('002', { witnesses: [] }),
            mkIndexEntry('003', { witnesses: [] }),
        ];
        const result = renderLodChapters({
            chapters: sealed,
            archiveIndex,
            onStageNpcIds: [], // empty on-stage cast — broadcast scenes still pass
            condensedUpToIndex: 2,
            messages: msgs,
            budgetTokens: 100000,
            config: DEFAULT_CONFIG,
        });
        expect(result.tierByChapterId['CH01']).toBe('summary');
        expect(result.text).toContain('Chapter CH01 — Chapter CH01');
    });

    it('synopsis fallback chain: synopsis ?? first sentence of summary ?? title', () => {
        const sealed: ArchiveChapter[] = [
            mkChapter({
                chapterId: 'CH01',
                sceneRange: ['001', '003'],
                sceneIds: ['001', '002', '003'],
                title: 'The Fall',
                summary: 'First sentence here. Second sentence omitted.',
                synopsis: undefined,
                literalTitle: undefined,
            }),
        ];
        const msgs: ChatMessage[] = [];
        for (let i = 1; i <= 3; i++) msgs.push(mkMessage(String(i).padStart(3, '0')));
        const archiveIndex = broadcastIndex(['001', '002', '003']);
        // Force synopsis tier by setting summaryChapters = 0.
        const result = renderLodChapters({
            chapters: sealed,
            archiveIndex,
            onStageNpcIds: ['npc_a'],
            condensedUpToIndex: 2,
            messages: msgs,
            budgetTokens: 100000,
            config: { summaryChapters: 0, importanceBonus: 0 },
        });
        expect(result.tierByChapterId['CH01']).toBe('synopsis');
        // Fallback: first sentence of summary ("First sentence here.")
        expect(result.text).toBe('Chapter CH01 — The Fall\nFirst sentence here.');
    });

    it('synopsis fallback to title when summary is empty', () => {
        const sealed: ArchiveChapter[] = [
            mkChapter({
                chapterId: 'CH01',
                sceneRange: ['001', '003'],
                sceneIds: ['001', '002', '003'],
                title: 'The Fall',
                summary: '',
                synopsis: undefined,
                literalTitle: undefined,
            }),
        ];
        const msgs: ChatMessage[] = [];
        for (let i = 1; i <= 3; i++) msgs.push(mkMessage(String(i).padStart(3, '0')));
        const archiveIndex = broadcastIndex(['001', '002', '003']);
        const result = renderLodChapters({
            chapters: sealed,
            archiveIndex,
            onStageNpcIds: ['npc_a'],
            condensedUpToIndex: 2,
            messages: msgs,
            budgetTokens: 100000,
            config: { summaryChapters: 0, importanceBonus: 0 },
        });
        expect(result.tierByChapterId['CH01']).toBe('synopsis');
        expect(result.text).toBe('Chapter CH01 — The Fall\nThe Fall');
    });

    it('synopsis tier uses literalTitle when provided', () => {
        const sealed: ArchiveChapter[] = [
            mkChapter({
                chapterId: 'CH01',
                sceneRange: ['001', '003'],
                sceneIds: ['001', '002', '003'],
                title: 'Stored Title',
                summary: 'Summary body.',
                synopsis: 'Short synopsis.',
                literalTitle: 'The Literal Title',
            }),
        ];
        const msgs: ChatMessage[] = [];
        for (let i = 1; i <= 3; i++) msgs.push(mkMessage(String(i).padStart(3, '0')));
        const archiveIndex = broadcastIndex(['001', '002', '003']);
        const result = renderLodChapters({
            chapters: sealed,
            archiveIndex,
            onStageNpcIds: ['npc_a'],
            condensedUpToIndex: 2,
            messages: msgs,
            budgetTokens: 100000,
            config: { summaryChapters: 0, importanceBonus: 0 },
        });
        expect(result.text).toContain('Chapter CH01 — The Literal Title');
        expect(result.text).toContain('Short synopsis.');
    });

    it('summary tier uses `title` (not literalTitle) and `summary`', () => {
        const sealed: ArchiveChapter[] = [
            mkChapter({
                chapterId: 'CH01',
                sceneRange: ['001', '003'],
                sceneIds: ['001', '002', '003'],
                title: 'Stored Title',
                summary: 'Summary body.',
                synopsis: 'Should not appear in summary tier.',
                literalTitle: 'Should not appear in summary tier.',
            }),
        ];
        const msgs: ChatMessage[] = [];
        for (let i = 1; i <= 3; i++) msgs.push(mkMessage(String(i).padStart(3, '0')));
        const archiveIndex = broadcastIndex(['001', '002', '003']);
        const result = renderLodChapters({
            chapters: sealed,
            archiveIndex,
            onStageNpcIds: ['npc_a'],
            condensedUpToIndex: 2,
            messages: msgs,
            budgetTokens: 100000,
            config: { summaryChapters: 7, importanceBonus: 0 },
        });
        expect(result.tierByChapterId['CH01']).toBe('summary');
        expect(result.text).toBe('Chapter CH01 — Stored Title\nSummary body.');
    });

    it('demotion cascade: over-budget demotes oldest summary → synopsis first', () => {
        // Use distinct summary vs synopsis bodies so the cascade actually
        // reduces the token count when a chapter demotes.
        const sealed: ArchiveChapter[] = [
            mkChapter({
                chapterId: 'CH01', sceneRange: ['001', '003'], sceneIds: ['001', '002', '003'],
                summary: 'CH01 long detailed summary body with several words filling it out.',
                synopsis: 'CH01 short.',
            }),
            mkChapter({
                chapterId: 'CH02', sceneRange: ['004', '006'], sceneIds: ['004', '005', '006'],
                summary: 'CH02 long detailed summary body with several words filling it out.',
                synopsis: 'CH02 short.',
            }),
            mkChapter({
                chapterId: 'CH03', sceneRange: ['007', '009'], sceneIds: ['007', '008', '009'],
                summary: 'CH03 long detailed summary body with several words filling it out.',
                synopsis: 'CH03 short.',
            }),
        ];
        const msgs: ChatMessage[] = [];
        for (let i = 1; i <= 9; i++) msgs.push(mkMessage(String(i).padStart(3, '0')));
        const archiveIndex = broadcastIndex(['001', '002', '003', '004', '005', '006', '007', '008', '009']);

        // Measure: tokens when CH01 is synopsis and CH02/CH03 are summary (the
        // exact post-demotion shape we want). Set the budget to that value so the
        // cascade stops exactly after demoting CH01. We construct the target
        // shape directly by setting summaryChapters = 2 (CH02 + CH03 are the two
        // newest → summary; CH01 → synopsis by default).
        const target = renderLodChapters({
            chapters: sealed, archiveIndex, onStageNpcIds: ['npc_a'],
            condensedUpToIndex: 8, messages: msgs,
            budgetTokens: 100000, config: { summaryChapters: 2, importanceBonus: 0 },
        });
        // Sanity: that target has CH01 synopsis, CH02/CH03 summary.
        expect(target.tierByChapterId['CH01']).toBe('synopsis');
        expect(target.tierByChapterId['CH02']).toBe('summary');

        // Now run with summaryChapters = 3 (all summary) but a budget that
        // exactly equals the target's token count. The cascade must demote
        // oldest summaries until tokens ≤ budget — which requires demoting CH01.
        const result = renderLodChapters({
            chapters: sealed,
            archiveIndex,
            onStageNpcIds: ['npc_a'],
            condensedUpToIndex: 8,
            messages: msgs,
            budgetTokens: target.tokens,
            config: { summaryChapters: 3, importanceBonus: 0 },
        });
        expect(result.tierByChapterId['CH01']).toBe('synopsis');
        expect(result.tierByChapterId['CH02']).toBe('summary');
        expect(result.tierByChapterId['CH03']).toBe('summary');
        expect(result.tokens).toBeLessThanOrEqual(target.tokens);
    });

    it('demotion cascade: still over-budget after all demoted → drop oldest synopsis first', () => {
        const sealed: ArchiveChapter[] = [
            mkChapter({
                chapterId: 'CH01', sceneRange: ['001', '003'], sceneIds: ['001', '002', '003'],
                summary: 'CH01 long detailed summary body with several words.',
                synopsis: 'CH01 short.',
            }),
            mkChapter({
                chapterId: 'CH02', sceneRange: ['004', '006'], sceneIds: ['004', '005', '006'],
                summary: 'CH02 long detailed summary body with several words.',
                synopsis: 'CH02 short.',
            }),
            mkChapter({
                chapterId: 'CH03', sceneRange: ['007', '009'], sceneIds: ['007', '008', '009'],
                summary: 'CH03 long detailed summary body with several words.',
                synopsis: 'CH03 short.',
            }),
        ];
        const msgs: ChatMessage[] = [];
        for (let i = 1; i <= 9; i++) msgs.push(mkMessage(String(i).padStart(3, '0')));
        const archiveIndex = broadcastIndex(['001', '002', '003', '004', '005', '006', '007', '008', '009']);

        // All-synopsis baseline: dropping at least one must reduce tokens.
        const allSyns = renderLodChapters({
            chapters: sealed, archiveIndex, onStageNpcIds: ['npc_a'],
            condensedUpToIndex: 8, messages: msgs,
            budgetTokens: 100000, config: { summaryChapters: 0, importanceBonus: 0 },
        });
        // Budget strictly between "two synopses" and "three synopses" — exactly
        // one drop is required and sufficient.
        const twoChaptersToken = countTokens(
            // Approximate: drop CH01 (oldest). We compute the actual drop-target
            // by checking what the renderer does and asserting one drop occurred.
            // For the budget, use allSyns minus roughly one synopsis body.
            allSyns.text.split('\n\n').slice(1).join('\n\n'),
        );
        const targetBudget = Math.ceil((twoChaptersToken + allSyns.tokens) / 2);

        const result = renderLodChapters({
            chapters: sealed,
            archiveIndex,
            onStageNpcIds: ['npc_a'],
            condensedUpToIndex: 8,
            messages: msgs,
            budgetTokens: targetBudget,
            config: { summaryChapters: 3, importanceBonus: 0 },
        });
        // Oldest synopsis (CH01) drops first.
        expect(result.tierByChapterId['CH01']).toBe('dropped');
        expect(result.tokens).toBeLessThanOrEqual(targetBudget);
    });

    it('determinism: two identical calls produce identical strings', () => {
        const sealed: ArchiveChapter[] = [
            mkChapter({ chapterId: 'CH01', sceneRange: ['001', '003'], sceneIds: ['001', '002', '003'] }),
            mkChapter({ chapterId: 'CH02', sceneRange: ['004', '006'], sceneIds: ['004', '005', '006'] }),
            mkChapter({ chapterId: 'CH03', sceneRange: ['007', '009'], sceneIds: ['007', '008', '009'] }),
        ];
        const msgs: ChatMessage[] = [];
        for (let i = 1; i <= 9; i++) msgs.push(mkMessage(String(i).padStart(3, '0')));
        const archiveIndex = broadcastIndex(['001', '002', '003', '004', '005', '006', '007', '008', '009']);

        const input = {
            chapters: sealed,
            archiveIndex,
            onStageNpcIds: ['npc_a'],
            condensedUpToIndex: 8,
            messages: msgs,
            budgetTokens: 100000,
            config: DEFAULT_CONFIG,
        };
        const r1 = renderLodChapters(input);
        const r2 = renderLodChapters(input);
        expect(r2.text).toBe(r1.text);
        expect(r2.tokens).toBe(r1.tokens);
        expect(r2.tierByChapterId).toEqual(r1.tierByChapterId);
    });

    it('dedup rule: a chapter straddling the condensed boundary is excluded', () => {
        // CH01 covers scenes 001–006, but the boundary is at scene 003 — only
        // scenes 001–003 are condensed. CH01 straddles the boundary → excluded.
        const sealed: ArchiveChapter[] = [
            mkChapter({ chapterId: 'CH01', sceneRange: ['001', '006'], sceneIds: ['001', '002', '003', '004', '005', '006'] }),
        ];
        const msgs: ChatMessage[] = [];
        for (let i = 1; i <= 3; i++) msgs.push(mkMessage(String(i).padStart(3, '0')));
        // Boundary at index 2 — max stamped scene is 003.
        const archiveIndex = broadcastIndex(['001', '002', '003', '004', '005', '006']);
        const result = renderLodChapters({
            chapters: sealed,
            archiveIndex,
            onStageNpcIds: ['npc_a'],
            condensedUpToIndex: 2,
            messages: msgs,
            budgetTokens: 100000,
            config: DEFAULT_CONFIG,
        });
        // chapterEnd (006) > maxStampedScene (003) → not wholly behind → excluded.
        expect(result.tierByChapterId['CH01']).toBeUndefined();
        expect(result.text).toBe('');
    });

    it('open (unsealed) chapter is never rendered', () => {
        const sealed: ArchiveChapter[] = [
            mkChapter({ chapterId: 'CH01', sceneRange: ['001', '003'], sceneIds: ['001', '002', '003'] }),
            mkChapter({ chapterId: 'CH02', sceneRange: ['004', '006'], sceneIds: ['004', '005', '006'] }),
        ];
        // CH02 is the open chapter — unsealed.
        sealed[1].sealedAt = undefined;
        const msgs: ChatMessage[] = [];
        for (let i = 1; i <= 6; i++) msgs.push(mkMessage(String(i).padStart(3, '0')));
        const archiveIndex = broadcastIndex(['001', '002', '003', '004', '005', '006']);
        const result = renderLodChapters({
            chapters: sealed,
            archiveIndex,
            onStageNpcIds: ['npc_a'],
            condensedUpToIndex: 5,
            messages: msgs,
            budgetTokens: 100000,
            config: DEFAULT_CONFIG,
        });
        expect(result.tierByChapterId['CH01']).toBe('summary');
        expect(result.tierByChapterId['CH02']).toBeUndefined();
    });

    it('nothing condensed: no chapters are eligible (conservative "wholly behind" check)', () => {
        const sealed: ArchiveChapter[] = [
            mkChapter({ chapterId: 'CH01', sceneRange: ['001', '003'], sceneIds: ['001', '002', '003'] }),
        ];
        const archiveIndex = broadcastIndex(['001', '002', '003']);
        const result = renderLodChapters({
            chapters: sealed,
            archiveIndex,
            onStageNpcIds: ['npc_a'],
            condensedUpToIndex: -1,
            messages: [],
            budgetTokens: 100000,
            config: DEFAULT_CONFIG,
        });
        expect(result.text).toBe('');
        expect(result.tokens).toBe(0);
    });
});