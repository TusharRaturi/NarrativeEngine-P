import { describe, it, expect } from 'vitest';
import { parseNPCsFromLore } from '../loreNPCParser';
import type { LoreChunk } from '../../../types';

/** Build a minimal character-classified LoreChunk with the given header + body. */
function charChunk(header: string, content: string): LoreChunk {
    return {
        id: `test-${Math.random().toString(36).slice(2, 8)}`,
        header,
        content,
        tokens: 100,
        alwaysInclude: false,
        triggerKeywords: [],
        category: 'character',
        linkedEntities: [],
        priority: 5,
        scanDepth: 3,
    };
}

const NARUTO_BLOCK = `### CHARACTER — Naruto Uzumaki
**Aliases:** Number One Hyperactive Knucklehead Ninja, The Boy With The Fox
**Appearance:** Spiky blond hair, blue eyes, whisker marks on cheeks. Orange jumpsuit.
**Disposition:** Loud, loyal, stubborn, refuses to give up.
**Personality:** Naruto is driven by a desperate need to be acknowledged.
**Voice:** Casual, brash, uses "dattebayo" verbal tic.
**Status:** Alive
**Faction:** Konohagakure
**Goals:** Become Hokage so the village will finally recognize him.
**StoryRelevance:** Jinchuuriki of the Nine-Tails; protagonist.
**Example Output:** "I'm gonna be Hokage someday, believe it!"
**Affinity:** 50
**PersonalityHex:** drive:+3, diligence:-1, boldness:+3, warmth:+2, empathy:+2, composure:-2
**Traits:** [loyal, stubborn, impulsive, competitive, protective]`;

describe('parseNPCsFromLore — lore-authored agency fields (hex + traits)', () => {
    it('extracts PersonalityHex from the CSV form and clamps to -3..+3', () => {
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER — Naruto Uzumaki', NARUTO_BLOCK)]);
        expect(npc).toBeDefined();
        expect(npc.personalityHex).toEqual({
            drive: 3,
            diligence: -1,
            boldness: 3,
            warmth: 2,
            empathy: 2,
            composure: -2,
        });
    });

    it('extracts Traits from the bracketed CSV and filters to the controlled vocab', () => {
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER — Naruto Uzumaki', NARUTO_BLOCK)]);
        expect(npc.traits).toEqual(['loyal', 'stubborn', 'impulsive', 'competitive', 'protective']);
    });

    it('accepts inline JSON for PersonalityHex', () => {
        const body = NARUTO_BLOCK.replace(
            '**PersonalityHex:** drive:+3, diligence:-1, boldness:+3, warmth:+2, empathy:+2, composure:-2',
            '**PersonalityHex:** {"drive":3,"diligence":-1,"boldness":3,"warmth":2,"empathy":2,"composure":-2}',
        );
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER — Naruto Uzumaki', body)]);
        expect(npc.personalityHex).toEqual({
            drive: 3, diligence: -1, boldness: 3, warmth: 2, empathy: 2, composure: -2,
        });
    });

    it('clamps out-of-range hex values to the -3..+3 hard bounds', () => {
        const body = NARUTO_BLOCK.replace(
            '**PersonalityHex:** drive:+3, diligence:-1, boldness:+3, warmth:+2, empathy:+2, composure:-2',
            '**PersonalityHex:** drive:+9, diligence:-7, boldness:+5, warmth:2, empathy:2, composure:-2',
        );
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER — Naruto Uzumaki', body)]);
        expect(npc.personalityHex).toEqual({
            drive: 3, diligence: -3, boldness: 3, warmth: 2, empathy: 2, composure: -2,
        });
    });

    it('drops trait names not in the controlled vocabulary', () => {
        const body = NARUTO_BLOCK.replace(
            '**Traits:** [loyal, stubborn, impulsive, competitive, protective]',
            '**Traits:** [loyal, very brave, super smart, protective, totally awesome]',
        );
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER — Naruto Uzumaki', body)]);
        expect(npc.traits).toEqual(['loyal', 'protective']);
    });

    it('caps traits at 5 even when the block lists more', () => {
        const body = NARUTO_BLOCK.replace(
            '**Traits:** [loyal, stubborn, impulsive, competitive, protective]',
            '**Traits:** [loyal, stubborn, impulsive, competitive, protective, vengeful, ambitious, curious]',
        );
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER — Naruto Uzumaki', body)]);
        expect(npc.traits?.length).toBe(5);
        expect(npc.traits).toEqual(['loyal', 'stubborn', 'impulsive', 'competitive', 'protective']);
    });

    it('returns undefined for hex and traits when the block omits them', () => {
        const body = NARUTO_BLOCK
            .replace(/\n\*\*PersonalityHex:\*\*.*/u, '')
            .replace(/\n\*\*Traits:\*\*.*/u, '');
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER — Naruto Uzumaki', body)]);
        expect(npc.personalityHex).toBeUndefined();
        expect(npc.traits).toBeUndefined();
    });

    it('still extracts the standard 11 text fields', () => {
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER — Naruto Uzumaki', NARUTO_BLOCK)]);
        expect(npc.name).toBe('Naruto Uzumaki');
        expect(npc.aliases).toContain('Number One Hyperactive');
        expect(npc.appearance).toContain('whisker marks');
        expect(npc.disposition).toContain('loyal');
        expect(npc.personality).toContain('acknowledged');
        expect(npc.voice).toContain('dattebayo');
        expect(npc.status).toBe('Alive');
        expect(npc.faction).toBe('Konohagakure');
        expect(npc.goals).toContain('Hokage');
        expect(npc.storyRelevance).toContain('Jinchuuriki');
        expect(npc.exampleOutput).toContain('believe it');
        expect(npc.affinity).toBe(50);
    });
});

