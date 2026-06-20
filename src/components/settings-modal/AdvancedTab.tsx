import { useState, useEffect } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { getEmbeddingStatus, runBackfill } from '../../services/backfillRunner';
import { api } from '../../services/llm/apiClient';
import { API_BASE } from '../../lib/apiBase';
import { toast } from '../Toast';
import type { BackfillStatus } from '../../services/backfillRunner';

type EmbedderInfo = {
    modelId: string;
    dims: number;
    embeddingVersion: number;
};

export function AdvancedTab() {
    const activeCampaignId = useAppStore(s => s.activeCampaignId);

    const [embedderInfo, setEmbedderInfo] = useState<EmbedderInfo | null>(null);
    const [embedStatus, setEmbedStatus] = useState<BackfillStatus | null>(null);
    const [reindexing, setReindexing] = useState(false);
    const [reindexStatus, setReindexStatus] = useState('');
    const [rebuildingRules, setRebuildingRules] = useState(false);

    useEffect(() => {
        let cancelled = false;
        fetch(`${API_BASE}/embeddings/info`)
            .then(res => res.ok ? res.json() : null)
            .then(info => { if (!cancelled && info) setEmbedderInfo(info); })
            .catch(() => { /* best-effort */ });
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        if (!activeCampaignId) {
            setEmbedStatus(null);
            return;
        }
        let cancelled = false;
        getEmbeddingStatus(activeCampaignId)
            .then(status => { if (!cancelled) setEmbedStatus(status); })
            .catch(() => { if (!cancelled) setEmbedStatus(null); });
        return () => { cancelled = true; };
    }, [activeCampaignId, reindexing]);

    const handleReindex = async () => {
        if (!activeCampaignId) {
            toast.error('No active campaign');
            return;
        }
        setReindexing(true);
        setReindexStatus('Re-indexing...');
        try {
            const result = await runBackfill(activeCampaignId, 'all', (msg) => setReindexStatus(msg));
            setEmbedStatus(result.status);
            toast.success(`Re-indexed ${result.reindexedScenes} scenes, ${result.reindexedLore} lore chunks`);
        } catch (err) {
            toast.error(`Re-index failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
        } finally {
            setReindexing(false);
            setReindexStatus('');
        }
    };

    const handleRebuildRules = async () => {
        if (!activeCampaignId) {
            toast.error('No active campaign');
            return;
        }
        setRebuildingRules(true);
        try {
            toast.info('Rebuilding rules embeddings...');
            const res = await api.rules.reindex(activeCampaignId);
            if (res) {
                toast.success(`Successfully rebuilt ${res.totalChunks} rule chunks`);
            } else {
                toast.error('Rebuild failed');
            }
        } catch (err) {
            toast.error(`Rebuild failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
        } finally {
            setRebuildingRules(false);
        }
    };

    return (
        <div className="space-y-6">
            <label className="text-text-dim text-xs uppercase tracking-widest font-bold block">Advanced</label>

            {/* Active embedder — read-only on desktop (single server-side model) */}
            <div className="bg-void p-4 border border-border rounded space-y-3">
                <div>
                    <label className="block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">Embedding Model</label>
                    <p className="text-[10px] text-text-dim leading-tight">
                        mainApp runs embeddings server-side with a single bundled model. Switching is not supported here (unlike the mobile on-device build).
                    </p>
                </div>
                <div className="border border-terminal/30 bg-terminal/5 rounded p-3 flex items-center justify-between">
                    <div>
                        <div className="text-[11px] font-bold text-text-primary">
                            {embedderInfo ? embedderInfo.modelId.split('/').pop() : '—'}
                        </div>
                        <div className="text-[9px] text-text-dim">
                            {embedderInfo
                                ? `${embedderInfo.dims}-dim · server-side · v${embedderInfo.embeddingVersion}`
                                : 'Loading…'}
                        </div>
                    </div>
                    <span className="text-[9px] text-terminal font-bold uppercase">Active</span>
                </div>
            </div>

            {/* Re-index embeddings */}
            <div className="bg-void p-4 border border-border rounded space-y-2">
                <div>
                    <label className="block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">
                        Re-index Embeddings
                    </label>
                    <p className="text-[9px] text-text-dim max-w-[280px] leading-tight">
                        Re-embeds stale or unversioned scene and lore vectors. Use after changing embedding models or if semantic search seems off.
                    </p>
                </div>
                <button
                    disabled={reindexing || !activeCampaignId}
                    onClick={handleReindex}
                    className="text-[10px] uppercase tracking-widest bg-terminal/10 border border-terminal/30 text-terminal px-3 py-1.5 rounded hover:bg-terminal/20 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
                >
                    {reindexing ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
                    {reindexing ? (reindexStatus || 'Re-indexing...') : 'Re-index Now'}
                </button>
                {embedStatus && !reindexing && (
                    <div className="text-[9px] text-text-dim">
                        Scenes: {embedStatus.scenes.current}/{embedStatus.scenes.total} current · Lore: {embedStatus.lore.current}/{embedStatus.lore.total} current
                        {embedStatus.scenes.stale > 0 && ` · ${embedStatus.scenes.stale + embedStatus.lore.stale} stale`}
                        {` (v${embedStatus.version})`}
                    </div>
                )}
                {!activeCampaignId && (
                    <p className="text-[9px] text-text-dim italic">Open a campaign to re-index its embeddings.</p>
                )}
            </div>

            {/* Rebuild rules embeddings */}
            <div className="bg-void p-4 border border-border rounded space-y-2">
                <div>
                    <label className="block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">
                        Rebuild Rules Embeddings
                    </label>
                    <p className="text-[9px] text-text-dim max-w-[280px] leading-tight">
                        Manually parse and re-embed rules markdown.
                    </p>
                </div>
                <button
                    disabled={rebuildingRules || !activeCampaignId}
                    onClick={handleRebuildRules}
                    className="text-[10px] uppercase tracking-widest bg-terminal/10 border border-terminal/30 text-terminal px-3 py-1.5 rounded hover:bg-terminal/20 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
                >
                    {rebuildingRules ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
                    {rebuildingRules ? 'Rebuilding...' : 'Rebuild Now'}
                </button>
            </div>
        </div>
    );
}