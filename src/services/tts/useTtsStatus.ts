import { useEffect, useRef, useState } from 'react';
import { getTtsStatus, type TtsStatus } from './ttsClient';

/**
 * Tracks Kokoro model readiness. Polls /api/tts/status at an interval while the
 * component is mounted. Returns the latest status + a refresh trigger.
 *
 * The speaker button in MessageBubble uses this to decide whether to render.
 */
export function useTtsStatus(pollMs = 3000) {
    const [status, setStatus] = useState<TtsStatus | null>(null);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    useEffect(() => {
        let cancelled = false;

        const tick = () => {
            getTtsStatus()
                .then(s => { if (!cancelled) setStatus(s); })
                .catch(() => { /* best-effort; leave stale */ });
        };

        tick();
        timerRef.current = setInterval(tick, pollMs);

        return () => {
            cancelled = true;
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [pollMs]);

    return status;
}