const AGENCY_BLOCK = `### CHARACTER — Test NPC
**Disposition:** Cool, distant.
**Status:** Alive
**Faction:** Konohagakure
**Tier:** recurring
**Region:** konoha
**Haunt:** the training grounds
**HardBoundaries:** [will not betray his team, will not abandon a comrade]
**SoftBoundaries:** [dislikes being lectured, dislikes waiting]
**BehavioralTriggers:** [itachi:goes silent and sharpens killing intent, sasuke:raises voice and clenches fists]
**WantsShort:** [train, eat ramen, prank]
**WantsMedium:** [learn a new jutsu, win a sparring match]
**WantsLong:** become Hokage so the village recognizes him
**CoreWant:** to be acknowledged, not feared
**SessionWant:** bring his teammate back
**SceneWant:** prove he is not the fox`;

describe('parseNPCsFromLore — extended agency fields (tier, region, haunt, boundaries, triggers, wants, drives)', () => {
    it('extracts Tier and validates to recurring|oneshot|walkon (default recurring)', () => {
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER — Test NPC', AGENCY_BLOCK)]);
        expect(npc.tier).toBe('recurring');
    });

    it('defaults Tier to recurring when the field is absent', () => {
        const block = '**Disposition:** Cool.\n**Status:** Alive\n**Faction:** Konoha';
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER — Test NPC', block)]);
        expect(npc.tier).toBe('recurring');
    });

    it('rejects an invalid Tier value and falls back to recurring', () => {
        const block = AGENCY_BLOCK.replace('**Tier:** recurring', '**Tier:** superhero');
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER — Test NPC', block)]);
        expect(npc.tier).toBe('recurring');
    });

    it('extracts Region and Haunt as single-line strings', () => {
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER — Test NPC', AGENCY_BLOCK)]);
        expect(npc.region).toBe('konoha');
        expect(npc.haunt).toBe('the training grounds');
    });

    it('extracts HardBoundaries and SoftBoundaries as string arrays', () => {
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER — Test NPC', AGENCY_BLOCK)]);
        expect(npc.hardBoundaries).toEqual(['will not betray his team', 'will not abandon a comrade']);
        expect(npc.softBoundaries).toEqual(['dislikes being lectured', 'dislikes waiting']);
    });

    it('extracts BehavioralTriggers as {keyword, shift} pairs', () => {
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER — Test NPC', AGENCY_BLOCK)]);
        expect(npc.behavioralTriggers).toEqual([
            { keyword: 'itachi', shift: 'goes silent and sharpens killing intent' },
            { keyword: 'sasuke', shift: 'raises voice and clenches fists' },
        ]);
    });

    it('extracts Wants (short/medium/long)', () => {
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER — Test NPC', AGENCY_BLOCK)]);
        expect(npc.wants).toEqual({
            short: ['train', 'eat ramen', 'prank'],
            medium: ['learn a new jutsu', 'win a sparring match'],
            long: 'become Hokage so the village recognizes him',
        });
    });

    it('extracts Drives (coreWant/sessionWant/sceneWant)', () => {
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER — Test NPC', AGENCY_BLOCK)]);
        expect(npc.drives).toEqual({
            coreWant: 'to be acknowledged, not feared',
            sessionWant: 'bring his teammate back',
            sceneWant: 'prove he is not the fox',
        });
    });

    it('returns undefined for agency fields when the block omits them', () => {
        const block = '**Disposition:** Cool.\n**Status:** Alive\n**Faction:** Konoha';
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER — Test NPC', block)]);
        expect(npc.tier).toBe('recurring'); // tier defaults, not undefined
        expect(npc.region).toBeUndefined();
        expect(npc.haunt).toBeUndefined();
        expect(npc.hardBoundaries).toBeUndefined();
        expect(npc.softBoundaries).toBeUndefined();
        expect(npc.behavioralTriggers).toBeUndefined();
        expect(npc.drives).toBeUndefined();
        expect(npc.wants).toBeUndefined();
    });
});