import type { ArchiveChapter, Campaign, LoreChunk, GameContext, ChatMessage, CondenserState, NPCEntry, ArchiveIndexEntry, SemanticFact, EntityEntry, BackupMeta, TimelineEvent, DivergenceRegister, PinnedExcerpt } from '../types';
import { affinityToPcRelation } from '../services/npc/agency/agencyBands';

import { API_BASE as API } from '../lib/apiBase';

export type CampaignState = {
    context: GameContext;
    messages: ChatMessage[];
    condenser: CondenserState;
    pinnedExcerpts?: PinnedExcerpt[];
};

// ─── Campaign CRUD ───

export async function listCampaigns(): Promise<Campaign[]> {
    const res = await fetch(`${API}/campaigns`);
    return res.json();
}

export async function getCampaign(id: string): Promise<Campaign | undefined> {
    const res = await fetch(`${API}/campaigns/${id}`);
    if (!res.ok) return undefined;
    return res.json();
}

export async function saveCampaign(campaign: Campaign): Promise<void> {
    await fetch(`${API}/campaigns/${campaign.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(campaign),
    });
}

export async function deleteCampaign(id: string): Promise<void> {
    await fetch(`${API}/campaigns/${id}`, { method: 'DELETE' });
}

export async function exportCampaign(id: string): Promise<void> {
    const res = await fetch(`${API}/campaigns/${id}/export`);
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') ?? '';
    const fnMatch = cd.match(/filename="([^"]+)"/);
    const filename = fnMatch?.[1] ?? `campaign_${id}.campaign`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

export async function importCampaign(bundle: unknown): Promise<{ id: string; name: string }> {
    const res = await fetch(`${API}/campaigns/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bundle),
    });
    if (!res.ok) throw new Error('Import failed');
    return res.json();
}

// ─── Campaign State ───

export async function saveCampaignState(campaignId: string, state: CampaignState): Promise<void> {
    const stripped: CampaignState = {
        ...state,
        messages: state.messages.map(({ debugPayload: _dp, ...msg }) => msg),
    };
    await fetch(`${API}/campaigns/${campaignId}/state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(stripped),
    });
}

export async function loadCampaignState(campaignId: string): Promise<CampaignState | null> {
    const res = await fetch(`${API}/campaigns/${campaignId}/state`);
    if (!res.ok) return null;
    const record = await res.json();
    const { context, messages, condenser } = record;
    return { context, messages, condenser };
}

// ─── Lore Chunks ───

export async function saveLoreChunks(campaignId: string, chunks: LoreChunk[]): Promise<void> {
    await fetch(`${API}/campaigns/${campaignId}/lore`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chunks),
    });
}

export async function getLoreChunks(campaignId: string): Promise<LoreChunk[]> {
    const res = await fetch(`${API}/campaigns/${campaignId}/lore`);
    return res.json();
}

// ─── NPC Ledger ───

export async function saveNPCLedger(campaignId: string, npcs: NPCEntry[]): Promise<void> {
    await fetch(`${API}/campaigns/${campaignId}/npcs`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(npcs),
    });
}

export async function getNPCLedger(campaignId: string): Promise<NPCEntry[]> {
    const res = await fetch(`${API}/campaigns/${campaignId}/npcs`);
    if (!res.ok) return [];
    const npcs: NPCEntry[] = await res.json();
    // B2 — lazy migration for existing saves: home pcRelation for any NPC where it's still
    // undefined. populateAgencyFields only runs on UN-populated NPCs, and generated NPCs were
    // born populated:true with pcRelation unset, so legacy NPCs read "[Aff: Neutral]" forever
    // and Phase 2's reaction-menu relationship scoring never saw real drift. Home them here on
    // load regardless of `populated`, mirroring the birth-block fix in profile.ts. Skip PCs
    // (matches populateAgencyFields' !n.isPC filter). Never clobber an explicit value, never
    // touch affinity. Persistence happens via the normal store-update path on the next mutation.
    for (const n of npcs) {
        if (!n.isPC && n.pcRelation === undefined) {
            n.pcRelation = affinityToPcRelation(n.affinity ?? 50);
        }
    }
    return npcs;
}

// ─── Archive Index (Tier 4) ───

/** Load the archive search index from disk. Built automatically by the server on every turn. */
export async function loadArchiveIndex(campaignId: string): Promise<ArchiveIndexEntry[]> {
    const res = await fetch(`${API}/campaigns/${campaignId}/archive/index`);
    if (!res.ok) return [];
    return res.json();
}

export async function loadSemanticFacts(campaignId: string): Promise<SemanticFact[]> {
    const res = await fetch(`${API}/campaigns/${campaignId}/facts`);
    if (!res.ok) return [];
    return res.json();
}

export async function loadEntities(campaignId: string): Promise<EntityEntry[]> {
    const res = await fetch(`${API}/campaigns/${campaignId}/entities`);
    if (!res.ok) return [];
    return res.json();
}

// --- Chapters (Phase 1) ---

export async function loadChapters(campaignId: string): Promise<ArchiveChapter[]> {
    const res = await fetch(`${API}/campaigns/${campaignId}/archive/chapters`);
    if (!res.ok) return [];
    return res.json();
}

export async function createChapter(campaignId: string, title?: string): Promise<ArchiveChapter | undefined> {
    const res = await fetch(`${API}/campaigns/${campaignId}/archive/chapters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
    });
    if (!res.ok) return undefined;
    return res.json();
}

