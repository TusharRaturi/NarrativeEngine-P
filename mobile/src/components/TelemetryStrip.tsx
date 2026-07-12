import { useAppStore } from '../store/useAppStore';
import { useUtilityCalls, extendCall } from '../services/llm/utilityCallTracker';
import type { PipelinePhase, StreamingStats } from '../types';

function formatElapsed(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

type Props = {
    phase: PipelinePhase;
    stats: StreamingStats | null;
    loadingStatus: string | null;
};

export function TelemetryStrip({ phase, stats, loadingStatus }: Props) {
    const { active } = useUtilityCalls();

    if (phase === 'idle' && active.length === 0 && !loadingStatus) return null;

    const isGenerating = phase === 'generating' || phase === 'checking-notes';
    const modelName = useAppStore.getState().getActiveStoryEndpoint?.()?.modelName;

    return (
        <div className="flex items-center gap-2 px-3 py-0.5 bg-void-lighter/30 border-t border-border/30 text-text-dim text-[9px] uppercase tracking-wider font-mono">
            {isGenerating && (
                <>
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-terminal animate-pulse" />
                    <span className="text-text-dim/70">generating</span>
                    {modelName && (
                        <>
                            <span className="text-text-dim/30">·</span>
                            <span className="text-text-dim/50 normal-case truncate max-w-[120px]">{modelName}</span>
                        </>
                    )}
                    {stats && stats.tokens > 0 && (
                        <>
                            <span className="text-text-dim/30">·</span>
                            <span className="tabular-nums">{stats.tokens} tok</span>
                            <span className="text-text-dim/30">·</span>
                            <span className="tabular-nums">{formatElapsed(stats.elapsed)}</span>
                        </>
                    )}
                </>
            )}

            {phase !== 'idle' && phase !== 'generating' && phase !== 'checking-notes' && (
                <>
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                    <span className="text-text-dim/70">{phase.replace(/-/g, ' ')}</span>
                </>
            )}

            {loadingStatus && (
                <>
                    <span className="text-text-dim/30">·</span>
                    <span className="text-text-dim/60">{loadingStatus}</span>
                </>
            )}

            {active.length > 0 && (
                <div className="ml-auto flex items-center gap-2 shrink-0">
                    {active.map((call) => {
                        const remaining = Math.max(0, Math.floor((call.deadline - Date.now()) / 1000));
                        const label = call.label === 'story-generation' ? 'gen' : call.label;
                        return (
                            <span key={call.id} className="flex items-center gap-1">
                                <span className="inline-block w-1 h-1 rounded-full bg-terminal/60 animate-pulse" />
                                <span className="text-text-dim/50">{label}</span>
                                <span className="text-text-dim/30">{remaining}s</span>
                                <button
                                    onClick={() => extendCall(call.id, 60000)}
                                    className="text-text-dim/40 hover:text-terminal text-[8px] border border-terminal/20 rounded px-1 transition-colors"
                                >
                                    +1m
                                </button>
                            </span>
                        );
                    })}
                </div>
            )}
        </div>
    );
}