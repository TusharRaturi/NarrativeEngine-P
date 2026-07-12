import { describe, it, expect } from 'vitest';
import { retrieveRelevantLore } from '../lore';
import type { LoreChunk } from '../../types';

const makeChunk = (
    id: string,
    triggerKeywords: string[],
    opts: Partial<LoreChunk> = {}
): LoreChunk => ({
    id,
    header: `Header for ${id}`,
    content: `Content about ${id}`,
    tokens: 50,
    alwaysInclude: false,
    triggerKeywords,
    scanDepth: 2,
    category: 'character',
    linkedEntities: [],
    priority: 5,
    ...opts,
});

describe('retrieveRelevantLore — activation modes', () => {
    it('always mode: always includes chunk regardless of keywords or semantic hits', () => {
        const chunk = makeChunk('always-1', [], {
            activationModes: ['always'],
        });
        const result = retrieveRelevantLore([chunk], 'totally unrelated message');
        expect(result).toContainEqual(expect.objectContaining({ id: 'always-1' }));
    });

    it('keyword-only mode: requires keyword match to be included', () => {
        const chunk = makeChunk('kw-only', ['dragon'], {
            activationModes: ['keyword'],
        });
        const result1 = retrieveRelevantLore([chunk], 'a dragon appeared');
        expect(result1).toContainEqual(expect.objectContaining({ id: 'kw-only' }));

        const result2 = retrieveRelevantLore([chunk], 'nothing relevant here');
        expect(result2).not.toContainEqual(expect.objectContaining({ id: 'kw-only' }));
    });

    it('vector-only mode: requires semantic hit to be included', () => {
        const chunk = makeChunk('vec-only', ['dragon'], {
            activationModes: ['vector'],
        });
        const result1 = retrieveRelevantLore([chunk], 'nothing relevant here');
        expect(result1).not.toContainEqual(expect.objectContaining({ id: 'vec-only' }));

        const result2 = retrieveRelevantLore([chunk], 'nothing relevant here', 1200, [], ['vec-only']);
        expect(result2).toContainEqual(expect.objectContaining({ id: 'vec-only' }));
    });

    it('vector+keyword mode: keyword match alone and semantic hit alone both score', () => {
        const chunk = makeChunk('both', ['dragon'], {
            activationModes: ['vector', 'keyword'],
        });
        const result1 = retrieveRelevantLore([chunk], 'a dragon appeared');
        expect(result1).toContainEqual(expect.objectContaining({ id: 'both' }));

        const result2 = retrieveRelevantLore([chunk], 'nothing relevant here', 1200, [], ['both']);
        expect(result2).toContainEqual(expect.objectContaining({ id: 'both' }));
    });

    it('legacy behavior: undefined activationModes = vector+keyword (hybrid)', () => {
        const chunk = makeChunk('legacy', ['dragon'], {
        });
        const result1 = retrieveRelevantLore([chunk], 'a dragon appeared');
        expect(result1).toContainEqual(expect.objectContaining({ id: 'legacy' }));

        const result2 = retrieveRelevantLore([chunk], 'nothing relevant here', 1200, [], ['legacy']);
        expect(result2).toContainEqual(expect.objectContaining({ id: 'legacy' }));
    });

    it('legacy alwaysInclude respected when activationModes undefined', () => {
        const chunk = makeChunk('legacy-always', [], {
            alwaysInclude: true,
        });
        const result = retrieveRelevantLore([chunk], 'unrelated');
        expect(result).toContainEqual(expect.objectContaining({ id: 'legacy-always' }));
    });

    it('activationModes always takes precedence over legacy alwaysInclude', () => {
        const chunk = makeChunk('override', ['dragon'], {
            alwaysInclude: true,
            activationModes: ['keyword'],
        });
        const result = retrieveRelevantLore([chunk], 'unrelated message');
        expect(result).not.toContainEqual(expect.objectContaining({ id: 'override' }));
    });

    it('keyword-only chunk excluded by secondary keyword AND-gate', () => {
        const chunk = makeChunk('kw-and-sec', ['dragon'], {
            activationModes: ['keyword'],
            secondaryKeywords: ['fortress'],
        });
        const result = retrieveRelevantLore([chunk], 'the dragon appeared');
        expect(result).not.toContainEqual(expect.objectContaining({ id: 'kw-and-sec' }));
    });

    it('keyword-only chunk included when secondary AND-gate satisfied', () => {
        const chunk = makeChunk('kw-and-sec-ok', ['dragon'], {
            activationModes: ['keyword'],
            secondaryKeywords: ['fortress'],
        });
        const result = retrieveRelevantLore([chunk], 'the dragon fortress');
        expect(result).toContainEqual(expect.objectContaining({ id: 'kw-and-sec-ok' }));
    });

    it('secondary-key AND-gate bypassed for semantic-only path', () => {
        const chunk = makeChunk('semantic-bypass', ['nevermatchesxyz'], {
            activationModes: ['vector', 'keyword'],
            secondaryKeywords: ['alsonomatch'],
        });
        const result = retrieveRelevantLore(
            [chunk],
            'completely unrelated sentence',
            1200,
            [],
            ['semantic-bypass']
        );
        expect(result).toContainEqual(expect.objectContaining({ id: 'semantic-bypass' }));
    });
});

