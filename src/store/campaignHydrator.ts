import { useAppStore } from './useAppStore';
import {
    loadCampaignState, getLoreChunks, getNPCLedger, getLocationLedger,
    loadArchiveIndex, loadTimeline, loadChapters, loadEntities,
    loadDivergenceRegister, saveDivergenceRegister, saveChapters,
} from './campaignStore';
import { DEFAULT_CONTEXT, DEFAULT_CONDENSER } from '../services/campaignInit';
import { migrateLegacyContext } from '../types';
import type { GameContext, ArchiveChapter, DivergenceRegister } from '../types';
import { migrateV1ToV2 } from '../services/campaign-state/divergenceRegister';

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
        register = migrateV1ToV2(divReg ?? { entries: [] as any[], lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 1 });
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

    useAppStore.setState({
        context: migratedContext,
        messages: state?.messages ?? [],
        condenser: { ...(state?.condenser ?? DEFAULT_CONDENSER) },
        loreChunks: chunks,
        npcLedger: npcs,
        locationLedger: locations ?? [],
        archiveIndex: archiveIndex ?? [],
        timeline: timeline ?? [],
        chapters: backfilled,
        entities: entities ?? [],
        divergenceRegister: register,
        activeCampaignId: campaignId,
        inventoryItems: migratedContext.inventoryItems,
        characterProfileData: migratedContext.characterProfileData,
        pinnedExcerpts: state?.pinnedExcerpts ?? [],
    });
}
