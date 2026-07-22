import { useState } from 'react';
import { set } from 'idb-keyval';
import { useAppStore } from '../store/useAppStore';
import { toast } from '../components/Toast';
import { openArchive as openArchiveFn } from '../services/archive-memory/archiveManager';

/**
 * Manual campaign persistence, extracted from ChatArea: the force-save button
 * (direct IndexedDB write) and the archive viewer opener.
 */
export function useChatPersistence() {
    const activeCampaignId = useAppStore(s => s.activeCampaignId);
    const [isSaving, setIsSaving] = useState(false);

    const handleForceSave = () => {
        setIsSaving(true);
        const state = useAppStore.getState();
        if (state.activeCampaignId) {
            try {
                set(`nn_settings`, { settings: state.settings, activeCampaignId: state.activeCampaignId });
                set(`nn_campaign_${state.activeCampaignId}_state`, { context: state.context, messages: state.messages, condenser: state.condenser });
                set(`nn_campaign_${state.activeCampaignId}_npcs`, state.npcLedger);
                toast.success('Campaign saved');
            } catch (e) {
                console.error("[Save] Failed to force save to IndexedDB:", e);
                toast.error('Force save failed');
            }
        }
        setTimeout(() => setIsSaving(false), 2000);
    };

    const handleOpenArchive = () => {
        if (activeCampaignId) openArchiveFn(activeCampaignId);
    };

    return { isSaving, handleForceSave, handleOpenArchive };
}
