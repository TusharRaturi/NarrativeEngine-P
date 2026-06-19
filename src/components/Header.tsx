import { useState, useEffect } from 'react';
import { Settings, PanelLeftOpen, PanelLeftClose, LogOut, Users, Archive, Save, ScanSearch, BookCheck, Pin, Replace, UserPlus, Loader2 } from 'lucide-react';
import { createBackup } from '../store/campaignStore';
import { flushAllPendingSaves } from '../store/slices/campaignSlice';
import { toast } from './Toast';
import { useAppStore } from '../store/useAppStore';
import { TokenGauge } from './TokenGauge';
import { saveCampaignState } from '../store/campaignStore';
import { addNpcFromSelection } from '../services/npc/manualAdd';

type SelectionSnapshot = {
    messageId: string;
    text: string;
    start: number;
    end: number;
    bubbleText: string;
};

const stripMarkdown = (s: string) => s.replace(/\*\*/g, '').replace(/\*/g, '').trim();

export function Header() {
    const {
        toggleSettings,
        toggleDrawer,
        toggleNPCLedger,
        toggleBackupModal,
        togglePinnedMemories,
        drawerOpen,
        activeCampaignId,
        setActiveCampaign,
        context,
        messages,
        condenser,
        divergenceRegister,
        addPinnedExcerpt,
        openRenameModal,
    } = useAppStore();

    const deepArmed = useAppStore(s => s.deepArmed);
    const toggleDeepArmed = useAppStore(s => s.toggleDeepArmed);
    const settings = useAppStore(s => s.settings);
    const openLoreCheck = useAppStore(s => s.openLoreCheck);
    const pinnedExcerpts = useAppStore(s => s.pinnedExcerpts);

    const [loreSel, setLoreSel] = useState<SelectionSnapshot | null>(null);
    const [pinSel, setPinSel] = useState<SelectionSnapshot | null>(null);
    const [renameSel, setRenameSel] = useState<SelectionSnapshot | null>(null);
    const [npcSel, setNpcSel] = useState<SelectionSnapshot | null>(null);
    const [npcAdding, setNpcAdding] = useState(false);

    const captureFromBubble = (selector: string): SelectionSnapshot | null => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
        const range = sel.getRangeAt(0);
        const node = range.commonAncestorContainer;
        const el = (node.nodeType === 1 ? node as Element : node.parentElement);
        const bubble = el?.closest(selector) as HTMLElement | null;
        if (!bubble) return null;
        const messageId = bubble.dataset.messageId;
        const text = sel.toString().trim();
        if (!messageId || text.length < 1) return null;
        const bubbleText = bubble.textContent ?? '';
        let start = bubbleText.indexOf(text);
        if (start === -1) {
            const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
            start = norm(bubbleText).indexOf(norm(text));
        }
        if (start === -1) start = 0;
        return { messageId, text, start, end: start + text.length, bubbleText };
    };

    useEffect(() => {
        const handle = () => {
            setLoreSel(captureFromBubble('[data-lore-checkable="true"]'));
            setPinSel(captureFromBubble('[data-message-id]'));
            setRenameSel(captureFromBubble('[data-message-id]'));
            setNpcSel(captureFromBubble('[data-lore-checkable="true"]'));
        };
        document.addEventListener('selectionchange', handle);
        return () => document.removeEventListener('selectionchange', handle);
    }, []);

    const handleLoreCheck = (e: React.MouseEvent | React.TouchEvent) => {
        e.preventDefault();
        const snap = captureFromBubble('[data-lore-checkable="true"]') ?? loreSel;
        if (!snap) return;
        const before = snap.bubbleText.slice(Math.max(0, snap.start - 200), snap.start);
        const after = snap.bubbleText.slice(snap.end, Math.min(snap.bubbleText.length, snap.end + 200));
        openLoreCheck({
            messageId: snap.messageId, selectedText: stripMarkdown(snap.text),
            start: snap.start, end: snap.end,
            surroundingContext: `${before}[[HIGHLIGHTED]]${snap.text}[[/HIGHLIGHTED]]${after}`,
        });
        window.getSelection()?.removeAllRanges();
        setLoreSel(null);
        setPinSel(null);
    };

    const handlePinSelection = (e: React.MouseEvent | React.TouchEvent) => {
        e.preventDefault();
        const snap = captureFromBubble('[data-message-id]') ?? pinSel;
        if (!snap) return;
        const result = addPinnedExcerpt(snap.messageId, snap.text, false);
        if (result.ok) {
            window.getSelection()?.removeAllRanges();
            setPinSel(null);
            setLoreSel(null);
        } else {
            toast.warning(result.reason);
        }
    };

    const handleRenameSelection = (e: React.MouseEvent | React.TouchEvent) => {
        e.preventDefault();
        const snap = captureFromBubble('[data-message-id]') ?? renameSel;
        if (!snap) return;
        openRenameModal(stripMarkdown(snap.text));
        window.getSelection()?.removeAllRanges();
        setRenameSel(null);
        setPinSel(null);
        setLoreSel(null);
    };

    const handleAddNpc = async (e: React.MouseEvent | React.TouchEvent) => {
        e.preventDefault();
        if (npcAdding) return;
        const snap = captureFromBubble('[data-lore-checkable="true"]') ?? npcSel;
        if (!snap) return;
        const state = useAppStore.getState();
        const campaignId = state.activeCampaignId;
        if (!campaignId) { toast.warning('No active campaign.'); return; }

        window.getSelection()?.removeAllRanges();
        setNpcSel(null);
        setLoreSel(null);
        setPinSel(null);
        setNpcAdding(true);
        const cleanName = stripMarkdown(snap.text);
        toast.info(`Resolving "${cleanName}"…`);
        try {
            const result = await addNpcFromSelection({
                rawText: cleanName,
                ledger: state.npcLedger ?? [],
                messages: state.messages,
                campaignId,
                storyProvider: state.getActiveStoryEndpoint(),
                updateProvider: state.getActiveSummarizerEndpoint() ?? state.getActiveUtilityEndpoint() ?? state.getActiveStoryEndpoint(),
                addNPC: state.addNPC,
                updateNPC: state.updateNPC,
            });
            if (result.ok) toast.success(result.message);
            else if (result.kind === 'ambiguous') toast.warning(result.message);
            else toast.error(result.message);
        } catch (err) {
            toast.error(`Add NPC failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setNpcAdding(false);
        }
    };

    const handleExit = async () => {
        if (activeCampaignId) {
            await saveCampaignState(activeCampaignId, { context, messages, condenser, pinnedExcerpts });
            if (divergenceRegister && (divergenceRegister.entries.length > 0 || (divergenceRegister.prunedLog ?? []).length > 0)) {
                try {
                    const { saveDivergenceRegister } = await import('../store/campaignStore');
                    await saveDivergenceRegister(activeCampaignId, divergenceRegister);
                } catch (e) { console.warn('[Header] saveDivergenceRegister failed:', e); }
            }
        }
        setActiveCampaign(null);
    };

    return (
        <header className="h-12 bg-surface border-b border-border flex items-center px-2 sm:px-4 gap-1 sm:gap-2 shrink-0">
            <button
                onClick={toggleDrawer}
                className="text-text-dim hover:text-terminal transition-colors p-1"
                title={drawerOpen ? 'Close context drawer' : 'Open context drawer'}
                aria-label={drawerOpen ? 'Close context drawer' : 'Open context drawer'}
            >
                {drawerOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
            </button>

            <h1 className="hidden md:block text-terminal text-sm font-bold tracking-[0.3em] uppercase glow-green shrink-0">
                Narrative Engine
            </h1>

            <div className="hidden md:flex flex-1 items-center gap-4">
                <TokenGauge />
            </div>

            <button
                onClick={async () => {
                    if (!activeCampaignId) return;
                    await flushAllPendingSaves();
                    const result = await createBackup(activeCampaignId, { trigger: 'manual', label: 'Manual backup' });
                    if (result?.skipped) {
                        toast.info('No changes since last backup');
                    } else if (result?.timestamp) {
                        toast.success('Backup created');
                    } else {
                        toast.error('Failed to create backup');
                    }
                }}
                className="text-text-dim hover:text-terminal transition-colors p-1"
                title="Create backup"
                aria-label="Create backup"
            >
                <Save size={16} />
            </button>

            <button
                onClick={toggleBackupModal}
                className="text-text-dim hover:text-terminal transition-colors p-1"
                title="Backup manager"
                aria-label="Open backup manager"
            >
                <Archive size={16} />
            </button>

            <button
                onClick={toggleNPCLedger}
                className="text-text-dim hover:text-terminal transition-colors p-1"
                title="NPC Ledger"
                aria-label="Open NPC Ledger"
            >
                <Users size={18} />
            </button>

            {settings.deepContextSearch && (
                <button
                    onClick={toggleDeepArmed}
                    className={`p-1 transition-colors ${deepArmed ? 'text-amber-400 animate-pulse' : 'text-text-dim hover:text-amber-400'}`}
                    title={deepArmed ? 'Deep Search armed — send to activate' : 'Arm Deep Archive Search'}
                    aria-label="Toggle Deep Archive Search"
                >
                    <ScanSearch size={18} />
                </button>
            )}

            <button
                onMouseDown={handleLoreCheck}
                className={`transition-colors p-1 ${loreSel ? 'text-terminal animate-pulse' : 'text-text-dim hover:text-terminal'}`}
                title="Lore Check selection (highlight text in a GM message first)"
                aria-label="Lore Check selection"
            >
                <BookCheck size={16} />
            </button>

            <button
                onMouseDown={handlePinSelection}
                className={`transition-colors p-1 ${pinSel ? 'text-terminal animate-pulse' : 'text-text-dim hover:text-terminal'}`}
                title="Pin selected text as a memory"
                aria-label="Pin selection"
            >
                <Pin size={16} />
            </button>

            <button
                onMouseDown={handleRenameSelection}
                className={`transition-colors p-1 ${renameSel ? 'text-terminal animate-pulse' : 'text-text-dim hover:text-terminal'}`}
                title="Rename selected name everywhere (highlight a name first)"
                aria-label="Rename selection"
            >
                <Replace size={16} />
            </button>

            <button
                onMouseDown={handleAddNpc}
                disabled={npcAdding}
                className={`transition-colors p-1 ${npcAdding ? 'text-terminal' : npcSel ? 'text-terminal animate-pulse' : 'text-text-dim hover:text-terminal'}`}
                title="Add highlighted name to the NPC ledger (or update if it exists)"
                aria-label="Add selection to NPC ledger"
            >
                {npcAdding ? <Loader2 size={16} className="animate-spin" /> : <UserPlus size={16} />}
            </button>

            <button
                onClick={togglePinnedMemories}
                className={`relative transition-colors p-1 ${pinnedExcerpts.length > 0 ? 'text-terminal' : 'text-text-dim hover:text-terminal'}`}
                title="Pinned memories"
                aria-label="Open pinned memories"
            >
                <Pin size={16} />
                {pinnedExcerpts.length > 0 && (
                    <span className="absolute -top-1 -right-1 bg-terminal text-void text-[8px] font-bold rounded-full w-3.5 h-3.5 flex items-center justify-center">
                        {pinnedExcerpts.length}
                    </span>
                )}
            </button>

            <button
                onClick={toggleSettings}
                className="text-text-dim hover:text-terminal transition-colors p-1"
                title="Settings"
                aria-label="Open settings"
            >
                <Settings size={18} />
            </button>

            <button
                onClick={handleExit}
                className="text-text-dim hover:text-ember transition-colors p-1 ml-1"
                title="Exit campaign"
                aria-label="Exit campaign"
            >
                <LogOut size={16} />
            </button>
        </header>
    );
}