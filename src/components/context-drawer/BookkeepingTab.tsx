import { useState, useMemo } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { scanInventory } from '../../services/inventoryParser';
import { scanCharacterProfile } from '../../services/characterProfileParser';
import { countTokens } from '../../services/infrastructure/tokenizer';
import {
    minifyBookkeepingStub,
    minifySelectedInventory,
    minifySelectedProfile,
} from '../../services/contextMinifier';
import { toast } from '../Toast';
import type { EndpointConfig, ProviderConfig, InventoryItemCategory, InventoryItem } from '../../types';

const ALL_CATS: (InventoryItemCategory | 'all' | 'equipped')[] = ['all', 'equipped', 'weapon', 'armor', 'consumable', 'currency', 'key', 'misc'];
const DISPLAY_LABEL: Record<string, string> = {
    all: 'All',
    equipped: 'Equipped',
    weapon: 'Weapon',
    armor: 'Armor',
    consumable: 'Consumable',
    currency: 'Currency',
    key: 'Key',
    misc: 'Misc',
};

const ALL_PROFILE_FIELDS = ['name', 'race', 'class', 'level', 'hp', 'mp', 'stats', 'skills', 'abilities', 'traits', 'notes'];

function SceneTag({ lastScene }: { lastScene: string }) {
    if (!lastScene || lastScene === 'Never') {
        return <span className="text-text-dim/40">Never updated</span>;
    }
    return <span className="text-terminal/70">Last updated: Scene #{lastScene}</span>;
}

function TokenGauge({ items, profile }: { items: InventoryItem[]; profile: any }) {
    const stub = countTokens(minifyBookkeepingStub(profile, items));
    const full = countTokens(minifySelectedInventory(items, ['weapon', 'armor', 'consumable', 'currency', 'key', 'misc', 'equipped']) + '\n' + minifySelectedProfile(profile, ALL_PROFILE_FIELDS));
    return (
        <div className="flex items-center justify-between text-[9px] text-text-dim/50">
            <span>Stub: {stub}t</span>
            <span>Full: ~{full}t</span>
        </div>
    );
}

