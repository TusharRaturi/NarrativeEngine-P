import { useEffect, useRef, useState } from 'react';
import { API_BASE as API } from '../lib/apiBase';

export type EmbedJobKind = 'lore' | 'archive' | 'rules';

export type EmbedJob = {
    campaignId: string;
    kind: EmbedJobKind;
    done: number;
    total: number;
    startedAt: number;
};

export type EmbeddingRuntime = {
    modelReady: boolean;
    jobs: EmbedJob[];
};

const ACTIVE_MS = 1500;   // poll fast while the model is cold or a bulk embed runs
const IDLE_MS = 8000;     // back off when warm + idle (still catches a later import)

/**
 * Polls the server's embedder runtime so the UI can surface indexing progress.
 * Adaptive cadence: fast while warming/working, slow when idle. Starts optimistic
 * (ready, no jobs) so nothing flashes before the first poll resolves.
 */
export function useEmbeddingStatus(campaignId: string | null): EmbeddingRuntime {
    const [runtime, setRuntime] = useState<EmbeddingRuntime>({ modelReady: true, jobs: [] });
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        let cancelled = false;

        const poll = async () => {
            let next = IDLE_MS;
            try {
                const qs = campaignId ? `?campaignId=${encodeURIComponent(campaignId)}` : '';
                const res = await fetch(`${API}/embedding/runtime${qs}`);
                if (res.ok) {
                    const data = (await res.json()) as EmbeddingRuntime;
                    if (!cancelled) setRuntime(data);
                    next = !data.modelReady || data.jobs.length > 0 ? ACTIVE_MS : IDLE_MS;
                }
            } catch {
                next = IDLE_MS;
            }
            if (!cancelled) timerRef.current = setTimeout(poll, next);
        };

        poll();
        return () => {
            cancelled = true;
            if (timerRef.current) clearTimeout(timerRef.current);
        };
    }, [campaignId]);

    return runtime;
}
