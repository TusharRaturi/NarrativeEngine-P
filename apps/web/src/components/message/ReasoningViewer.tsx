import { Loader2 } from 'lucide-react';

/**
 * Reasoning accordion — collapsible "Cognitive Process" block showing the
 * model's <think> content on GM messages when Show Reasoning is enabled.
 */
export function ReasoningViewer({ thinkingBlock, spinning }: { thinkingBlock: string; spinning: boolean }) {
    return (
        <details className="mb-3 bg-void-darker border border-terminal/20 rounded overflow-hidden">
            <summary className="cursor-pointer p-2 text-[10px] text-terminal/60 hover:text-terminal transition-colors select-none uppercase tracking-widest flex items-center gap-2 bg-terminal/5">
                <Loader2 size={10} className={spinning ? "animate-spin" : ""} />
                Cognitive Process
            </summary>
            <div className="p-3 text-[11px] text-text-dim/80 italic border-t border-terminal/10 max-h-[300px] overflow-y-auto whitespace-pre-wrap leading-relaxed">
                {thinkingBlock}
            </div>
        </details>
    );
}
