import { describe, it, expect } from 'vitest';
import { extractAndStripSceneStakes } from '../sceneStakesTag';

describe('extractAndStripSceneStakes', () => {
    it('extracts calm and strips the tag', () => {
        const input = 'The sun rises over the valley.\n[[SCENE_STAKES: calm]]';
        const { displayText, stakes } = extractAndStripSceneStakes(input);
        expect(stakes).toBe('calm');
        expect(displayText).toBe('The sun rises over the valley.');
        expect(displayText).not.toContain('SCENE_STAKES');
    });

    it('extracts tense and strips the tag', () => {
        const input = 'Guards patrol the corridor.\n[[SCENE_STAKES: tense]]';
        const { displayText, stakes } = extractAndStripSceneStakes(input);
        expect(stakes).toBe('tense');
        expect(displayText).toBe('Guards patrol the corridor.');
    });

    it('extracts dangerous and strips the tag', () => {
        const input = 'The dragon breathes fire!\n[[SCENE_STAKES: dangerous]]';
        const { displayText, stakes } = extractAndStripSceneStakes(input);
        expect(stakes).toBe('dangerous');
        expect(displayText).toBe('The dragon breathes fire!');
    });

    it('handles uppercase tag', () => {
        const input = 'A duel begins.\n[[SCENE_STAKES: TENSE]]';
        const { displayText, stakes } = extractAndStripSceneStakes(input);
        expect(stakes).toBe('tense');
        expect(displayText).toBe('A duel begins.');
    });

    it('handles extra whitespace in tag', () => {
        const input = 'Something happens.\n[[SCENE_STAKES:  dangerous  ]]';
        const { displayText, stakes } = extractAndStripSceneStakes(input);
        expect(stakes).toBe('dangerous');
        expect(displayText).toBe('Something happens.');
    });

    it('defaults to calm and returns original text when tag is absent', () => {
        const input = 'The market is busy today.';
        const { displayText, stakes } = extractAndStripSceneStakes(input);
        expect(stakes).toBe('calm');
        expect(displayText).toBe(input);
    });

    it('defaults to calm for garbled tag value', () => {
        const input = 'Something weird.\n[[SCENE_STAKES: urgent]]';
        const { displayText, stakes } = extractAndStripSceneStakes(input);
        expect(stakes).toBe('calm');
        expect(displayText).toBe('Something weird.');
        expect(displayText).not.toContain('SCENE_STAKES');
    });

    it('strips tag from mid-text too (robustness)', () => {
        const input = 'Before [[SCENE_STAKES: tense]] after';
        const { displayText, stakes } = extractAndStripSceneStakes(input);
        expect(stakes).toBe('tense');
        expect(displayText).toBe('Before  after');
        expect(displayText).not.toContain('SCENE_STAKES');
    });

    it('handles multi-line GM response with tag on last line', () => {
        const input = 'The crowd murmurs.\n\n"Who goes there?" a guard shouts.\n\n[[SCENE_STAKES: tense]]';
        const { displayText, stakes } = extractAndStripSceneStakes(input);
        expect(stakes).toBe('tense');
        expect(displayText).toBe('The crowd murmurs.\n\n"Who goes there?" a guard shouts.');
    });

    it('NEVER shows the tag in display text', () => {
        const inputs = [
            'Text [[SCENE_STAKES: calm]]',
            '[[SCENE_STAKES: dangerous]]\nText',
            'Line 1\n[[SCENE_STAKES: tense]]\nLine 3',
        ];
        for (const input of inputs) {
            const { displayText } = extractAndStripSceneStakes(input);
            expect(displayText).not.toContain('SCENE_STAKES');
            expect(displayText).not.toContain('[[');
        }
    });
});