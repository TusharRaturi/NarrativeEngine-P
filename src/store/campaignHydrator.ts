import { useAppStore } from './useAppStore';
import {
    loadCampaignState, getLoreChunks, getNPCLedger, getLocationLedger,
    loadArchiveIndex, loadTimeline, loadChapters, loadEntities,
    loadDivergenceRegister, saveDivergenceRegister, saveChapters,
    saveNPCLedger,
} from './campaignStore';
import { DEFAULT_CONTEXT, DEFAULT_CONDENSER } from '../services/campaignInit';
import { migrateLegacyContext } from '../types';
import type { GameContext, ArchiveChapter, DivergenceRegister, DivergenceEntry } from '../types';
import { migrateV1ToV2 } from '../services/campaign-state/divergenceRegister';
import { migratePCIntoContext } from '../services/character/migratePC';

function backfillSceneIds(chapters: ArchiveChapter[]): { chapters: ArchiveChapter[]; changed: boolean } {
    let changed = false;
    const updated = chapters.map(ch => {
        if (ch.sceneIds && ch.sceneIds.length > 0) return ch;
        const startNum = parseInt(ch.sceneRange[0], 10);
        const endNum = parseInt(ch.sceneRange[1], 10);
        const ids = Array.from({ length: endNum - startNum + 1 }, (_, i) =>
            String(startNum + i).padStart(3, '0')
        );
        changed = true;
        return { ...ch, sceneIds: ids };
    });
    return { chapters: updated, changed };
}

export async function hydrateCampaign(campaignId: string) {
    const [state, chunks, npcs, locations, archiveIndex, timeline, chapters, entities, divReg] = await Promise.all([
        loadCampaignState(campaignId),
        getLoreChunks(campaignId),
        getNPCLedger(campaignId),
        getLocationLedger(campaignId),
        loadArchiveIndex(campaignId),
        loadTimeline(campaignId),
        loadChapters(campaignId),
        loadEntities(campaignId),
        loadDivergenceRegister(campaignId),
    ]);

    const rawContext: GameContext = { ...DEFAULT_CONTEXT, ...(state?.context ?? {}) } as GameContext;
    const migratedContext = migrateLegacyContext(rawContext);

    // v1→v2 divergence register migration: wipe-and-restart
    let register: DivergenceRegister;
    if (!divReg || !divReg.version || divReg.version < 2) {
        register = migrateV1ToV2(divReg ?? { entries: [] as DivergenceEntry[], lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 1 });
        saveDivergenceRegister(campaignId, register).catch(e =>
            console.warn('[Hydrator] Failed to save migrated divergence register:', e)
        );
    } else {
        register = divReg;
    }

    // Backfill sceneIds on chapters missing the field
    const { chapters: backfilled, changed: sceneIdsChanged } = backfillSceneIds(chapters ?? []);
    if (sceneIdsChanged) {
        console.log('[Hydrator] Backfilled sceneIds on chapters');
        try { await saveChapters(campaignId, backfilled); } catch (e) {
            console.warn('[Hydrator] Failed to save backfilled chapters:', e);
        }
    }

    // WO-A rewrite 2 §2: one-time migration of legacy `isPC` row from npcLedger
    // into `context.playerCharacter`. Idempotent — no-op on already-migrated
    // campaigns. If migration strips a row, persist the trimmed ledger back to
    // disk so the legacy row doesn't复活 on next hydrate.
    const pcMigration = migratePCIntoContext(migratedContext, npcs ?? []);
    const finalContext = pcMigration.context;
    const finalNpcLedger = pcMigration.npcLedger;
    if (pcMigration.migrated) {
        console.log('[Hydrator] Migrated legacy isPC row from npcLedger into context.playerCharacter');
        try { await saveNPCLedger(campaignId, finalNpcLedger); } catch (e) {
            console.warn('[Hydrator] Failed to persist trimmed npcLedger after PC migration:', e);
        }
    }

    useAppStore.setState({
        context: finalContext,
        messages: state?.messages ?? [],
        condenser: { ...(state?.condenser ?? DEFAULT_CONDENSER) },
        loreChunks: chunks,
        npcLedger: finalNpcLedger,
        locationLedger: locations ?? [],
        archiveIndex: archiveIndex ?? [],
        timeline: timeline ?? [],
        chapters: backfilled,
        entities: entities ?? [],
        divergenceRegister: register,
        activeCampaignId: campaignId,
        inventoryItems: finalContext.inventoryItems,
        characterProfileData: finalContext.characterProfileData,
        playerCharacter: finalContext.playerCharacter ?? null,
        pinnedExcerpts: state?.pinnedExcerpts ?? [],
    });
}
