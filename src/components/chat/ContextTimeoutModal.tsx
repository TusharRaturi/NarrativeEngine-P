import { AlertTriangle } from 'lucide-react';

interface ContextTimeoutModalProps {
    isOpen: boolean;
    onRetry: () => void;
    onContinuePartial: () => void;
    onCancel: () => void;
}

export function ContextTimeoutModal({ isOpen, onRetry, onContinuePartial, onCancel }: ContextTimeoutModalProps) {
    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-void border border-border rounded-xl shadow-2xl p-6 max-w-md w-full m-4">
                <div className="flex items-center gap-3 mb-4 text-amber">
                    <AlertTriangle size={24} />
                    <h2 className="text-lg font-bold">Context Timeout</h2>
                </div>
                
                <p className="text-void-100 text-sm mb-6">
                    Memory gathering took too long and timed out. This usually happens when the backend vector search is overloaded.
                    <br/><br/>
                    Do you want to retry gathering memories, or proceed with partial memory? (Proceeding may cause temporary amnesia for this turn).
                </p>

                <div className="flex flex-col gap-2">
                    <button
                        onClick={onRetry}
                        className="px-4 py-2 bg-amber text-void-dark font-bold rounded hover:bg-amber/90 transition-colors"
                    >
                        Retry Gathering
                    </button>
                    <button
                        onClick={onContinuePartial}
                        className="px-4 py-2 bg-void-dark text-void-100 font-bold rounded border border-border hover:bg-void-darker transition-colors"
                    >
                        Continue with Partial Memory
                    </button>
                    <button
                        onClick={onCancel}
                        className="px-4 py-2 mt-2 text-void-300 text-xs uppercase tracking-widest hover:text-void-100 transition-colors"
                    >
                        Cancel Turn
                    </button>
                </div>
            </div>
        </div>
    );
}
