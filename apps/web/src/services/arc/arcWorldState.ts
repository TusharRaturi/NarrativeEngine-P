// Arc Engine — WO-05 world-state read-model (arcWorldState.ts).
// Pure, +0. A cheap read-model over fields that already exist — arcs + open threads
// (from computeOpenThreads) + NPC pressure. No new "arc object" detection, no prose
// parsing, no embeddings. The thread ledger the seal engine already writes IS the
// arc-liveness signal.
//
// Used by the WO-05 spawn gate at the seal seam: spawn is allowed ONLY when this is
// NOT 'live' (so an arc never fires on top of a live thread / live NPC pressure).
//
//   'live'    → an active arc ticked within ARC_LIVE_RECENCY, OR any NPC pressure
//               above threshold, OR an open thread advanced recently → SPAWN BLOCKED.
//   'stalled' → open threads exist but nothing advanced recently, no live arc →
//               may poke a stalled thread.
//   'dry'     → no active arcs, no open threads → may invent fresh.

import type { ArcRecord, ArcWorldState, NPCPressure } from '../../types';
import { ARC_LIVE_RECENCY, ARC_LIVE_PRESSURE_THRESHOLD } from './arcConstants';

function parseSceneId(s: string): number {
    if (!s) return 0;
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : 0;
}

function hasLivePressure(pressure: Record<string, NPCPressure>): boolean {
    for (const p of Object.values(pressure)) {
        if ((p.ignored ?? 0) > ARC_LIVE_PRESSURE_THRESHOLD) return true;
        if ((p.engaged ?? 0) > ARC_LIVE_PRESSURE_THRESHOLD) return true;
    }
    return false;
}

function hasRecentlyTickedArc(arcs: ArcRecord[], nowScene: number): boolean {
    for (const arc of arcs) {
        if (arc.status !== 'active') continue;
        const lastTick = parseSceneId(arc.lastTickScene);
        if (nowScene - lastTick <= ARC_LIVE_RECENCY && nowScene - lastTick >= 0) {
            return true;
        }
    }
    return false;
}

export function arcWorldState(
    arcs: ArcRecord[],
    openThreads: { text: string }[],
    pressure: Record<string, NPCPressure>,
    nowScene: number,
): ArcWorldState {
    const livePressure = hasLivePressure(pressure);
    const recentArcTick = hasRecentlyTickedArc(arcs, nowScene);

    if (livePressure || recentArcTick) return 'live';

    const hasOpenThreads = openThreads && openThreads.length > 0;
    const hasActiveArcs = arcs.some(a => a.status === 'active');

    if (hasOpenThreads || hasActiveArcs) return 'stalled';

    return 'dry';
}