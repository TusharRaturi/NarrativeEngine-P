import { useState } from 'react';
import { Trash2, Plus, AlertCircle, Eye, EyeOff } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { uid } from '../../utils/uid';
import type { CharacterProfileState, CharacterTrait } from '../../types';
import { TraitRow, IdentityFields } from '../pc/profileFields';

/**
 * Character Profile editor (WO-11.5) — desktop port of mobile's
 * CharacterProfileEditor. Edits `context.characterProfile` (the
 * CharacterProfileState — narrative traits, NOT the stat-block sheet which
 * lives in characterProfileData and is edited in the Bookkeeping tab).
 * Mounted as a drawer tab beside the others in ContextDrawer.
 */
export function CharacterProfileEditor() {
    const context = useAppStore(s => s.context);
    const updateContext = useAppStore(s => s.updateContext);

    const profile: CharacterProfileState = context.characterProfile ?? { identity: {}, activeTraits: [] };
    const active = context.characterProfileActive ?? false;

    const onChange = (next: CharacterProfileState) => {
        updateContext({ characterProfile: next });
    };

    const onToggle = () => {
        updateContext({ characterProfileActive: !active });
    };

    const activeTraits = profile.activeTraits.filter(t => !t.superseded);
    const supersededTraits = profile.activeTraits.filter(t => t.superseded);
    const [showSuperseded, setShowSuperseded] = useState(false);

    const updateTrait = (id: string, patch: Partial<CharacterTrait>) => {
        onChange({
            ...profile,
            activeTraits: profile.activeTraits.map(t => t.id === id ? { ...t, ...patch } : t),
        });
    };

    const addTrait = () => {
        const newTrait: CharacterTrait = {
            id: uid(),
            subject: profile.identity.name || 'PC',
            category: 'party_facts',
            text: '',
            importance: 5,
            eventTags: [],
            sceneEstablished: 'manual',
            superseded: false,
            source: 'manual',
        };
        onChange({ ...profile, activeTraits: [...profile.activeTraits, newTrait] });
    };

    const removeTrait = (id: string) => {
        onChange({ ...profile, activeTraits: profile.activeTraits.filter(t => t.id !== id) });
    };

    const supersedeTrait = (id: string) => {
        updateTrait(id, { superseded: true });
    };

    const updateIdentity = (patch: Partial<CharacterProfileState['identity']>) => {
        onChange({ ...profile, identity: { ...profile.identity, ...patch } });
    };

    return (
        <div className="px-4 py-4 space-y-3">
            <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-ember">
                    <span>Character Profile</span>
                </label>
                <button
                    onClick={onToggle}
                    className={`flex items-center gap-1 text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded border transition-colors ${active ? 'border-terminal/40 text-terminal bg-terminal/10' : 'border-border text-text-dim hover:text-text-primary'}`}
                    title={active ? 'Profile is being injected into the prompt' : 'Profile injection is OFF'}
                >
                    {active ? <Eye size={10} /> : <EyeOff size={10} />}
                    {active ? 'ON' : 'OFF'}
                </button>
            </div>

            <div className={`space-y-3 border px-3 py-3 bg-void transition-opacity min-h-[100px] ${active ? 'border-border' : 'border-border/40 opacity-50'}`}>
                {/* Identity section — always injected (Tier 1 core) */}
                <div className="space-y-1.5">
                    <p className="text-[9px] uppercase tracking-widest text-text-dim/70">Identity (always sent)</p>
                    <IdentityFields
                        identity={profile.identity}
                        onChange={updateIdentity}
                        disabled={!active}
                    />
                </div>

                {/* Active traits */}
                <div className="space-y-2">
                    <div className="flex items-center justify-between">
                        <p className="text-[9px] uppercase tracking-widest text-text-dim/70">
                            Active Traits ({activeTraits.length}/10)
                        </p>
                        <button
                            onClick={addTrait}
                            disabled={activeTraits.length >= 10}
                            className="flex items-center gap-1 text-[10px] text-terminal/70 hover:text-terminal disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                            <Plus size={12} /> Add
                        </button>
                    </div>

                    {activeTraits.length === 0 && (
                        <p className="text-[10px] text-text-dim/40 italic px-1">
                            No active traits. The profile parser will add traits as the story progresses, or add one manually.
                        </p>
                    )}

                    {activeTraits.map(trait => (
                        <TraitRow
                            key={trait.id}
                            trait={trait}
                            onChange={(patch) => updateTrait(trait.id, patch)}
                            onSupersede={() => supersedeTrait(trait.id)}
                            onRemove={() => removeTrait(trait.id)}
                        />
                    ))}
                </div>

                {/* Superseded traits (collapsed) */}
                {supersededTraits.length > 0 && (
                    <div>
                        <button
                            onClick={() => setShowSuperseded(!showSuperseded)}
                            className="text-[9px] text-text-dim/50 hover:text-text-dim"
                        >
                            {showSuperseded ? '▾' : '▸'} {supersededTraits.length} superseded (historical)
                        </button>
                        {showSuperseded && (
                            <div className="space-y-1 mt-1">
                                {supersededTraits.map(trait => (
                                    <div key={trait.id} className="flex items-center gap-2 px-2 py-1 opacity-40">
                                        <AlertCircle size={10} className="text-text-dim shrink-0" />
                                        <span className="text-[10px] text-text-dim line-through flex-1 truncate">{trait.text}</span>
                                        <button
                                            onClick={() => removeTrait(trait.id)}
                                            className="text-text-dim/40 hover:text-red-400"
                                        >
                                            <Trash2 size={10} />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* Legacy notes (frozen, read-only) */}
                {profile.legacyNotes && (
                    <div>
                        <p className="text-[9px] text-text-dim/50">
                            Legacy profile preserved from upgrade (not injected): {profile.legacyNotes.length.toLocaleString()} chars
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
}