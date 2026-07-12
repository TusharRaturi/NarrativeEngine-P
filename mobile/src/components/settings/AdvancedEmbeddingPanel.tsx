import { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight, Download } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { switchEmbeddingModel, getCurrentModelId, runFullReindex, rebuildAllEmbeddings } from '../../services/embedding';
import type { DownloadProgress } from '../../services/embedding';
import { embeddingStorage } from '../../services/storage/embeddingStorage';
import { toast } from '../Toast';

export function AdvancedEmbeddingPanel() {
    const settings = useAppStore(s => s.settings);
    const updateSettings = useAppStore(s => s.updateSettings);
    const activeCampaignId = useAppStore(s => s.activeCampaignId);

    const [advancedOpen, setAdvancedOpen] = useState(false);
    const [embeddingSwitching, setEmbeddingSwitching] = useState(false);
    const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
    const [reindexProgress, setReindexProgress] = useState<{ done: number; total: number } | null>(null);
    const [showConfirmDialog, setShowConfirmDialog] = useState<'toHigh' | 'toStandard' | null>(null);
    const [showCacheConfirm, setShowCacheConfirm] = useState(false);
    const [vectorCounts, setVectorCounts] = useState<Record<string, number> | null>(null);

    useEffect(() => {
        if (!advancedOpen || !activeCampaignId) {
            setVectorCounts(null);
            return;
        }
        let cancelled = false;
        embeddingStorage.countByModel(activeCampaignId)
            .then(counts => { if (!cancelled) setVectorCounts(counts); })
            .catch(() => { if (!cancelled) setVectorCounts({}); });
        return () => { cancelled = true; };
    }, [advancedOpen, activeCampaignId, embeddingSwitching, reindexProgress?.done]);

    const handleSwitchModel = async (target: 'standard' | 'high') => {
        setShowConfirmDialog(null);
        setEmbeddingSwitching(true);
        setDownloadProgress(null);
        setReindexProgress(null);
        try {
            if (target === 'high') {
                await switchEmbeddingModel('high', (progress) => {
                    setDownloadProgress(progress);
                });
            } else {
                await switchEmbeddingModel('standard');
            }
            const cid = useAppStore.getState().activeCampaignId;
            if (cid) {
                useAppStore.getState().setEmbeddingsReindexing({ active: true, total: 0, done: 0, reason: 'switch' });
                setReindexProgress({ done: 0, total: 0 });
                await runFullReindex(cid, (p) => {
                    setReindexProgress({ done: p.done, total: p.total });
                    useAppStore.getState().setEmbeddingsReindexing({ active: true, total: p.total, done: p.done, reason: 'switch' });
                });
                useAppStore.getState().setEmbeddingsReindexing({ active: false, total: 0, done: 0, reason: null });
            }
            updateSettings({ embeddingModel: target });
            toast.success(target === 'high'
                ? 'Switched to high-quality embeddings'
                : 'Switched to standard embeddings');
        } catch (e) {
            toast.error(`Failed to switch: ${e instanceof Error ? e.message : String(e)}`);
            useAppStore.getState().setEmbeddingsReindexing({ active: false, total: 0, done: 0, reason: null });
        } finally {
            setEmbeddingSwitching(false);
            setDownloadProgress(null);
            setReindexProgress(null);
        }
    };

    return (
        <div className="space-y-8">
            <div className="bg-void p-4 border border-border rounded">
                <button
                    className="w-full flex items-center justify-between"
                    onClick={() => setAdvancedOpen(!advancedOpen)}
                >
                    <label className="text-[11px] text-text-primary uppercase tracking-wider font-bold">Advanced</label>
                    {advancedOpen ? <ChevronDown size={16} className="text-text-dim" /> : <ChevronRight size={16} className="text-text-dim" />}
                </button>

                {advancedOpen && (
                    <div className="mt-4 pt-4 border-t border-border/60 space-y-3">
                        <label className="block text-[10px] text-text-dim uppercase tracking-widest mb-2">Embedding Model</label>

                        <div className="space-y-2">
                            <button
                                disabled={embeddingSwitching || settings.embeddingModel === 'standard'}
                                onClick={() => {
                                    if (settings.embeddingModel === 'high') setShowConfirmDialog('toStandard');
                                }}
                                className={`w-full flex items-center justify-between p-3 border rounded text-left transition-colors ${
                                    settings.embeddingModel !== 'high'
                                        ? 'border-terminal bg-terminal/5 text-text-primary'
                                        : 'border-border bg-surface text-text-dim hover:border-terminal/50'
                                }`}
                            >
                                <div>
                                    <div className="text-[11px] font-bold">Standard</div>
                                    <div className="text-[9px] opacity-70">384-dim · ~23MB · bundled</div>
                                </div>
                                {settings.embeddingModel !== 'high' && <span className="text-[9px] text-terminal font-bold uppercase">Active</span>}
                            </button>

                            <button
                                disabled={embeddingSwitching || settings.embeddingModel === 'high'}
                                onClick={() => {
                                    if (settings.embeddingModel !== 'high') setShowConfirmDialog('toHigh');
                                }}
                                className={`w-full flex items-center justify-between p-3 border rounded text-left transition-colors ${
                                    settings.embeddingModel === 'high'
                                        ? 'border-terminal bg-terminal/5 text-text-primary'
                                        : 'border-border bg-surface text-text-dim hover:border-terminal/50'
                                }`}
                            >
                                <div>
                                    <div className="text-[11px] font-bold">High quality</div>
                                    <div className="text-[9px] opacity-70">768-dim · ~110MB · download on demand</div>
                                </div>
                                {settings.embeddingModel === 'high'
                                    ? <span className="text-[9px] text-terminal font-bold uppercase">Active</span>
                                    : <span className="text-[9px] text-text-dim"><Download size={12} className="inline" /></span>
                                }
                            </button>
                        </div>

                        {activeCampaignId && vectorCounts !== null && (() => {
                            const currentModel = settings.embeddingModel === 'high' ? 'Xenova/bge-base-en-v1.5' : 'Xenova/all-MiniLM-L6-v2';
                            const upToDate = vectorCounts[currentModel] ?? 0;
                            const staleEntries = Object.entries(vectorCounts).filter(([m]) => m !== currentModel);
                            const staleTotal = staleEntries.reduce((sum, [, n]) => sum + n, 0);
                            const total = upToDate + staleTotal;
                            return (
                                <div className="mt-3 space-y-1">
                                    <div className="text-[10px] text-text-dim uppercase tracking-widest">Storage status (this campaign)</div>
                                    {total === 0 ? (
                                        <div className="text-[10px] text-amber-400">
                                            No embeddings stored — semantic retrieval is offline. Tap "Rebuild ALL" below to fix.
                                        </div>
                                    ) : (
                                        <>
                                            <div className="text-[10px] text-text-primary">
                                                <span className="text-terminal">{upToDate}</span> vectors on current model
                                            </div>
                                            {staleTotal > 0 && (
                                                <div className="text-[10px] text-amber-400">
                                                    {staleTotal} vector{staleTotal === 1 ? '' : 's'} on older model{staleEntries.length > 1 ? 's' : ''} — re-index needed
                                                </div>
                                            )}
                                            {staleTotal === 0 && (
                                                <div className="text-[10px] text-text-dim">All up to date ✓</div>
                                            )}
                                        </>
                                    )}
                                    <button
                                        disabled={embeddingSwitching || staleTotal === 0}
                                        onClick={async () => {
                                            setEmbeddingSwitching(true);
                                            setReindexProgress({ done: 0, total: 0 });
                                            useAppStore.getState().setEmbeddingsReindexing({ active: true, total: 0, done: 0, reason: 'switch' });
                                            try {
                                                await runFullReindex(activeCampaignId, (p) => {
                                                    setReindexProgress({ done: p.done, total: p.total });
                                                    useAppStore.getState().setEmbeddingsReindexing({ active: true, total: p.total, done: p.done, reason: 'switch' });
                                                });
                                                toast.success('Re-index complete');
                                                const fresh = await embeddingStorage.countByModel(activeCampaignId);
                                                setVectorCounts(fresh);
                                            } catch (e) {
                                                toast.error(`Re-index failed: ${e instanceof Error ? e.message : String(e)}`);
                                            } finally {
                                                useAppStore.getState().setEmbeddingsReindexing({ active: false, total: 0, done: 0, reason: null });
                                                setEmbeddingSwitching(false);
                                                setReindexProgress(null);
                                            }
                                        }}
                                        className="mt-2 w-full px-3 py-2 text-[10px] border border-border rounded text-text-primary hover:border-terminal hover:bg-terminal/5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                        {staleTotal === 0 ? 'Re-index now (nothing to do)' : `Re-index ${staleTotal} stale vector${staleTotal === 1 ? '' : 's'} now`}
                                    </button>
                                    <button
                                        disabled={embeddingSwitching}
                                        onClick={async () => {
                                            setEmbeddingSwitching(true);
                                            setReindexProgress({ done: 0, total: 0 });
                                            useAppStore.getState().setEmbeddingsReindexing({ active: true, total: 0, done: 0, reason: 'switch' });
                                            try {
                                                const counts = await rebuildAllEmbeddings(activeCampaignId, (p) => {
                                                    setReindexProgress({ done: p.done, total: p.total });
                                                    useAppStore.getState().setEmbeddingsReindexing({ active: true, total: p.total, done: p.done, reason: 'switch' });
                                                });
                                                toast.success(`Rebuilt: ${counts.scenes} scenes, ${counts.lore} lore, ${counts.npcs} NPCs, ${counts.rules} rules`);
                                                const fresh = await embeddingStorage.countByModel(activeCampaignId);
                                                setVectorCounts(fresh);
                                            } catch (e) {
                                                toast.error(`Rebuild failed: ${e instanceof Error ? e.message : String(e)}`);
                                            } finally {
                                                useAppStore.getState().setEmbeddingsReindexing({ active: false, total: 0, done: 0, reason: null });
                                                setEmbeddingSwitching(false);
                                                setReindexProgress(null);
                                            }
                                        }}
                                        className="mt-1 w-full px-3 py-2 text-[10px] border border-amber-500/50 rounded text-amber-400 hover:bg-amber-500/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                        Rebuild ALL embeddings from source (recovery)
                                    </button>
                                    <div className="text-[9px] text-text-dim/70 italic">
                                        Current model: {getCurrentModelId().split('/').pop()}
                                    </div>
                                </div>
                            );
                        })()}

                        {downloadProgress && embeddingSwitching && !reindexProgress && (
                            <div className="mt-2">
                                <div className="flex justify-between text-[9px] text-text-dim mb-1">
                                    <span>Downloading model…</span>
                                    <span>{downloadProgress.aggregateTotal > 0 ? ((downloadProgress.aggregateLoaded / downloadProgress.aggregateTotal) * 100).toFixed(0) : '0'}%</span>
                                </div>
                                <div className="w-full bg-border rounded-full h-2 overflow-hidden">
                                    <div className="bg-terminal h-full transition-all" style={{ width: `${downloadProgress.aggregateTotal > 0 ? (downloadProgress.aggregateLoaded / downloadProgress.aggregateTotal) * 100 : 0}%` }} />
                                </div>
                            </div>
                        )}

                        {reindexProgress && embeddingSwitching && (
                            <div className="mt-2">
                                <div className="flex justify-between text-[9px] text-text-dim mb-1">
                                    <span>Re-indexing lore…</span>
                                    <span>{reindexProgress.done}/{reindexProgress.total}</span>
                                </div>
                                <div className="w-full bg-border rounded-full h-2 overflow-hidden">
                                    <div className="bg-terminal h-full transition-all" style={{ width: `${reindexProgress.total > 0 ? (reindexProgress.done / reindexProgress.total) * 100 : 0}%` }} />
                                </div>
                            </div>
                        )}

                        <button
                            onClick={() => setShowCacheConfirm(true)}
                            className="text-[10px] text-text-dim hover:text-danger transition-colors mt-2"
                        >
                            Clear cached embedding models
                        </button>
                    </div>
                )}
            </div>

            {showConfirmDialog === 'toHigh' && (
                <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm">
                    <div className="bg-surface border border-border rounded-lg p-6 max-w-sm mx-4 shadow-2xl">
                        <h3 className="text-text-primary font-bold text-sm mb-3">Switch to high-quality embeddings?</h3>
                        <ul className="text-[11px] text-text-dim space-y-1 mb-4">
                            <li>Better lore retrieval, especially for fuzzy queries</li>
                            <li>One-time ~110MB download from HuggingFace (Wi-Fi recommended)</li>
                            <li>Recommended for phones from 2022+ with 6GB+ RAM</li>
                            <li>Your current campaign will be re-indexed (~2–5 min). <strong className="text-text-primary">AI turns are paused during re-index.</strong></li>
                            <li>Other campaigns re-index when you open them.</li>
                        </ul>
                        <div className="flex gap-2 justify-end">
                            <button onClick={() => setShowConfirmDialog(null)} className="px-4 py-2 text-[11px] border border-border rounded text-text-dim hover:text-text-primary">Cancel</button>
                            <button
                                onClick={() => handleSwitchModel('high')}
                                className="px-4 py-2 text-[11px] bg-terminal text-void rounded font-bold hover:bg-terminal/90"
                            >
                                Download &amp; Switch
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {showConfirmDialog === 'toStandard' && (
                <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm">
                    <div className="bg-surface border border-border rounded-lg p-6 max-w-sm mx-4 shadow-2xl">
                        <h3 className="text-text-primary font-bold text-sm mb-3">Switch back to standard embeddings?</h3>
                        <ul className="text-[11px] text-text-dim space-y-1 mb-4">
                            <li>Your current campaign will be re-indexed with the smaller model (~1–2 min).</li>
                            <li>The 110MB model stays cached on your device in case you switch back.</li>
                        </ul>
                        <div className="flex gap-2 justify-end">
                            <button onClick={() => setShowConfirmDialog(null)} className="px-4 py-2 text-[11px] border border-border rounded text-text-dim hover:text-text-primary">Cancel</button>
                            <button
                                onClick={() => handleSwitchModel('standard')}
                                className="px-4 py-2 text-[11px] bg-terminal text-void rounded font-bold hover:bg-terminal/90"
                            >
                                Switch
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {showCacheConfirm && (
                <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm">
                    <div className="bg-surface border border-border rounded-lg p-6 max-w-sm mx-4 shadow-2xl">
                        <h3 className="text-text-primary font-bold text-sm mb-3">Clear cached embedding models?</h3>
                        <p className="text-[11px] text-text-dim mb-4">This will delete all downloaded model files from cache storage. The standard model is bundled and will still work. Switching to high quality later will require re-downloading ~110MB.</p>
                        <div className="flex gap-2 justify-end">
                            <button onClick={() => setShowCacheConfirm(false)} className="px-4 py-2 text-[11px] border border-border rounded text-text-dim hover:text-text-primary">Cancel</button>
                            <button
                                onClick={async () => {
                                    try {
                                        if ('caches' in window) {
                                            const cacheNames = await caches.keys();
                                            for (const name of cacheNames) {
                                                if (/transformers/i.test(name) || /Xenova/i.test(name) || /bge-base/i.test(name) || /MiniLM/i.test(name)) {
                                                    await caches.delete(name);
                                                }
                                            }
                                        }
                                        toast.success('Cached models cleared');
                                    } catch (_e) {
                                        toast.error('Failed to clear cache');
                                    }
                                    setShowCacheConfirm(false);
                                }}
                                className="px-4 py-2 text-[11px] bg-danger text-white rounded font-bold hover:bg-danger/90"
                            >
                                Clear Cache
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}