import { useEffect, useMemo, useState } from 'react';
import { X, UserCircle, Sparkles } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';
import type { PlayerCharacter, CharacterProfileState, NPCEntry } from '../../types';
import { DEFAULT_VISUAL_PROFILE } from '../../types';
import { toast } from '../Toast';
import { selectPcBonds } from './pcBonds';
import { PCEditForm } from '../character/PCEditForm';
import { useNpcPortraits } from '../hooks/useNpcPortraits';
import { uid } from '../../utils/uid';

/**
 * WO-A rewrite 2 — Character panel.
 *
 * The PC lives at `context.playerCharacter` (NOT in `npcLedger`). This panel
 * hosts `PCEditForm` (a fork of `NPCEditForm`) in two modes:
 *  - No PC → create mode (empty draft) → `setPlayerCharacter` on save.
 *  - PC exists → view mode with an Edit toggle → `updatePlayerCharacter` on save.
 *
 * The read-only Bonds section is appended below the form (PC-specific; the
 * NPC form has no equivalent).
 *
 * Portrait: `useNpcPortraits` is reused with the isPC flag. The hook's
 * `generateForForm`/`uploadForForm` patch the form via a callback; we also
 * persist the portrait to `context.playerCharacter` immediately (so a portrait
 * generated in view mode persists without requiring a Save).
 *
 * Name mirror: on save (both create + edit) the PC's name is mirrored into
 * `context.characterProfile.identity.name` + `characterProfileData.name` so
 * the prompt pipeline picks up the canonical identity (the persona block
 * sources from `characterProfile`; the kit line sources from
 * `playerCharacter.signatureKit`).
 */
export function PCPanelModal() {
    const {
        playerCharacter,
        pcPanelOpen,
        togglePCPanel,
        toggleNPCLedger,
        npcLedger,
        setPlayerCharacter,
        updatePlayerCharacter,
        context,
        updateContext,
        characterProfileData,
        setCharacterProfileData,
    } = useAppStore(useShallow(s => ({
        playerCharacter: s.playerCharacter,
        pcPanelOpen: s.pcPanelOpen,
        togglePCPanel: s.togglePCPanel,
        toggleNPCLedger: s.toggleNPCLedger,
        npcLedger: s.npcLedger,
        setPlayerCharacter: s.setPlayerCharacter,
        updatePlayerCharacter: s.updatePlayerCharacter,
        context: s.context,
        updateContext: s.updateContext,
        characterProfileData: s.characterProfileData,
        setCharacterProfileData: s.setCharacterProfileData,
    })));

    const portraits = useNpcPortraits();
    const bonds = useMemo(() => selectPcBonds(npcLedger ?? []), [npcLedger]);

    const [isEditing, setIsEditing] = useState(false);
    const [form, setForm] = useState<Partial<PlayerCharacter>>({});

    // Sync form when the PC id changes (or the modal opens with no PC).
    // The render-phase "if changed, setForm" pattern (same as the prior
    // PCPanelModal) avoids a stale-closure effect when the PC is mutated
    // outside this component (e.g. by the hydrator migration).
    const [prevPcId, setPrevPcId] = useState<string | undefined>('__INITIAL_UNSET__');
    if (playerCharacter?.id !== prevPcId) {
        setPrevPcId(playerCharacter?.id);
        if (playerCharacter) {
            setForm({ ...playerCharacter });
            setIsEditing(false);
        } else {
            setForm({
                isPC: true,
                name: '',
                status: 'Alive',
                tier: 'recurring',
                visualProfile: { ...DEFAULT_VISUAL_PROFILE },
            });
            setIsEditing(true);
        }
    }

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && pcPanelOpen) togglePCPanel();
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [pcPanelOpen, togglePCPanel]);

    const mirrorName = (name: string) => {
        const profile: CharacterProfileState = context.characterProfile ?? { identity: {}, activeTraits: [] };
        updateContext({
            characterProfileActive: true,
            characterProfile: {
                ...profile,
                identity: { ...profile.identity, name },
            },
        });
        if (characterProfileData) {
            setCharacterProfileData({ ...characterProfileData, name });
        }
    };

    const handleSave = () => {
        if (!form.name?.trim()) {
            toast.error('Your character needs a name.');
            return;
        }
        if (playerCharacter) {
            updatePlayerCharacter(form as PlayerCharacter);
        } else {
            const newPc: PlayerCharacter = {
                ...(form as NPCEntry),
                id: uid(),
                isPC: true,
                populated: true,
            };
            setPlayerCharacter(newPc);
        }
        mirrorName(form.name.trim());
        setIsEditing(false);
        toast.success(playerCharacter ? 'Character updated.' : `Character "${form.name.trim()}" created!`);
    };

    const handleCancel = () => {
        if (playerCharacter) {
            setForm({ ...playerCharacter });
            setIsEditing(false);
        } else {
            setForm({
                isPC: true,
                name: '',
                status: 'Alive',
                tier: 'recurring',
                visualProfile: { ...DEFAULT_VISUAL_PROFILE },
            });
        }
    };

    const handleUploadPortrait = (file: File) => {
        const targetId = playerCharacter?.id || 'new-pc';
        // isEditing=true so the hook skips the updateNPC call (PC isn't in the ledger).
        // We persist via updatePlayerCharacter below when a PC already exists.
        portraits.uploadForForm(file, form.name || 'Unknown', targetId, true, (patch) => {
            setForm(prev => ({ ...prev, ...patch }));
            if (playerCharacter) updatePlayerCharacter(patch);
        });
    };

    const handleGeneratePortrait = () => {
        const targetId = playerCharacter?.id || 'new-pc';
        portraits.generateForForm(
            { ...form, id: targetId, isPC: true } as NPCEntry,
            targetId,
            true,
            (patch) => {
                setForm(prev => ({ ...prev, ...patch }));
                if (playerCharacter) updatePlayerCharacter(patch);
            },
        );
    };

    const openBondInLedger = (npcId: string) => {
        togglePCPanel();
        if (!useAppStore.getState().npcLedgerOpen) toggleNPCLedger();
        void npcId;
    };

    if (!pcPanelOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-void/80 backdrop-blur-sm p-4" role="dialog" aria-modal="true" aria-label="Character Panel" onClick={togglePCPanel}>
            <div className="bg-surface border border-border shadow-2xl rounded-lg w-full max-w-4xl max-h-[88vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
                <div className="px-4 py-3 border-b border-border flex items-center justify-between shrink-0">
                    <div className="flex items-center gap-2 text-terminal font-bold uppercase tracking-widest text-sm">
                        <UserCircle size={16} /> Character
                    </div>
                    <button onClick={togglePCPanel} className="text-text-dim hover:text-text-bright transition-colors text-lg leading-none" aria-label="Close">
                        <X size={18} />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto flex flex-col">
                    {playerCharacter ? (
                        <>
                            <PCEditForm
                                form={form}
                                setForm={setForm}
                                selectedId={playerCharacter.id}
                                isEditing={isEditing}
                                isGeneratingImage={portraits.isGeneratingImage}
                                onEdit={() => setIsEditing(true)}
                                onSave={handleSave}
                                onCancel={handleCancel}
                                onGeneratePortrait={handleGeneratePortrait}
                                onUploadPortrait={handleUploadPortrait}
                            />
                            <BondsSection bonds={bonds} openBondInLedger={openBondInLedger} />
                        </>
                    ) : isEditing ? (
                        <PCEditForm
                            form={form}
                            setForm={setForm}
                            selectedId={null}
                            isEditing={true}
                            isGeneratingImage={portraits.isGeneratingImage}
                            onEdit={() => setIsEditing(true)}
                            onSave={handleSave}
                            onCancel={handleCancel}
                            onGeneratePortrait={handleGeneratePortrait}
                            onUploadPortrait={handleUploadPortrait}
                        />
                    ) : (
                        <NoPCState onStart={() => setIsEditing(true)} />
                    )}
                </div>
            </div>
        </div>
    );
}

