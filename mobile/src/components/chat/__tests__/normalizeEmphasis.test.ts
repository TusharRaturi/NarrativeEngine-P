import { describe, it, expect } from 'vitest';
import { normalizeEmphasis } from '../ContentWithChips';

describe('normalizeEmphasis', () => {
    it('passes through text without asterisks', () => {
        expect(normalizeEmphasis('Hello world')).toBe('Hello world');
    });

    it('leaves properly paired *italic* alone', () => {
        expect(normalizeEmphasis('and *nodded once*.')).toBe('and *nodded once*.');
    });

    it('leaves **bold** alone', () => {
        expect(normalizeEmphasis('**Mundane — Narrative Boon.**')).toBe('**Mundane — Narrative Boon.**');
    });

    it('collapses leading-asterisk-per-word runs into a single italic phrase', () => {
        expect(normalizeEmphasis('*Four *bowls — *one for *each *member of Team *10.'))
            .toBe('*Four bowls — one for each member of Team 10*.');
    });

    it('does not merge across sentence boundaries', () => {
        const input = '*Four *bowls. *One *each.';
        const out = normalizeEmphasis(input);
        expect(out).toBe('*Four bowls*. *One each*.');
    });

    it('drops a single orphan leading asterisk with no closing partner', () => {
        expect(normalizeEmphasis('Asuma *picked up his chopsticks.'))
            .toBe('Asuma picked up his chopsticks.');
    });

    it('does not touch asterisks inside `code spans`', () => {
        expect(normalizeEmphasis('use `*foo *bar` literally'))
            .toBe('use `*foo *bar` literally');
    });

    it('preserves a mix of paired italics and bold across one line', () => {
        const input = '**Header.** Then *one phrase* and *two words*.';
        expect(normalizeEmphasis(input)).toBe(input);
    });

    it('handles intra-word run with em-dashes', () => {
        expect(normalizeEmphasis('The *steam *rose. The *smell *filled the *air.'))
            .toBe('The *steam rose*. The *smell filled the air*.');
    });

    it('processes lines independently', () => {
        const input = '*Four *bowls *here\nNormal line\n*orphan only';
        expect(normalizeEmphasis(input))
            .toBe('*Four bowls here*\nNormal line\norphan only');
    });
});