function InventoryRow({
    it,
    onUpdate,
    onRemove,
}: {
    it: InventoryItem;
    onUpdate: (id: string, patch: Partial<InventoryItem>) => void;
    onRemove: (id: string) => void;
}) {
    const [expanded, setExpanded] = useState(false);
    return (
        <div className="border border-border/30 rounded hover:border-border/60 transition-colors">
            <div className="flex items-center gap-2 px-2 py-1 text-[10px]">
                <input
                    type="checkbox"
                    checked={it.equipped}
                    onChange={(e) => onUpdate(it.id, { equipped: e.target.checked })}
                    title="Equipped"
                />
                <button
                    onClick={() => setExpanded(!expanded)}
                    className="text-text-dim/40 hover:text-text-primary w-3 text-center"
                >
                    {expanded ? '▼' : '▶'}
                </button>
                <input
                    className="flex-1 bg-transparent outline-none text-text-primary px-1 min-w-[0]"
                    value={it.name}
                    onChange={(e) => onUpdate(it.id, { name: e.target.value })}
                />
                <input
                    className="w-8 bg-transparent outline-none text-text-primary text-center"
                    type="number"
                    value={it.qty}
                    min={1}
                    onChange={(e) => onUpdate(it.id, { qty: Math.max(1, Number(e.target.value)) })}
                />
                <select
                    className="bg-void border border-border/50 rounded text-[9px] outline-none focus:border-terminal"
                    value={it.category}
                    onChange={(e) => onUpdate(it.id, { category: e.target.value as InventoryItemCategory })}
                >
                    {(['weapon', 'armor', 'consumable', 'currency', 'key', 'misc'] as InventoryItemCategory[]).map((c) => (
                        <option key={c} value={c}>{c[0].toUpperCase()}{c.slice(1)}</option>
                    ))}
                </select>
                <button onClick={() => onRemove(it.id)} className="text-ember/60 hover:text-ember px-1">×</button>
            </div>
            {expanded && (
                <div className="px-2 pb-2 space-y-1 border-t border-border/20 pt-1">
                    <div className="flex items-center gap-2">
                        <span className="text-[9px] text-text-dim/50 w-14">Keywords</span>
                        <input
                            className="flex-1 bg-void border border-border/30 rounded text-[10px] px-1 outline-none focus:border-terminal"
                            value={it.keywords.join(', ')}
                            onChange={(e) => onUpdate(it.id, { keywords: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
                        />
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="text-[9px] text-text-dim/50 w-14">Notes</span>
                        <input
                            className="flex-1 bg-void border border-border/30 rounded text-[10px] px-1 outline-none focus:border-terminal"
                            value={it.notes}
                            onChange={(e) => onUpdate(it.id, { notes: e.target.value })}
                        />
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="text-[9px] text-text-dim/50 w-14">Importance</span>
                        <input
                            className="w-12 bg-void border border-border/30 rounded text-[10px] px-1 outline-none focus:border-terminal"
                            type="number"
                            value={it.importance}
                            min={1}
                            max={10}
                            onChange={(e) => onUpdate(it.id, { importance: Math.max(1, Math.min(10, Number(e.target.value))) })}
                        />
                    </div>
                </div>
            )}
        </div>
    );
}

export function BookkeepingTab() {
    const context = useAppStore((s) => s.context);
    const updateContext = useAppStore((s) => s.updateContext);
    const messages = useAppStore((s) => s.messages);
    const archiveIndex = useAppStore((s) => s.archiveIndex);
    const autoBookkeepingInterval = useAppStore((s) => s.autoBookkeepingInterval);
    const setAutoBookkeepingInterval = useAppStore((s) => s.setAutoBookkeepingInterval);

    const inventoryItems = useAppStore((s) => s.inventoryItems ?? s.context.inventoryItems ?? []);
    const setInventoryItems = useAppStore((s) => s.setInventoryItems);
    const characterProfileData = useAppStore((s) => s.characterProfileData ?? s.context.characterProfileData ?? s.context.characterProfile);
    const setCharacterProfileData = useAppStore((s) => s.setCharacterProfileData);
    const getActiveStoryEndpoint = useAppStore((s) => s.getActiveStoryEndpoint);

    const [activeTab, setActiveTab] = useState<InventoryItemCategory | 'all' | 'equipped'>('all');
    const [search, setSearch] = useState('');
    const [rawEdit, setRawEdit] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [isScanningInventory, setIsScanningInventory] = useState(false);
    const [isScanningProfile, setIsScanningProfile] = useState(false);

    const getCurrentSceneId = (): string => {
        if (archiveIndex.length === 0) return '1';
        return archiveIndex[archiveIndex.length - 1].sceneId;
    };

    const handleCheckInventory = async () => {
        if (isScanningInventory) return;
        setIsScanningInventory(true);
        try {
            const provider = getActiveStoryEndpoint();
            if (!provider) return;
            const newItems = await scanInventory(provider as ProviderConfig | EndpointConfig, messages, inventoryItems);
            setInventoryItems(newItems);
            updateContext({ inventoryLastScene: getCurrentSceneId() });
        } catch (e) {
            console.error('Failed to scan inventory:', e);
            toast.error('Inventory scan failed');
        } finally {
            setIsScanningInventory(false);
        }
    };

    const handlePopulateProfile = async () => {
        if (isScanningProfile) return;
        setIsScanningProfile(true);
        try {
            const provider = getActiveStoryEndpoint();
            if (!provider) return;
            const newProfile = await scanCharacterProfile(provider as ProviderConfig | EndpointConfig, messages, characterProfileData as any);
            setCharacterProfileData(newProfile as any);
            updateContext({ characterProfileLastScene: getCurrentSceneId() });
        } catch (e) {
            console.error('Failed to scan character profile:', e);
            toast.error('Character profile scan failed');
        } finally {
            setIsScanningProfile(false);
        }
    };

    const updateItem = (id: string, patch: Partial<InventoryItem>) => {
        setInventoryItems(inventoryItems.map((it) => it.id === id ? { ...it, ...patch } : it));
    };
    const addItem = (cat?: InventoryItemCategory) => {
        const newItem: InventoryItem = {
            id: `inv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            name: 'New Item',
            qty: 1,
            category: cat || 'misc',
            keywords: [],
            equipped: false,
            lastUsedScene: '000',
            importance: 5,
            notes: '',
        };
        setInventoryItems([...inventoryItems, newItem]);
    };
    const removeItem = (id: string) => {
        setInventoryItems(inventoryItems.filter((it) => it.id !== id));
    };

    const tabCounts = useMemo(() => {
        const counts: Record<string, number> = { all: inventoryItems.length };
        for (const it of inventoryItems) {
            counts[it.category] = (counts[it.category] || 0) + 1;
            if (it.equipped) counts.equipped = (counts.equipped || 0) + 1;
        }
        return counts;
    }, [inventoryItems]);

    const filteredItems = useMemo(() => {
        let list = inventoryItems;
        if (activeTab !== 'all') {
            if (activeTab === 'equipped') {
                list = list.filter((it) => it.equipped);
            } else {
                list = list.filter((it) => it.category === activeTab);
            }
        }
        if (search.trim()) {
            const q = search.toLowerCase();
            list = list.filter((it) => it.name.toLowerCase().includes(q) || it.keywords.some((k) => k.toLowerCase().includes(q)));
        }
        return list.sort((a, b) => a.name.localeCompare(b.name));
    }, [inventoryItems, activeTab, search]);

    const profile = characterProfileData as any;

    return (
        <div className="px-4 py-4 space-y-4">
            <p className="text-[9px] text-text-dim/50">
                Smart Injection injects a mini-stub every turn, plus selected categories via the context recommender.
            </p>

            <div className="flex items-center gap-2">
                <button
                    onClick={() => updateContext({ smartBookkeepingActive: !context.smartBookkeepingActive })}
                    className={`px-3 py-1.5 text-[10px] uppercase tracking-wider rounded transition-colors border ${
                        context.smartBookkeepingActive
                            ? 'bg-terminal/10 border-terminal text-terminal'
                            : 'bg-void border-border text-text-dim'
                    }`}
                >
                    {context.smartBookkeepingActive ? 'Smart Injection: ON' : 'Smart Injection: OFF'}
                </button>
                <button
                    onClick={() => setRawEdit(!rawEdit)}
                    className="px-3 py-1.5 text-[10px] uppercase tracking-wider rounded transition-colors border bg-void border-border text-text-dim hover:border-text-primary"
                >
                    {rawEdit ? 'Grid View' : 'Raw Edit'}
                </button>
            </div>

            <TokenGauge items={inventoryItems} profile={profile} />

            {/* ─── Inventory ─── */}
            <div>
                <div className="flex items-center justify-between mb-2">
                    <h3 className="text-[11px] uppercase tracking-wider text-ice flex items-center gap-2">
                        Player Inventory <span className="text-[9px] text-text-dim/40">({inventoryItems.length} items)</span>
                    </h3>
                    <button
                        onClick={() => addItem(activeTab !== 'all' && activeTab !== 'equipped' ? (activeTab as InventoryItemCategory) : undefined)}
                        className="text-[9px] uppercase tracking-wider text-terminal border border-dashed border-terminal/30 rounded px-2 py-0.5 hover:border-terminal transition-colors"
                    >
                        + Add
                    </button>
                </div>

                {rawEdit ? (
                    <textarea
                        className="w-full bg-void border border-border rounded text-text-primary text-[11px] px-2 py-1 focus:border-terminal outline-none font-mono"
                        rows={12}
                        value={JSON.stringify(inventoryItems, null, 2)}
                        onChange={(e) => {
                            try {
                                const parsed = JSON.parse(e.target.value);
                                if (Array.isArray(parsed)) setInventoryItems(parsed);
                            } catch { /* ignore */ }
                        }}
                    />
                ) : (
                    <>
                        {/* Search */}
                        <input
                            className="w-full bg-void border border-border/50 rounded text-[11px] px-2 py-1 mb-2 outline-none focus:border-terminal text-text-primary"
                            placeholder="Search items..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                        />

                        {/* Tabs */}
                        <div className="flex flex-wrap gap-1 mb-2">
                            {ALL_CATS.map((cat) => (
                                <button
                                    key={cat}
                                    onClick={() => setActiveTab(cat)}
                                    className={`px-2 py-0.5 text-[9px] uppercase tracking-wider rounded border transition-colors ${
                                        activeTab === cat
                                            ? 'bg-terminal/10 border-terminal text-terminal'
                                            : 'bg-void border-border/50 text-text-dim/60 hover:text-text-dim hover:border-border'
                                    }`}
                                >
                                    {DISPLAY_LABEL[cat]} ({tabCounts[cat] || 0})
                                </button>
                            ))}
                        </div>

                        {/* List */}
                        <div className="space-y-1 max-h-[300px] overflow-y-auto pr-1 custom-scrollbar">
                            {filteredItems.map((it) => (
                                <InventoryRow
                                    key={it.id}
                                    it={it}
                                    onUpdate={updateItem}
                                    onRemove={removeItem}
                                />
                            ))}
                            {filteredItems.length === 0 && (
                                <div className="text-[10px] text-text-dim/40 text-center py-4">No items in this category.</div>
                            )}
                        </div>
                    </>
                )}

                <div className="mt-2 flex items-center justify-between">
                    <span className="text-[9px]"><SceneTag lastScene={context.inventoryLastScene} /></span>
                    <button
                        onClick={handleCheckInventory}
                        disabled={isScanningInventory}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-void border border-border hover:border-terminal text-text-primary text-[10px] uppercase tracking-wider rounded transition-colors disabled:opacity-50"
                    >
                        {isScanningInventory ? 'Scanning...' : 'Check Inventory'}
                    </button>
                </div>
            </div>

            {/* ─── Profile ─── */}
            <div className="pt-4 border-t border-border/50">
                <div className="flex items-center justify-between mb-2">
                    <h3 className="text-[11px] uppercase tracking-wider text-ember">Character Profile</h3>
                </div>
                {rawEdit ? (
                    <textarea
                        className="w-full bg-void border border-border rounded text-text-primary text-[11px] px-2 py-1 focus:border-terminal outline-none font-mono"
                        rows={12}
                        value={JSON.stringify(profile, null, 2)}
                        onChange={(e) => {
                            try {
                                const parsed = JSON.parse(e.target.value);
                                setCharacterProfileData(parsed);
                            } catch { /* ignore */ }
                        }}
                    />
                ) : (
                    <div className="space-y-2">
                        {[
                            { k: 'name', label: 'Name' },
                            { k: 'race', label: 'Race' },
                            { k: 'class', label: 'Class' },
                            { k: 'level', label: 'Level', type: 'number' },
                        ].map((f) => (
                            <div key={f.k} className="flex items-center gap-2">
                                <label className="text-[9px] text-text-dim/60 w-12">{f.label}</label>
                                <input
                                    className="flex-1 bg-transparent border-b border-border/50 hover:border-border focus:border-terminal outline-none text-text-primary text-[11px] px-1"
                                    type={f.type || 'text'}
                                    value={String(profile[f.k] ?? '')}
                                    onChange={(e) => setCharacterProfileData({ ...profile, [f.k]: f.type === 'number' ? Number(e.target.value) : e.target.value })}
                                />
                            </div>
                        ))}
                        <div className="flex items-center gap-2">
                            <label className="text-[9px] text-text-dim/60 w-12">HP</label>
                            <input
                                className="w-14 bg-transparent border-b border-border/50 hover:border-border focus:border-terminal outline-none text-text-primary text-[11px] px-1 text-center"
                                type="number"
                                value={profile.hp?.current ?? 0}
                                onChange={(e) => setCharacterProfileData({ ...profile, hp: { ...profile.hp, current: Number(e.target.value) } })}
                            />
                            <span className="text-text-dim/40">/</span>
                            <input
                                className="w-14 bg-transparent border-b border-border/50 hover:border-border focus:border-terminal outline-none text-text-primary text-[11px] px-1 text-center"
                                type="number"
                                value={profile.hp?.max ?? 0}
                                onChange={(e) => setCharacterProfileData({ ...profile, hp: { ...profile.hp, max: Number(e.target.value) } })}
                            />
                        </div>
                        {['skills', 'abilities', 'traits'].map((k) => (
                            <div key={k}>
                                <label className="text-[9px] text-text-dim/60">{k[0].toUpperCase() + k.slice(1)} <span className="text-text-dim/30">(comma-separated)</span></label>
                                <input
                                    className="w-full bg-transparent border-b border-border/50 hover:border-border focus:border-terminal outline-none text-text-primary text-[11px] px-1"
                                    value={(profile[k] ?? []).join(', ')}
                                    onChange={(e) => setCharacterProfileData({ ...profile, [k]: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
                                />
                            </div>
                        ))}
                        <div>
                            <label className="text-[9px] text-text-dim/60">Notes</label>
                            <textarea
                                className="w-full bg-void border border-border/50 rounded text-text-primary text-[11px] px-2 py-1 focus:border-terminal outline-none"
                                rows={3}
                                value={profile.notes || ''}
                                onChange={(e) => setCharacterProfileData({ ...profile, notes: e.target.value })}
                            />
                        </div>
                    </div>
                )}
                <div className="mt-2 flex items-center justify-between">
                    <span className="text-[9px]"><SceneTag lastScene={context.characterProfileLastScene} /></span>
                    <button
                        onClick={handlePopulateProfile}
                        disabled={isScanningProfile}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-void border border-border hover:border-terminal text-text-primary text-[10px] uppercase tracking-wider rounded transition-colors disabled:opacity-50"
                    >
                        {isScanningProfile ? 'Scanning...' : 'Populate Profile'}
                    </button>
                </div>
            </div>

            <div className="pt-4 border-t border-border/50">
                <button
                    onClick={() => setShowSettings(!showSettings)}
                    className="flex items-center gap-1.5 text-text-dim/60 hover:text-text-primary text-[9px] uppercase tracking-wider transition-colors"
                >
                    {showSettings ? 'Hide' : 'Auto-Update Settings'}
                </button>
                {showSettings && (
                    <div className="mt-2 space-y-2">
                        <div className="flex items-center gap-2">
                            <label className="text-[9px] text-text-dim/60 uppercase tracking-wider whitespace-nowrap">Scan every N turns:</label>
                            <input
                                type="number"
                                min={1}
                                max={50}
                                value={autoBookkeepingInterval}
                                onChange={(e) => setAutoBookkeepingInterval(Number(e.target.value))}
                                className="w-16 px-2 py-1 bg-void border border-border rounded text-text-primary text-[11px] text-center focus:outline-none focus:border-terminal"
                            />
                        </div>
                        <p className="text-[8px] text-text-dim/40">
                            Auto-scanned every N turns via background queue.
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
}
