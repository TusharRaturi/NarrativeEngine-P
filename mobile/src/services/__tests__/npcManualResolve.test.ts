import { describe, it, expect } from 'vitest';
import type { NPCEntry } from '../../types';
import { normalizeSelection, findLedgerMatches, resolveNpcSelection } from '../npc/npcManualResolve';

function npc(name: string, aliases = '', id = name.toLowerCase().replace(/\s+/g, '-')): NPCEntry {
    return { id, name, aliases } as NPCEntry;
}

describe('normalizeSelection', () => {
    it('trims and collapses whitespace', () => {
        expect(normalizeSelection('  Hikaru   Masamune  ')).toBe('Hikaru Masamune');
    });
    it('strips surrounding quotes/brackets/punctuation', () => {
        expect(normalizeSelection('"Hikaru"')).toBe('Hikaru');
        expect(normalizeSelection('Hikaru.')).toBe('Hikaru');
        expect(normalizeSelection('[Hikaru]')).toBe('Hikaru');
    });
    it('strips a trailing possessive', () => {
        expect(normalizeSelection("Hikaru's")).toBe('Hikaru');
        expect(normalizeSelection('Hikaru’s')).toBe('Hikaru');
    });
    it('drops a leading article', () => {
        expect(normalizeSelection('the Hikaru')).toBe('Hikaru');
    });
    it('peels leading titles but keeps the name', () => {
        expect(normalizeSelection('Captain Hikaru')).toBe('Hikaru');
        expect(normalizeSelection('Lady Elara of Mire')).toBe('Elara of Mire');
    });
    it('returns empty for blank/garbage', () => {
        expect(normalizeSelection('   ')).toBe('');
        expect(normalizeSelection('"."')).toBe('');
    });
});

describe('findLedgerMatches', () => {
    const ledger = [npc('Hikaru Masamune'), npc('Renji Masamune'), npc('Aldric Stone', 'Stoney')];

    it('matches full name exactly', () => {
        expect(findLedgerMatches('Hikaru Masamune', ledger).map(n => n.name)).toEqual(['Hikaru Masamune']);
    });
    it('matches on first name (prefix token)', () => {
        expect(findLedgerMatches('Hikaru', ledger).map(n => n.name)).toEqual(['Hikaru Masamune']);
    });
    it('matches a shared family name to ALL bearers', () => {
        expect(findLedgerMatches('Masamune', ledger).map(n => n.name)).toEqual(['Hikaru Masamune', 'Renji Masamune']);
    });
    it('matches via alias', () => {
        expect(findLedgerMatches('Stoney', ledger).map(n => n.name)).toEqual(['Aldric Stone']);
    });
    it('does not substring-match partial tokens', () => {
        expect(findLedgerMatches('Ren', ledger)).toEqual([]);
        expect(findLedgerMatches('Mas', ledger)).toEqual([]);
    });
});

describe('resolveNpcSelection', () => {
    const ledger = [npc('Hikaru Masamune'), npc('Renji Masamune')];

    it('empty selection', () => {
        expect(resolveNpcSelection('   ', ledger)).toEqual({ kind: 'empty' });
    });
    it('create when no match', () => {
        expect(resolveNpcSelection('Seraphine Thornmere', ledger)).toEqual({ kind: 'create', name: 'Seraphine Thornmere' });
    });
    it('update when exactly one match (full name)', () => {
        const r = resolveNpcSelection('Hikaru Masamune', ledger);
        expect(r.kind).toBe('update');
        if (r.kind === 'update') expect(r.npc.name).toBe('Hikaru Masamune');
    });
    it('update when one match via first name', () => {
        const r = resolveNpcSelection('Captain Hikaru', ledger);
        expect(r.kind).toBe('update');
        if (r.kind === 'update') expect(r.npc.name).toBe('Hikaru Masamune');
    });
    it('ambiguous on shared family name', () => {
        const r = resolveNpcSelection('Masamune', ledger);
        expect(r.kind).toBe('ambiguous');
        if (r.kind === 'ambiguous') expect(r.matches.map(n => n.name)).toEqual(['Hikaru Masamune', 'Renji Masamune']);
    });
});
