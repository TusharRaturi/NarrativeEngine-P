import { useState, useEffect, useMemo } from 'react';
import { X, Plus, MapPin, Trash2, Search, Navigation, Link2 } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import type { LocationEntry, LocationConnection } from '../types';
import { LocationSuggestionsPanel } from './location-ledger/LocationSuggestionsPanel';

function newLocationId(): string {
    return `loc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

const EMPTY_ENTRY: LocationEntry = {
    id: '',
    name: '',
    aliases: '',
    broadLocation: '',
    features: [],
    connections: [],
    description: '',
    status: '',
    firstSeenScene: '',
    lastSeenScene: '',
    source: 'manual',
};

export function LocationLedgerModal() {
    const {
        locationLedger,
        locationLedgerOpen,
        toggleLocationLedger,
        addLocation,
        updateLocation,
        removeLocation,
        locationSuggestions,
        context,
        updateContext,
    } = useAppStore();

    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [isEditing, setIsEditing] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [form, setForm] = useState<Partial<LocationEntry>>({ ...EMPTY_ENTRY });
    // Draft fields kept as comma-separated strings for the chip/field UX
    const [featuresDraft, setFeaturesDraft] = useState('');
    const [newConnectionTo, setNewConnectionTo] = useState('');
    const [newConnectionBand, setNewConnectionBand] = useState<'adjacent' | 'short' | 'long'>('short');
    const [newConnectionNote, setNewConnectionNote] = useState('');

    const displayed = useMemo(() => {
        let list = locationLedger;
        if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase();
            list = list.filter(l =>
                l.name.toLowerCase().includes(q) ||
                l.aliases?.toLowerCase().includes(q) ||
                l.broadLocation?.toLowerCase().includes(q)
            );
        }
        return [...list].sort((a, b) => a.name.localeCompare(b.name));
    }, [locationLedger, searchQuery]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && locationLedgerOpen) toggleLocationLedger();
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [locationLedgerOpen, toggleLocationLedger]);

    if (!locationLedgerOpen) return null;

    const handleSelect = (loc: LocationEntry) => {
        setSelectedId(loc.id);
        setForm({ ...loc });
        setFeaturesDraft(loc.features.join(', '));
        setNewConnectionTo('');
        setNewConnectionBand('short');
        setNewConnectionNote('');
        setIsEditing(false);
    };

    const handleStartEditing = () => {
        if (!selectedId) return;
        const latest = locationLedger.find(l => l.id === selectedId);
        if (!latest) return;
        setForm({ ...latest });
        setFeaturesDraft(latest.features.join(', '));
        setIsEditing(true);
    };
    const handleCreateNew = () => {
        setSelectedId(null);
        setForm({ ...EMPTY_ENTRY });
        setFeaturesDraft('');
        setNewConnectionTo('');
        setNewConnectionBand('short');
        setNewConnectionNote('');
        setIsEditing(true);
    };

    const handleSave = () => {
        if (!form.name?.trim()) return;
        const features = featuresDraft
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
            .slice(0, 20);
        const payload: LocationEntry = {
            id: selectedId ?? form.id ?? newLocationId(),
            name: form.name!.trim(),
            aliases: (form.aliases ?? '').trim(),
            broadLocation: (form.broadLocation ?? '').trim(),
            features,
            connections: form.connections ?? [],
            description: (form.description ?? '').trim(),
            status: (form.status ?? '').trim() || undefined,
            firstSeenScene: form.firstSeenScene || String(Date.now()),
            lastSeenScene: form.lastSeenScene || String(Date.now()),
            source: form.source ?? 'manual',
        };
        if (selectedId) {
            updateLocation(selectedId, payload);
        } else {
            addLocation(payload);
        }
        setIsEditing(false);
    };

    const handleDelete = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        if (confirm('Delete this location from the ledger?')) {
            removeLocation(id);
            if (selectedId === id) { setSelectedId(null); setIsEditing(false); }
        }
    };

    const handleSetAsCurrent = (loc: LocationEntry) => {
        updateContext({ currentPlaceId: loc.id, currentFeature: null });
    };

    const handleAddConnection = () => {
        if (!selectedId || !newConnectionTo) return;
        const other = locationLedger.find(l => l.id === newConnectionTo);
        if (!other || other.id === selectedId) return;
        const current = form.connections ?? [];
        if (current.some(c => c.toId === other.id)) return;
        const newConn: LocationConnection = {
            toId: other.id,
            band: newConnectionBand,
            note: newConnectionNote.trim() || undefined,
        };
        const updated = [...current, newConn];
        setForm(prev => ({ ...prev, connections: updated }));
        // Bidirectional default: back-link the other entry too if room and not present
        if (other.connections.length < 8 && !other.connections.some(c => c.toId === selectedId)) {
            updateLocation(other.id, {
                connections: [...other.connections, { toId: selectedId, band: newConnectionBand, note: newConnectionNote.trim() || undefined }],
            });
        }
        setNewConnectionTo('');
        setNewConnectionNote('');
    };

    const handleRemoveConnection = (toId: string) => {
        if (!selectedId) return;
        const updated = (form.connections ?? []).filter(c => c.toId !== toId);
        setForm(prev => ({ ...prev, connections: updated }));
    };

    const currentPlace = context.currentPlaceId
        ? locationLedger.find(l => l.id === context.currentPlaceId)
        : undefined;
    // The ledger can be enriched while this modal is open. In read-only mode,
    // render the live entry instead of the snapshot captured by handleSelect.
    // Editing continues to use the draft so background updates cannot clobber input.
    const renderedForm = !isEditing && selectedId
        ? locationLedger.find(l => l.id === selectedId) ?? form
        : form;

    return (
        <div
            className="fixed inset-0 z-50 flex flex-col bg-void/95 backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
            aria-label="Location Ledger"
            onClick={toggleLocationLedger}
        >
            <div
                className="bg-surface border border-border flex flex-col sm:flex-row w-full h-full overflow-hidden shadow-2xl"
                onClick={e => e.stopPropagation()}
            >
                {/* Left Sidebar */}
                <div className="w-full sm:w-1/3 md:w-96 lg:w-[420px] border-b sm:border-b-0 sm:border-r border-border flex flex-col bg-void-lighter max-h-[40vh] sm:max-h-none shrink-0">
                    <div className="p-4 border-b border-border flex justify-between items-center bg-void">
                        <div className="flex items-center gap-2 text-terminal font-bold uppercase tracking-widest text-sm">
                            <MapPin size={16} /> Location Ledger
                        </div>
                        <button onClick={toggleLocationLedger} className="text-text-dim hover:text-text-primary p-1 sm:hidden shrink-0">
                            <X size={18} />
                        </button>
                    </div>

                    {/* Search Bar */}
                    <div className="px-3 py-2 border-b border-border bg-void-lighter shrink-0">
                        <div className="relative">
                            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-dim" />
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={e => setSearchQuery(e.target.value)}
                                placeholder="Search name, alias, region..."
                                className="w-full pl-8 pr-3 py-1.5 bg-surface border border-border rounded text-xs text-text-primary placeholder:text-text-dim/50 focus:outline-none focus:border-terminal transition-colors"
                            />
                            {searchQuery && (
                                <button onClick={() => setSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-text-dim hover:text-text-primary transition-colors">
                                    <X size={12} />
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Action Bar */}
                    <div className="p-3 border-b border-border bg-void-lighter shrink-0 space-y-2">
                        <button
                            onClick={handleCreateNew}
                            className={`w-full flex items-center justify-center gap-2 py-2 px-4 border border-dashed rounded text-xs uppercase tracking-wider transition-colors ${!selectedId && isEditing ? 'border-terminal text-terminal bg-terminal/10' : 'border-border text-text-dim hover:text-terminal hover:border-terminal'}`}
                        >
                            <Plus size={14} /> New Place
                        </button>
                        {currentPlace && (
                            <div className="text-[10px] text-text-dim text-center">
                                Current: <span className="text-terminal">{currentPlace.name}</span>
                            </div>
                        )}
                    </div>

                    {!searchQuery.trim() && locationSuggestions && locationSuggestions.length > 0 && (
                        <div className="px-3 pt-2 shrink-0">
                            <LocationSuggestionsPanel suggestions={locationSuggestions} />
                        </div>
                    )}

                    {/* List */}
                    <div className="flex-1 overflow-y-auto p-2 space-y-1">
                        {displayed.length === 0 && (
                            <p className="text-text-dim text-xs text-center p-4 italic opacity-50">No places recorded yet.</p>
                        )}
                        {displayed.map(loc => {
                            const isActive = selectedId === loc.id && !isEditing;
                            const isCurrent = context.currentPlaceId === loc.id;
                            return (
                                <div
                                    key={loc.id}
                                    onClick={() => handleSelect(loc)}
                                    className={`flex items-center justify-between p-3 cursor-pointer border-l-2 transition-all group ${isActive ? 'border-terminal bg-terminal/5' : 'border-transparent hover:bg-surface'}`}
                                >
                                    <div className="flex items-center gap-2 truncate flex-1 min-w-0">
                                        <MapPin size={14} className={`shrink-0 ${isActive ? 'text-terminal' : 'text-text-dim'}`} />
                                        <div className="truncate min-w-0">
                                            <p className={`text-sm font-bold truncate ${isActive ? 'text-terminal glow-green-sm' : 'text-text-primary'}`}>
                                                {loc.name}
                                                {isCurrent && <span className="text-[9px] text-terminal ml-1">●</span>}
                                            </p>
                                            <div className="flex items-center gap-1 text-[10px] mt-0.5 text-text-dim truncate">
                                                {loc.broadLocation && <span className="bg-terminal/10 text-terminal px-1 rounded uppercase">{loc.broadLocation}</span>}
                                                {loc.features.length > 0 && <span className="truncate">{loc.features.length} features</span>}
                                            </div>
                                        </div>
                                    </div>
                                    <button
                                        onClick={(e) => { e.stopPropagation(); handleSetAsCurrent(loc); }}
                                        title="Set as current place"
                                        className="p-1.5 text-text-dim hover:text-terminal hover:bg-terminal/10 rounded transition-colors opacity-100 sm:opacity-0 sm:group-hover:opacity-100 shrink-0"
                                    >
                                        <Navigation size={12} />
                                    </button>
                                    <button
                                        onClick={(e) => handleDelete(loc.id, e)}
                                        className="p-1.5 text-text-dim hover:text-danger hover:bg-danger/10 rounded transition-colors opacity-100 sm:opacity-0 sm:group-hover:opacity-100 shrink-0"
                                    >
                                        <Trash2 size={12} />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* Right Detail Pane */}
                <div className="flex-1 flex flex-col bg-surface overflow-hidden relative">
                    <button
                        onClick={toggleLocationLedger}
                        className="absolute top-4 right-4 text-text-dim hover:text-text-primary hidden sm:block p-1 bg-void rounded border border-border hover:border-terminal transition-colors z-10"
                    >
                        <X size={18} />
                    </button>

                    {!selectedId && !isEditing && (
                        <div className="flex-1 flex items-center justify-center p-8 text-text-dim text-sm">
                            <div className="text-center space-y-2">
                                <MapPin size={32} className="mx-auto opacity-30" />
                                <p>Select a place or create a new one.</p>
                            </div>
                        </div>
                    )}

                    {(selectedId || isEditing) && (
                        <div className="flex-1 overflow-y-auto p-6 space-y-4">
                            <div className="flex items-center justify-between gap-2 pr-8">
                                <h2 className="text-terminal text-base font-bold tracking-widest uppercase">
                                    {isEditing ? (selectedId ? 'Edit Place' : 'New Place') : 'Place Details'}
                                </h2>
                                <div className="flex gap-2">
                                    {!isEditing && selectedId && (
                                        <>
                                            <button
                                                onClick={handleStartEditing}
                                                className="px-3 py-1.5 border border-border rounded text-[10px] uppercase tracking-wider text-text-dim hover:text-terminal hover:border-terminal transition-colors"
                                            >
                                                Edit
                                            </button>
                                            <button
                                                onClick={() => handleSetAsCurrent(form as LocationEntry)}
                                                disabled={!form.id}
                                                className="px-3 py-1.5 border border-terminal/30 rounded text-[10px] uppercase tracking-wider text-terminal hover:bg-terminal/10 transition-colors disabled:opacity-30"
                                            >
                                                Set as Current
                                            </button>
                                        </>
                                    )}
                                    {isEditing && (
                                        <>
                                            <button
                                                onClick={() => {
                                                    if (selectedId) {
                                                        const existing = locationLedger.find(l => l.id === selectedId);
                                                        if (existing) handleSelect(existing);
                                                    } else {
                                                        setSelectedId(null);
                                                    }
                                                    setIsEditing(false);
                                                }}
                                                className="px-3 py-1.5 border border-border rounded text-[10px] uppercase tracking-wider text-text-dim hover:text-text-primary transition-colors"
                                            >
                                                Cancel
                                            </button>
                                            <button
                                                onClick={handleSave}
                                                className="px-3 py-1.5 border border-terminal bg-terminal/10 rounded text-[10px] uppercase tracking-wider text-terminal hover:bg-terminal/20 transition-colors"
                                            >
                                                Save
                                            </button>
                                        </>
                                    )}
                                </div>
                            </div>

                            {/* Name */}
                            <Field label="Name">
                                <input
                                    type="text"
                                    value={renderedForm.name ?? ''}
                                    onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
                                    disabled={!isEditing}
                                    placeholder="Ninja Academy"
                                    className={inputClass(isEditing)}
                                />
                            </Field>

                            {/* Aliases + Broad Location */}
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <Field label="Aliases (comma-separated)">
                                    <input
                                        type="text"
                                        value={renderedForm.aliases ?? ''}
                                        onChange={e => setForm(prev => ({ ...prev, aliases: e.target.value }))}
                                        disabled={!isEditing}
                                        placeholder="the academy, NA"
                                        className={inputClass(isEditing)}
                                    />
                                </Field>
                                <Field label="Broad Location (region)">
                                    <input
                                        type="text"
                                        value={renderedForm.broadLocation ?? ''}
                                        onChange={e => setForm(prev => ({ ...prev, broadLocation: e.target.value }))}
                                        disabled={!isEditing}
                                        placeholder="Konoha"
                                        className={inputClass(isEditing)}
                                    />
                                </Field>
                            </div>

                            {/* Description */}
                            <Field label="Description">
                                <textarea
                                    value={renderedForm.description ?? ''}
                                    onChange={e => setForm(prev => ({ ...prev, description: e.target.value }))}
                                    disabled={!isEditing}
                                    rows={2}
                                    placeholder="1-2 sentences of texture."
                                    className={`${inputClass(isEditing)} resize-none`}
                                />
                            </Field>

                            {/* Status */}
                            <Field label="Status (optional)">
                                <input
                                    type="text"
                                    value={renderedForm.status ?? ''}
                                    onChange={e => setForm(prev => ({ ...prev, status: e.target.value }))}
                                    disabled={!isEditing}
                                    placeholder="burned down in ch. 12"
                                    className={inputClass(isEditing)}
                                />
                            </Field>

                            {/* Features */}
                            <Field label="Features / Rooms (comma-separated)">
                                <input
                                    type="text"
                                    value={isEditing ? featuresDraft : (renderedForm.features ?? []).join(', ')}
                                    onChange={e => setFeaturesDraft(e.target.value)}
                                    disabled={!isEditing}
                                    placeholder="Class A, training yard, teacher lounge"
                                    className={inputClass(isEditing)}
                                />
                                {renderedForm.features && renderedForm.features.length > 0 && !isEditing && (
                                    <div className="flex flex-wrap gap-1 mt-2">
                                        {renderedForm.features.map((f, i) => (
                                            <span key={i} className="text-[10px] bg-terminal/10 text-terminal px-1.5 py-0.5 rounded">
                                                {f}
                                            </span>
                                        ))}
                                    </div>
                                )}
                            </Field>

                            {/* Connections */}
                            <Field label="Connections">
                                <div className="space-y-2">
                                    {(renderedForm.connections ?? []).length > 0 && (
                                        <div className="space-y-1">
                                            {(renderedForm.connections ?? []).map(c => {
                                                const other = locationLedger.find(l => l.id === c.toId);
                                                return (
                                                    <div key={c.toId} className="flex items-center gap-2 text-xs bg-void border border-border rounded px-2 py-1">
                                                        <Link2 size={11} className="text-text-dim shrink-0" />
                                                        <span className="flex-1 truncate">
                                                            {other?.name ?? c.toId}
                                                            <span className="text-text-dim text-[10px] ml-1">({c.band ?? 'short'})</span>
                                                            {c.note && <span className="text-text-dim text-[10px] ml-1">— {c.note}</span>}
                                                        </span>
                                                        {isEditing && (
                                                            <button
                                                                onClick={() => handleRemoveConnection(c.toId)}
                                                                className="text-text-dim hover:text-danger shrink-0"
                                                            >
                                                                <X size={11} />
                                                            </button>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                    {isEditing && (
                                        <div className="flex flex-col sm:flex-row gap-2">
                                            <select
                                                value={newConnectionTo}
                                                onChange={e => setNewConnectionTo(e.target.value)}
                                                className="flex-1 bg-void border border-border rounded px-2 py-1.5 text-xs text-text-primary"
                                            >
                                                <option value="">Select place...</option>
                                                {locationLedger
                                                    .filter(l => l.id !== selectedId)
                                                    .map(l => (
                                                        <option key={l.id} value={l.id}>{l.name}</option>
                                                    ))}
                                            </select>
                                            <select
                                                value={newConnectionBand}
                                                onChange={e => setNewConnectionBand(e.target.value as 'adjacent' | 'short' | 'long')}
                                                className="bg-void border border-border rounded px-2 py-1.5 text-xs text-text-primary"
                                            >
                                                <option value="adjacent">adjacent</option>
                                                <option value="short">short</option>
                                                <option value="long">long</option>
                                            </select>
                                            <input
                                                type="text"
                                                value={newConnectionNote}
                                                onChange={e => setNewConnectionNote(e.target.value)}
                                                placeholder="note (optional)"
                                                className="flex-1 bg-void border border-border rounded px-2 py-1.5 text-xs text-text-primary placeholder:text-text-dim/50"
                                            />
                                            <button
                                                onClick={handleAddConnection}
                                                disabled={!newConnectionTo}
                                                className="px-3 py-1.5 border border-terminal/30 rounded text-[10px] uppercase tracking-wider text-terminal disabled:opacity-30"
                                            >
                                                Add
                                            </button>
                                        </div>
                                    )}
                                </div>
                            </Field>

                            {/* Metadata */}
                            <div className="grid grid-cols-2 gap-4 text-[10px] text-text-dim">
                                <div>First seen: <span className="text-text-primary">{renderedForm.firstSeenScene || '—'}</span></div>
                                <div>Last seen: <span className="text-text-primary">{renderedForm.lastSeenScene || '—'}</span></div>
                                <div>Source: <span className="text-text-primary">{renderedForm.source ?? 'manual'}</span></div>
                            </div>

                            {/* Delete (only when editing an existing entry) */}
                            {isEditing && selectedId && (
                                <button
                                    onClick={(e) => handleDelete(selectedId, e)}
                                    className="flex items-center gap-1.5 px-3 py-1.5 border border-danger/30 text-danger text-[10px] uppercase tracking-wider rounded hover:bg-danger/10 transition-colors"
                                >
                                    <Trash2 size={11} /> Delete Place
                                </button>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div>
            <label className="block text-[10px] uppercase tracking-wider text-text-dim mb-1">{label}</label>
            {children}
        </div>
    );
}

function inputClass(enabled: boolean): string {
    return `w-full bg-void border border-border rounded px-2.5 py-1.5 text-xs text-text-primary placeholder:text-text-dim/50 focus:outline-none focus:border-terminal transition-colors ${enabled ? '' : 'opacity-80 cursor-default'}`;
}