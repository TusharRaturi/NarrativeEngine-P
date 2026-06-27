import { ScrollText, Settings2 } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { PayloadTraceView } from '../PayloadTraceView';
import { SceneNoteEditor } from '../SceneNoteEditor';
import { countTokens } from '../../services/infrastructure/tokenizer';

export function RulesTab({ onOpenManager }: { onOpenManager?: () => void }) {
    const context = useAppStore((s) => s.context);
    const updateContext = useAppStore((s) => s.updateContext);
    const settings = useAppStore((s) => s.settings);

    const rulesBudgetPct = settings.rulesBudgetPct ?? 0.10;
    const contextLimit = settings.contextLimit || 8192;
    const rulesBudget = Math.floor(contextLimit * rulesBudgetPct);
    const threshold = Math.floor(rulesBudget * 1.2);
    const tokenCount = countTokens(context.rulesRaw);
    const ragActive = tokenCount > threshold;
    const usingDefaults = !context.rulesRaw;

    return (
        <div className="px-4 py-4 space-y-4">
            <div>
                <label className="flex items-center gap-2 text-[11px] text-ice uppercase tracking-wider mb-2">
                    <ScrollText size={13} />
                    Rules / Mechanics
                </label>
                {usingDefaults && (
                    <div className="text-[10px] text-terminal/80 mb-2">
                        Using built-in default rules. Paste your own below to override.
                    </div>
                )}
                <textarea
                    value={context.rulesRaw}
                    onChange={(e) => updateContext({ rulesRaw: e.target.value })}
                    placeholder="Paste game rules, mechanics, character stats..."
                    rows={6}
                    className="w-full bg-void border border-border px-3 py-2 text-xs text-text-primary placeholder:text-text-dim/40 font-mono resize-y"
                />
                <div className="flex items-center justify-between mt-1 text-[10px] font-mono text-text-dim">
                    <span>{tokenCount.toLocaleString()} tok</span>
                    <span className={ragActive ? 'text-terminal font-bold' : 'text-text-dim/60'}>
                        {ragActive ? 'RAG active' : 'verbatim'}
                    </span>
                </div>
                {ragActive && (
                    <div className="mt-1.5 flex items-center justify-between border border-terminal/20 bg-terminal/5 px-2 py-1 rounded-sm text-[9px]">
                        <span className="text-terminal-dim">
                            Budget: {rulesBudget} tok/turn
                        </span>
                        {onOpenManager && (
                            <button
                                onClick={onOpenManager}
                                className="flex items-center gap-1 text-terminal hover:text-text-primary transition-colors font-bold uppercase tracking-wider bg-terminal/10 px-1.5 py-0.5 rounded-sm"
                            >
                                <Settings2 size={10} />
                                Manage
                            </button>
                        )}
                    </div>
                )}
            </div>

            <div className="pt-4 border-t border-border/50">
                <SceneNoteEditor />
            </div>

            {settings.debugMode && (
                <div className="pt-4 border-t border-border">
                    <div className="text-[10px] text-terminal uppercase tracking-widest font-bold mb-2 flex items-center gap-2">
                        <div className="w-1.5 h-1.5 rounded-full bg-terminal animate-pulse" />
                        Diagnostics
                    </div>
                    <PayloadTraceView />
                </div>
            )}
        </div>
    );
}
