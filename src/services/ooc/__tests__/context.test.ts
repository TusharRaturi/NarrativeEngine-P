import { describe, expect, it } from 'vitest';
import { buildOocContext } from '../context';
import type { OocCampaignSnapshot } from '../types';

const snapshot = {
    campaignId: 'campaign-1', provider: undefined, messages: [], semanticFacts: [], loreChunks: [], archiveIndex: [], npcLedger: [],
    context: {
        canonStateActive: false, canonState: '', sceneNoteActive: false, sceneNote: '', currentFeature: null, worldVibe: '',
        characterProfile: { identity: { name: 'Ari', race: 'Elf', class: 'Ranger', level: 4 }, stats: { dex: 16, wis: 14 }, activeTraits: [], legacyNotes: 'Do not include me.' },
        inventoryItems: Array.from({ length: 13 }, (_, index) => ({ id: `item-${index}`, name: `Item ${index}`, qty: index + 1, category: 'misc', equipped: index === 0, status: index === 1 ? 'damaged' : undefined })),
        notebookActive: true,
        notebook: Array.from({ length: 10 }, (_, index) => ({ id: `note-${index}`, text: `Note ${index}`, timestamp: index })),
    },
} as unknown as OocCampaignSnapshot;

describe('buildOocContext', () => {
    it('includes bounded data-only PC, inventory, and active notebook state', () => {
        const result = buildOocContext(snapshot, 'What equipment does Ari have?');
        expect(result.text).toContain('PC identity: Ari | Elf | Ranger | Level 4');
        expect(result.text).toContain('PC stats: DEX 16 | WIS 14');
        expect(result.text).toContain('Item 11 x12');
        expect(result.text).not.toContain('Item 12 x13');
        expect(result.text).toContain('Note 9');
        expect(result.text).not.toContain('Note 3');
        expect(result.text).not.toContain('Do not include me.');
        expect(result.sources).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'pc-identity' }),
            expect.objectContaining({ id: 'inventory-item-0' }),
            expect.objectContaining({ id: 'notebook-note-9' }),
        ]));
    });
});