import { Settings, PanelLeftOpen, PanelLeftClose, LogOut, Users, Archive, Save, Pin, Cpu, MapPin, UserCircle } from 'lucide-react';
import { createBackup } from '../store/campaignStore';
import { flushAllPendingSaves } from '../store/slices/campaignSlice';
import { toast } from './Toast';
import { useAppStore } from '../store/useAppStore';
import { TokenGauge } from './TokenGauge';
import { BackgroundControl } from './BackgroundControl';
import { saveCampaignState } from '../store/campaignStore';
import type { AiTier } from '../types/llm';
import { APP_VERSION } from '../version';

const TIER_CYCLE: Record<AiTier, AiTier> = { lite: 'pro', pro: 'max', max: 'lite' };

export function Header() {
    const {
        toggleSettings,
        toggleDrawer,
        toggleNPCLedger,
        togglePCPanel,
        toggleLocationLedger,
        toggleBackupModal,
        togglePinnedMemories,
        drawerOpen,
        activeCampaignId,
        setActiveCampaign,
        context,
        messages,
        condenser,
        divergenceRegister,
        settings,
        updateSettings,
    } = useAppStore();

    const pinnedExcerpts = useAppStore(s => s.pinnedExcerpts);
    const aiTier = (settings?.aiTier ?? 'pro') as AiTier;

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
                className="flex items-center justify-center w-8 h-8 rounded-sm border border-border/40 hover:border-terminal bg-void-lighter hover:bg-terminal/5 text-text-dim hover:text-terminal transition-colors shrink-0 cursor-pointer"
                title={drawerOpen ? 'Close context drawer' : 'Open context drawer'}
                aria-label={drawerOpen ? 'Close context drawer' : 'Open context drawer'}
            >
                {drawerOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
            </button>

            <h1 className="hidden md:block text-terminal text-sm font-bold tracking-[0.3em] uppercase glow-green shrink-0">
                Narrative Engine
            </h1>
            <span className="hidden md:inline text-[9px] font-mono text-text-dim shrink-0" title={`Narrative Engine version ${APP_VERSION}`}>
                v{APP_VERSION}
            </span>

            <div className="hidden md:flex flex-1 items-center gap-4">
                <TokenGauge />
            </div>

            <div className="flex items-center gap-1.5 ml-auto overflow-x-auto no-scrollbar py-1 shrink-0">
                <BackgroundControl />

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
                    className="flex items-center gap-1.5 h-8 px-2.5 rounded-sm border border-border/40 hover:border-terminal bg-void-lighter hover:bg-terminal/5 text-text-dim hover:text-terminal transition-colors shrink-0 cursor-pointer text-[10px] font-bold uppercase tracking-wider font-mono"
                    title="Create backup"
                    aria-label="Create backup"
                >
                    <Save size={13} />
                    <span className="hidden sm:inline">Backup</span>
                </button>

                <button
                    onClick={toggleBackupModal}
                    className="flex items-center gap-1.5 h-8 px-2.5 rounded-sm border border-border/40 hover:border-terminal bg-void-lighter hover:bg-terminal/5 text-text-dim hover:text-terminal transition-colors shrink-0 cursor-pointer text-[10px] font-bold uppercase tracking-wider font-mono"
                    title="Backup manager"
                    aria-label="Open backup manager"
                >
                    <Archive size={13} />
                    <span className="hidden sm:inline">Backups</span>
                </button>

                <button
                    onClick={togglePCPanel}
                    className="flex items-center gap-1.5 h-8 px-2.5 rounded-sm border border-border/40 hover:border-terminal bg-void-lighter hover:bg-terminal/5 text-text-dim hover:text-terminal transition-colors shrink-0 cursor-pointer text-[10px] font-bold uppercase tracking-wider font-mono"
                    title="Character"
                    aria-label="Open character panel"
                >
                    <UserCircle size={13} />
                    <span>Character</span>
                </button>

                <button
                    onClick={toggleNPCLedger}
                    className="flex items-center gap-1.5 h-8 px-2.5 rounded-sm border border-border/40 hover:border-terminal bg-void-lighter hover:bg-terminal/5 text-text-dim hover:text-terminal transition-colors shrink-0 cursor-pointer text-[10px] font-bold uppercase tracking-wider font-mono"
                    title="NPC Ledger"
                    aria-label="Open NPC Ledger"
                >
                    <Users size={13} />
                    <span>NPC Ledger</span>
                </button>

                <button
                    onClick={toggleLocationLedger}
                    className="flex items-center gap-1.5 h-8 px-2.5 rounded-sm border border-border/40 hover:border-terminal bg-void-lighter hover:bg-terminal/5 text-text-dim hover:text-terminal transition-colors shrink-0 cursor-pointer text-[10px] font-bold uppercase tracking-wider font-mono"
                    title="Location Ledger"
                    aria-label="Open Location Ledger"
                >
                    <MapPin size={13} />
                    <span className="hidden sm:inline">Places</span>
                </button>

                <button
                    onClick={() => updateSettings({ aiTier: TIER_CYCLE[aiTier] })}
                    className="flex items-center gap-1.5 h-8 px-2.5 rounded-sm border border-border/40 hover:border-terminal bg-void-lighter hover:bg-terminal/5 text-text-dim hover:text-terminal transition-colors shrink-0 cursor-pointer text-[10px] font-bold uppercase tracking-wider font-mono"
                    title={`AI Tier: ${aiTier.toUpperCase()} (click to cycle Lite → Pro → Max)`}
                    aria-label={`AI Tier: ${aiTier}, click to cycle`}
                >
                    <Cpu size={13} />
                    <span className="hidden sm:inline">{aiTier}</span>
                </button>

                <button
                    onClick={togglePinnedMemories}
                    className={`relative flex items-center gap-1.5 h-8 px-2.5 rounded-sm border transition-colors shrink-0 cursor-pointer text-[10px] font-bold uppercase tracking-wider font-mono ${pinnedExcerpts.length > 0 ? 'border-terminal text-terminal bg-terminal/5' : 'border-border/40 hover:border-terminal bg-void-lighter hover:bg-terminal/5 text-text-dim hover:text-terminal'}`}
                    title="Pinned memories"
                    aria-label="Open pinned memories"
                >
                    <Pin size={13} />
                    <span className="hidden sm:inline">Pinned</span>
                    {pinnedExcerpts.length > 0 && (
                        <span className="min-w-[14px] h-3.5 bg-terminal text-void text-[8px] font-bold rounded-full flex items-center justify-center px-0.5">
                            {pinnedExcerpts.length}
                        </span>
                    )}
                </button>

                <button
                    onClick={toggleSettings}
                    className="flex items-center gap-1.5 h-8 px-2.5 rounded-sm border border-border/40 hover:border-terminal bg-void-lighter hover:bg-terminal/5 text-text-dim hover:text-terminal transition-colors shrink-0 cursor-pointer text-[10px] font-bold uppercase tracking-wider font-mono"
                    title="Settings"
                    aria-label="Open settings"
                >
                    <Settings size={13} />
                    <span className="hidden sm:inline">Settings</span>
                </button>

                <button
                    onClick={handleExit}
                    className="flex items-center gap-1.5 h-8 px-2.5 rounded-sm border border-border/40 hover:border-ember bg-void-lighter hover:bg-ember/5 text-text-dim hover:text-ember transition-colors shrink-0 cursor-pointer text-[10px] font-bold uppercase tracking-wider font-mono"
                    title="Exit campaign"
                    aria-label="Exit campaign"
                >
                    <LogOut size={13} />
                    <span className="hidden sm:inline">Exit</span>
                </button>
            </div>
        </header>
    );
}