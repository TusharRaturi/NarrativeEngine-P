import type { TurnCallbacks, TurnState } from '../turnTypes';
import { offlineStorage } from '../../storage';

/**
 * Resolves the next scene number (zero-padded to 3 digits) for the active
 * campaign. Returns undefined when there is no active campaign or the lookup
 * fails — the turn proceeds without a scene number.
 */
export async function sceneNumberStage(params: {
    state: TurnState;
    callbacks: TurnCallbacks;
}): Promise<string | undefined> {
    const { state, callbacks } = params;
    const { activeCampaignId } = state;
    if (!activeCampaignId) return undefined;

    callbacks.setLoadingStatus?.('[2/5] Fetching Timeline...');
    try {
        const nextScene = await offlineStorage.archive.getNextSceneNumber(activeCampaignId);
        return String(nextScene).padStart(3, '0');
    } catch (err) {
        console.warn('[TurnContext] Failed to get next scene number:', err);
        return undefined;
    }
}
