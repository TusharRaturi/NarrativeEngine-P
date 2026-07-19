import type { RefObject } from 'react';
import { ChevronUp, ArrowDown } from 'lucide-react';

/**
 * WO-NAV — floating message-navigation buttons: jump up one message,
 * or snap back to the latest. Owns the scroll-walking logic.
 */
export function ChatNavFabs({
    scrollContainerRef,
    bottomRef,
}: {
    scrollContainerRef: RefObject<HTMLDivElement | null>;
    bottomRef: RefObject<HTMLDivElement | null>;
}) {
    const handlePrevMessage = () => {
        const sc = scrollContainerRef.current;
        if (!sc) return;
        // Find the last bubble whose bottom is above the current viewport top (i.e. previous).
        const bubbles = Array.from(sc.querySelectorAll<HTMLElement>('[data-message-id], .chat-bubble-base'));
        const viewTop = sc.scrollTop;
        let target: HTMLElement | null = null;
        for (const b of bubbles) {
            const top = b.offsetTop;
            if (top < viewTop - 4) target = b;
            else break;
        }
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        else sc.scrollTo({ top: 0, behavior: 'smooth' });
    };

    const handleJumpToBottom = () => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    return (
        <div className="absolute right-3 bottom-[145px] flex flex-col gap-1.5 z-30 pointer-events-auto">
            <button
                onClick={handlePrevMessage}
                className="chat-nav-fab flex items-center justify-center w-9 h-9 rounded-full bg-void-darker border border-text-dim/30 hover:border-text-dim text-text-dim hover:text-text-primary shadow-lg transition-all hover:bg-text-dim/10"
                title="Jump up one message"
            >
                <ChevronUp size={16} />
            </button>
            <button
                onClick={handleJumpToBottom}
                className="chat-nav-fab flex items-center justify-center w-9 h-9 rounded-full bg-void-darker border border-text-dim/30 hover:border-text-dim text-text-dim hover:text-text-primary shadow-lg transition-all hover:bg-text-dim/10"
                title="Jump to latest message"
            >
                <ArrowDown size={16} />
            </button>
        </div>
    );
}
