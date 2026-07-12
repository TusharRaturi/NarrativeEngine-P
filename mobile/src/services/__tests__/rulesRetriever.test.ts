import { describe, it, expect } from 'vitest';
import { retrieveRelevantRules } from '../lore';
import type { LoreChunk, RuleChunkMeta } from '../../types';

const makeChunk = (
    id: string,
    triggerKeywords: string[],
    opts: Partial<LoreChunk> = {}
): LoreChunk => ({
    id,
    header: `Rule: ${id}`,
    content: `Content for rule ${id}`,
    tokens: 50,
    alwaysInclude: false,
    triggerKeywords,
    scanDepth: 2,
    category: 'rules',
    linkedEntities: [],
    priority: 5,
    ...opts,
});

const makeMeta = (
    id: string,
    overrides: Partial<RuleChunkMeta> = {}
): RuleChunkMeta => ({
    id,
    activationModes: ['vector'],
    ...overrides,
});

describe('retrieveRelevantRules — always mode', () => {
    it('always includes chunks with always activation mode', () => {
        const chunk = makeChunk('always-rule', [], { tokens: 30 });
        const meta: Record<string, RuleChunkMeta> = {
            'always-rule': makeMeta('always-rule', { activationModes: ['always'] }),
        };

        const result = retrieveRelevantRules([chunk], meta, 'unrelated', 500);
        expect(result).toContainEqual(expect.objectContaining({ id: 'always-rule' }));
    });

    it('respects legacy alwaysInclude when no meta', () => {
        const chunk = makeChunk('legacy-always', [], { alwaysInclude: true, tokens: 30 });
        const result = retrieveRelevantRules([chunk], undefined, 'unrelated', 500);
        expect(result).toContainEqual(expect.objectContaining({ id: 'legacy-always' }));
    });
});

describe('retrieveRelevantRules — IDF weighting', () => {
    it('rare keyword outranks common keyword', () => {
        const fillerChunks: LoreChunk[] = [];
        for (let i = 0; i < 10; i++) {
            fillerChunks.push(makeChunk(`filler-${i}`, ['attack', 'roll'], {
                activationModes: ['keyword'],
            }));
        }

        const rareChunk = makeChunk('rare-rule', ['concentration'], {
            activationModes: ['keyword'],
        });
        const commonChunk = makeChunk('common-rule', ['attack'], {
            activationModes: ['keyword'],
        });

        const allChunks = [...fillerChunks, rareChunk, commonChunk];

        const meta: Record<string, RuleChunkMeta> = {};
        for (const c of allChunks) {
            meta[c.id] = makeMeta(c.id, {
                activationModes: ['keyword'],
                triggerKeywords: c.triggerKeywords,
            });
        }

        // Large token budget so both rare and common can be retrieved
        const result = retrieveRelevantRules(allChunks, meta, 'concentration attack roll', 5000);

        const rareIdx = result.findIndex(c => c.id === 'rare-rule');
        const commonIdx = result.findIndex(c => c.id === 'common-rule');
        expect(rareIdx).toBeGreaterThanOrEqual(0);
        expect(commonIdx).toBeGreaterThanOrEqual(0);
        expect(rareIdx).toBeLessThan(commonIdx);
    });
});

describe('retrieveRelevantRules — RRF fusion', () => {
    it('dual-list chunks rank above single-list chunks', () => {
        const dualChunk = makeChunk('dual', ['dragon'], {
            activationModes: ['vector', 'keyword'],
        });
        const embedOnly = makeChunk('embed-only', ['xyznevermatch'], {
            activationModes: ['vector'],
        });
        const kwOnly = makeChunk('kw-only', ['sword'], {
            activationModes: ['keyword'],
        });

        const meta: Record<string, RuleChunkMeta> = {
            'dual': makeMeta('dual', { activationModes: ['vector', 'keyword'] }),
            'embed-only': makeMeta('embed-only', { activationModes: ['vector'] }),
            'kw-only': makeMeta('kw-only', { activationModes: ['keyword'] }),
        };

        const result = retrieveRelevantRules(
            [dualChunk, embedOnly, kwOnly],
            meta,
            'dragon sword',
            500,
            [],
            ['dual', 'embed-only']
        );

        const dualIdx = result.findIndex(c => c.id === 'dual');
        expect(dualIdx).toBe(0);
    });

    it('vector-only chunk with keyword overlap gets reduced keyword weight', () => {
        const vecOnlyChunk = makeChunk('vec-kw', ['dragon'], {
            activationModes: ['vector'],
        });
        const kwChunk = makeChunk('keyword-chunk', ['dragon'], {
            activationModes: ['keyword'],
        });

        const meta: Record<string, RuleChunkMeta> = {
            'vec-kw': makeMeta('vec-kw', { activationModes: ['vector'] }),
            'keyword-chunk': makeMeta('keyword-chunk', { activationModes: ['keyword'] }),
        };

        // No semantic hits → vec-only chunk with keyword overlap gets half IDF weight
        // keyword-chunk gets full IDF weight → should rank higher
        const result = retrieveRelevantRules(
            [vecOnlyChunk, kwChunk],
            meta,
            'dragon',
            500,
            [],
            []
        );

        const kwIdx = result.findIndex(c => c.id === 'keyword-chunk');
        const vecIdx = result.findIndex(c => c.id === 'vec-kw');
        if (kwIdx >= 0 && vecIdx >= 0) {
            expect(kwIdx).toBeLessThan(vecIdx);
        }
    });
});