describe('retrieveRelevantLore — secondary-key AND-gate (legacy compat)', () => {
    it('does NOT retrieve a chunk when primary keyword matches but secondary keywords are absent', () => {
        const chunk = makeChunk('chunk-1', ['drakmoor'], {
            secondaryKeywords: ['fortress', 'siege'],
        });
        const result = retrieveRelevantLore([chunk], 'I went to drakmoor yesterday');
        expect(result).not.toContainEqual(expect.objectContaining({ id: 'chunk-1' }));
    });

    it('retrieves a chunk when both primary AND at least one secondary keyword are present', () => {
        const chunk = makeChunk('chunk-2', ['drakmoor'], {
            secondaryKeywords: ['fortress', 'siege'],
        });
        const result = retrieveRelevantLore([chunk], 'The siege of drakmoor began at dawn');
        expect(result).toContainEqual(expect.objectContaining({ id: 'chunk-2' }));
    });

    it('retrieves a chunk via semantic-only path even when secondary keywords are NOT satisfied', () => {
        const chunk = makeChunk('chunk-4', ['nevermatches'], {
            secondaryKeywords: ['alsonevermatches'],
        });
        const result = retrieveRelevantLore([chunk], 'a completely unrelated sentence here', 1200, [], ['chunk-4']);
        expect(result).toContainEqual(expect.objectContaining({ id: 'chunk-4' }));
    });

    it('retrieves a chunk with primary keyword match and NO secondaryKeywords field', () => {
        const chunk = makeChunk('chunk-5', ['goldenveil']);
        const result = retrieveRelevantLore([chunk], 'the goldenveil guild is nearby');
        expect(result).toContainEqual(expect.objectContaining({ id: 'chunk-5' }));
    });
});

describe('retrieveRelevantLore — IDF weighting', () => {
    it('rare keyword chunk outranks common keyword chunk', () => {
        // Create a corpus where 'the' appears in many chunks, 'ironwall' in few
        const commonChunks: LoreChunk[] = [];
        for (let i = 0; i < 8; i++) {
            commonChunks.push(makeChunk(`common-${i}`, ['the', 'guard', 'attack'], {
                activationModes: ['keyword'],
            }));
        }
        // Rare distinctive keyword
        const rareChunk = makeChunk('rare-1', ['ironwall', 'concentration'], {
            activationModes: ['keyword'],
        });
        // Common-keyword chunk
        const commonMatch = makeChunk('common-match', ['the', 'guard'], {
            activationModes: ['keyword'],
        });

        const allChunks = [...commonChunks, rareChunk, commonMatch];

        // Query mentions both "the" and "ironwall"
        const result = retrieveRelevantLore(allChunks, 'the ironwall guard', 1200, []);

        // The rare chunk should rank ahead of common-match because 'ironwall' has higher IDF
        const rareIdx = result.findIndex(c => c.id === 'rare-1');
        const commonIdx = result.findIndex(c => c.id === 'common-match');
        expect(rareIdx).toBeGreaterThanOrEqual(0);
        expect(commonIdx).toBeGreaterThanOrEqual(0);
        expect(rareIdx).toBeLessThan(commonIdx);
    });
});

