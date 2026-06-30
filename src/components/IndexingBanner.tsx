import { Loader2 } from 'lucide-react';
import { useEmbeddingStatus, type EmbedJobKind } from '../hooks/useEmbeddingStatus';

const KIND_LABEL: Record<EmbedJobKind, string> = {
    lore: 'world lore',
    archive: 'archive',
    rules: 'rules',
};

/**
 * Thin status strip above the chat box shown while the retrieval model is warming up
 * or a bulk embed (e.g. a fresh world import) is running. Turns don't block on this —
 * retrieval falls back to keyword search until indexing finishes — so it's purely
 * informational. Renders nothing once the model is warm and no jobs are in flight.
 */
export function IndexingBanner({ campaignId }: { campaignId: string | null }) {
    const { modelReady, jobs } = useEmbeddingStatus(campaignId);

    const job = jobs[0];
    if (!job && modelReady) return null;

    let label: string;
    let pct: number | null = null;
    if (job) {
        const kinds = jobs.map((j) => KIND_LABEL[j.kind] ?? j.kind).join(' + ');
        label = `Indexing ${kinds}… ${job.done}/${job.total}`;
        pct = job.total > 0 ? Math.round((job.done / job.total) * 100) : null;
    } else {
        label = 'Warming up retrieval model…';
    }

    return (
        <div className="bg-terminal/10 border-b border-terminal/30 px-4 py-1.5 flex items-center gap-2.5">
            <Loader2 size={12} className="animate-spin text-terminal shrink-0" />
            <span className="text-terminal text-[11px] font-mono">{label}</span>
            {pct !== null && (
                <div className="flex-1 h-1 bg-terminal/15 rounded-full overflow-hidden max-w-[160px]">
                    <div className="h-full bg-terminal/70 transition-all duration-500" style={{ width: `${pct}%` }} />
                </div>
            )}
            <span className="ml-auto text-text-dim text-[10px] uppercase tracking-wider hidden sm:inline">
                Keyword search active
            </span>
        </div>
    );
}