describe('retrieveRelevantRules — secondary AND-gate', () => {
    it('excludes chunk when secondary keywords not satisfied', () => {
        const chunk = makeChunk('gated', ['combat'], {
            activationModes: ['keyword'],
        });
        const meta: Record<string, RuleChunkMeta> = {
            'gated': makeMeta('gated', {
                activationModes: ['keyword'],
                triggerKeywords: ['combat'],
                secondaryKeywords: ['surprise'],
            }),
        };

        const result = retrieveRelevantRules([chunk], meta, 'combat rules', 500);
        expect(result).not.toContainEqual(expect.objectContaining({ id: 'gated' }));
    });

    it('includes chunk when secondary keywords satisfied', () => {
        const chunk = makeChunk('gated-ok', ['combat'], {
            activationModes: ['keyword'],
        });
        const meta: Record<string, RuleChunkMeta> = {
            'gated-ok': makeMeta('gated-ok', {
                activationModes: ['keyword'],
                triggerKeywords: ['combat'],
                secondaryKeywords: ['surprise'],
            }),
        };

        const result = retrieveRelevantRules([chunk], meta, 'combat surprise attack', 500);
        expect(result).toContainEqual(expect.objectContaining({ id: 'gated-ok' }));
    });
});

describe('retrieveRelevantRules — embedder-absent fallback', () => {
    it('falls back to keyword-only when semanticRuleIds is undefined', () => {
        const chunk = makeChunk('rule-kw', ['grapple'], { activationModes: ['keyword'] });
        const meta: Record<string, RuleChunkMeta> = {
            'rule-kw': makeMeta('rule-kw', { activationModes: ['keyword'], triggerKeywords: ['grapple'] }),
        };

        const result = retrieveRelevantRules([chunk], meta, 'grapple check', 500, [], undefined);
        expect(result).toContainEqual(expect.objectContaining({ id: 'rule-kw' }));
    });

    it('falls back to keyword-only when semanticRuleIds is empty', () => {
        const chunk = makeChunk('rule-kw2', ['stealth'], { activationModes: ['keyword'] });
        const meta: Record<string, RuleChunkMeta> = {
            'rule-kw2': makeMeta('rule-kw2', { activationModes: ['keyword'], triggerKeywords: ['stealth'] }),
        };

        const result = retrieveRelevantRules([chunk], meta, 'stealth check', 500, [], []);
        expect(result).toContainEqual(expect.objectContaining({ id: 'rule-kw2' }));
    });
});

describe('retrieveRelevantRules — token budget', () => {
    it('respects token budget', () => {
        const chunks: LoreChunk[] = [];
        const meta: Record<string, RuleChunkMeta> = {};
        for (let i = 0; i < 20; i++) {
            const id = `rule-${i}`;
            chunks.push(makeChunk(id, [`keyword${i}`], {
                activationModes: ['keyword'],
                tokens: 100,
            }));
            meta[id] = makeMeta(id, { activationModes: ['keyword'], triggerKeywords: [`keyword${i}`] });
        }

        const result = retrieveRelevantRules(chunks, meta, 'keyword0 keyword1 keyword2', 250);
        const totalTokens = result.reduce((sum, c) => sum + c.tokens, 0);
        expect(totalTokens).toBeLessThanOrEqual(250);
    });

    it('returns empty for empty chunks', () => {
        const result = retrieveRelevantRules([], undefined, 'test', 500);
        expect(result).toEqual([]);
    });
});