// ── Bonds (read-only — engine-owned pcRelation on NPC rows) ──────────────
function BondsSection({ bonds, openBondInLedger }: {
    bonds: ReturnType<typeof selectPcBonds>;
    openBondInLedger: (npcId: string) => void;
}) {
    return (
        <div className="p-6 sm:p-8 pt-0 border-t border-border/30">
            <h3 className="text-[10px] uppercase tracking-widest text-terminal/70 border-b border-border/50 pb-1 mb-3">
                Bonds <span className="text-text-dim/50 normal-case tracking-normal">(read-only — engine-owned)</span>
            </h3>
            {bonds.length === 0 ? (
                <p className="text-[10px] text-text-dim italic">No established relationships yet.</p>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {bonds.map(n => {
                        const v = n.pcRelation!;
                        const pct = Math.abs(v) / 3 * 100;
                        const color = v > 0 ? 'bg-terminal' : 'bg-ember';
                        return (
                            <button
                                key={n.id}
                                onClick={() => openBondInLedger(n.id)}
                                className="w-full flex items-center gap-3 p-2 bg-void-lighter border border-border/40 rounded hover:border-terminal/40 transition-colors text-left"
                            >
                                <div className="w-7 h-7 rounded bg-void-dark border border-border/40 flex items-center justify-center text-[9px] text-text-dim uppercase shrink-0 overflow-hidden">
                                    {n.portrait ? <img src={n.portrait} alt={n.name} className="w-full h-full object-cover" /> : n.name.slice(0, 2)}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-[12px] text-text-bright truncate">{n.name}</p>
                                    <div className="h-1.5 bg-void-dark rounded mt-0.5 overflow-hidden">
                                        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
                                    </div>
                                </div>
                                <span className={`text-[11px] font-mono shrink-0 ${v > 0 ? 'text-terminal' : 'text-ember'}`}>{v > 0 ? '+' : ''}{v}</span>
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// ── No-PC state — creation CTA ───────────────────────────────────────────
function NoPCState({ onStart }: { onStart: () => void }) {
    return (
        <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
            <div className="w-16 h-16 rounded-full bg-terminal/10 border border-terminal/30 flex items-center justify-center mb-4">
                <Sparkles size={28} className="text-terminal/70" />
            </div>
            <p className="text-text-dim uppercase tracking-widest text-sm font-bold">No Character Yet</p>
            <p className="text-text-dim/60 text-xs mt-2 max-w-sm">
                Build your player character to give the world a protagonist.
            </p>
            <button
                onClick={onStart}
                className="mt-4 px-5 py-2 bg-terminal/20 text-terminal border border-terminal/30 rounded hover:bg-terminal/30 transition-colors text-[11px] uppercase tracking-widest"
            >
                Create Character
            </button>
        </div>
    );
}