/**
 * Empty-chat placeholder shown before the first message: the "Awaiting
 * transmission" banner plus the Create Character entry point.
 */
export function ChatEmptyState({ onCreateCharacter }: { onCreateCharacter: () => void }) {
    return (
        <div className="flex items-center justify-center h-full">
            <div className="text-center space-y-3">
                <div className="text-4xl">⚔</div>
                <p className="text-text-dim text-xs uppercase tracking-widest">
                    Awaiting transmission...
                </p>
                <div className="space-y-2">
                    <button
                        onClick={onCreateCharacter}
                        className="block w-full px-6 py-2.5 bg-terminal/20 text-terminal border border-terminal/30 rounded hover:bg-terminal/30 transition-colors text-[11px] uppercase tracking-widest"
                    >
                        Create Character
                    </button>
                    <p className="text-text-dim/50 text-[10px]">
                        Or paste your lore in the context drawer, configure your LLM, and begin.
                    </p>
                </div>
            </div>
        </div>
    );
}