describe('retrieveRelevantLore — RRF fusion', () => {
    it('chunk present in both keyword and embedding lists ranks above single-list chunks', () => {
        const chunk1 = makeChunk('dual', ['dragon'], { activationModes: ['vector', 'keyword'] });
        const chunk2 = makeChunk('embed-only', ['xyzunmatch'], { activationModes: ['vector'] });
        const chunk3 = makeChunk('kw-only', ['sword'], { activationModes: ['keyword'] });

        // Query matches 'dragon' and 'sword' keywords; 'dual' also has semantic hit
        const result = retrieveRelevantLore(
            [chunk1, chunk2, chunk3],
            'dragon sword',
            1200,
            [],
            ['dual', 'embed-only']
        );

        // 'dual' appears in both lists → RRF consensus should push it top
        const dualIdx = result.findIndex(c => c.id === 'dual');
        expect(dualIdx).toBe(0);
    });

    it('token budget is respected', () => {
        const chunks: LoreChunk[] = [];
        for (let i = 0; i < 20; i++) {
            chunks.push(makeChunk(`kw-${i}`, [`keyword${i}`], {
                activationModes: ['keyword'],
                tokens: 100,
            }));
        }

        const result = retrieveRelevantLore(chunks, 'keyword0 keyword1 keyword2', 250);
        const totalTokens = result.reduce((sum, c) => sum + c.tokens, 0);
        expect(totalTokens).toBeLessThanOrEqual(250);
    });

    it('linked-entity Pass 2 still works after IDF+RRF', () => {
        const mainChunk = makeChunk('main', ['dragon'], {
            activationModes: ['keyword'],
            linkedEntities: ['Drakmoor'],
        });
        const linkedChunk = makeChunk('drakmoor-fortress', ['nevermatch'], {
            activationModes: ['keyword'],
            tokens: 30,
        });
        linkedChunk.header = 'Drakmoor Fortress';

        const result = retrieveRelevantLore(
            [mainChunk, linkedChunk],
            'dragon',
            200
        );

        // mainChunk should be included via keywords, linkedChunk via entity cross-pull
        const ids = result.map(c => c.id);
        expect(ids).toContain('main');
        expect(ids).toContain('drakmoor-fortress');
    });
});

describe('retrieveRelevantLore — embedder-absent fallback', () => {
    it('falls back to keyword-only order when semanticLoreIds is undefined', () => {
        const rareChunk = makeChunk('rare-idf', ['ironwall'], { activationModes: ['keyword'] });
        const commonChunk = makeChunk('common-idf', ['the'], { activationModes: ['keyword'] });

        // Seed corpus so 'the' is common and 'ironwall' is rare
        const fillerChunks: LoreChunk[] = [];
        for (let i = 0; i < 8; i++) {
            fillerChunks.push(makeChunk(`filler-${i}`, ['the'], { activationModes: ['keyword'] }));
        }

        const allChunks = [...fillerChunks, rareChunk, commonChunk];

        // No semantic IDs → pure keyword fallback with IDF
        const result = retrieveRelevantLore(allChunks, 'the ironwall', 1200, [], undefined);

        const rareIdx = result.findIndex(c => c.id === 'rare-idf');
        const commonIdx = result.findIndex(c => c.id === 'common-idf');
        expect(rareIdx).toBeGreaterThanOrEqual(0);
        expect(commonIdx).toBeGreaterThanOrEqual(0);
        expect(rareIdx).toBeLessThan(commonIdx);
    });

    it('falls back to keyword-only order when semanticLoreIds is empty', () => {
        const chunk = makeChunk('kw-fallback', ['dragon'], { activationModes: ['keyword'] });

        const result = retrieveRelevantLore([chunk], 'dragon attack', 1200, [], []);
        expect(result).toContainEqual(expect.objectContaining({ id: 'kw-fallback' }));
    });
});