export async function createBackup(
    campaignId: string,
    opts: { label?: string; trigger?: string; isAuto?: boolean } = {}
): Promise<{ timestamp: number; hash: string; fileCount: number; skipped?: boolean } | undefined> {
    try {
        const res = await fetch(`${API}/campaigns/${campaignId}/backup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(opts),
        });
        if (res.ok) return await res.json();
    } catch (err) {
        console.warn('[Backup] Create failed:', err);
    }
    return undefined;
}

export async function listBackups(campaignId: string): Promise<BackupMeta[]> {
    try {
        const res = await fetch(`${API}/campaigns/${campaignId}/backups`);
        if (res.ok) {
            const data = await res.json();
            return data.backups || [];
        }
    } catch (err) {
        console.warn('[Backup] List failed:', err);
    }
    return [];
}

export async function restoreBackup(campaignId: string, timestamp: number): Promise<boolean> {
    try {
        const res = await fetch(`${API}/campaigns/${campaignId}/backups/${timestamp}/restore`, {
            method: 'POST',
        });
        return res.ok;
    } catch (err) {
        console.warn('[Backup] Restore failed:', err);
    }
    return false;
}

export async function deleteBackup(campaignId: string, timestamp: number): Promise<boolean> {
    try {
        const res = await fetch(`${API}/campaigns/${campaignId}/backups/${timestamp}`, {
            method: 'DELETE',
        });
        return res.ok;
    } catch (err) {
        console.warn('[Backup] Delete failed:', err);
    }
    return false;
}

// ─── Timeline ───────────────────────────────────────────────────────────

export async function loadTimeline(campaignId: string): Promise<TimelineEvent[]> {
    const res = await fetch(`${API}/campaigns/${campaignId}/timeline`);
    if (!res.ok) return [];
    return res.json();
}

export async function addTimelineEvent(
    campaignId: string,
    event: Omit<TimelineEvent, 'id' | 'source'>
): Promise<TimelineEvent | undefined> {
    const res = await fetch(`${API}/campaigns/${campaignId}/timeline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
    });
    if (!res.ok) return undefined;
    return res.json();
}

export async function removeTimelineEvent(campaignId: string, eventId: string): Promise<boolean> {
    const res = await fetch(`${API}/campaigns/${campaignId}/timeline/${eventId}`, {
        method: 'DELETE',
    });
    return res.ok;
}

export async function updateChapter(campaignId: string, chapterId: string, patch: Partial<ArchiveChapter>): Promise<ArchiveChapter | undefined> {
    const res = await fetch(`${API}/campaigns/${campaignId}/archive/chapters/${chapterId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
    });
    if (!res.ok) return undefined;
    return res.json();
}

export async function saveDivergenceRegister(campaignId: string, register: DivergenceRegister): Promise<void> {
    await fetch(`${API}/campaigns/${campaignId}/divergence`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(register),
    });
}

export async function loadDivergenceRegister(campaignId: string): Promise<DivergenceRegister> {
    const res = await fetch(`${API}/campaigns/${campaignId}/divergence`);
    if (!res.ok) return { entries: [], chapterToggles: {}, categoryToggles: {}, lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 2 };
    const data = await res.json();
    return { ...data, chapterToggles: data.chapterToggles ?? {}, categoryToggles: data.categoryToggles ?? {} };
}

export async function saveChapters(campaignId: string, chapters: ArchiveChapter[]): Promise<void> {
    await fetch(`${API}/campaigns/${campaignId}/archive/chapters`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chapters),
    });
}
