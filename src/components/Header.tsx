import { Settings, PanelLeftOpen, PanelLeftClose, LogOut, Users, Archive, Save, Pin } from 'lucide-react';
import { createBackup } from '../store/campaignStore';
import { flushAllPendingSaves } from '../store/slices/campaignSlice';
import { toast } from './Toast';
import { useAppStore } from '../store/useAppStore';
import { TokenGauge } from './TokenGauge';
import { saveCampaignState } from '../store/campaignStore';

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
    } = useAppStore();

    const pinnedExcerpts = useAppStore(s => s.pinnedExcerpts);

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

            <div className="flex items-center gap-1 sm:gap-2 ml-auto overflow-x-auto no-scrollbar py-1 shrink-0">
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
            </div>
        </header>
    );
}