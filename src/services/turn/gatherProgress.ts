import { useSyncExternalStore } from 'react';

/**
 * Live tracker for in-flight context-gathering stages (LLM and non-LLM alike), so the
 * UI can show what's actually running during the CONTEXT phase instead of a static
 * "GATHERING CONTEXT". Purely ephemeral; mirrors the lightweight external-store pattern
 * used by utilityCallTracker.
 */
const active = new Set<string>();
const listeners = new Set<() => void>();
let snapshot: string[] = [];

function emit() {
    snapshot = [...active];
    for (const l of listeners) l();
}

export function beginGatherStage(label: string) {
    active.add(label);
    emit();
}

export function endGatherStage(label: string) {
    if (active.delete(label)) emit();
}

/** Reset — call at the start of a turn's gather so a prior aborted turn leaves no residue. */
export function clearGatherStages() {
    if (active.size === 0) return;
    active.clear();
    emit();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useGatherStages(): string[] {
    return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}
