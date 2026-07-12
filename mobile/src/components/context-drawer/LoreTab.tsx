import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import type { LoreChunk } from '../../types';
import { indexLore, deriveDefaultLoreMeta } from '../../services/lore/loreIndexer';
import type { IndexingProgress } from '../../services/lore/loreIndexer';

type ActivationMode = 'vector' | 'keyword' | 'always';

function getModes(chunk: LoreChunk): ActivationMode[] {
    return deriveDefaultLoreMeta(chunk);
}

export function LoreTab() {
    const loreChunks = useAppStore((s) => s.loreChunks);
    const updateLoreChunk = useAppStore((s) => s.updateLoreChunk);
    const setLoreChunks = useAppStore((s) => s.setLoreChunks);
    const activeCampaignId = useAppStore((s) => s.activeCampaignId);
    const settings = useAppStore((s) => s.settings);

    const [newKeyword, setNewKeyword] = useState<Record<string, string>>({});
    const [newSecondary, setNewSecondary] = useState<Record<string, string>>({});
    const [indexing, setIndexing] = useState(false);
    const [progress, setProgress] = useState<IndexingProgress | null>(null);
    const [confirmRegenId, setConfirmRegenId] = useState<string | null>(null);

    const runIndex = async () => {
        if (!activeCampaignId || loreChunks.length === 0) return;
        setIndexing(true);
        try {
            await indexLore(activeCampaignId, loreChunks, (p) => setProgress(p));
            const updated = loreChunks.map(c => ({
                ...c,
                activationModes: deriveDefaultLoreMeta(c),
            }));
            setLoreChunks(updated);
            const { saveLoreChunks } = await import('../../store/campaignStore');
            await saveLoreChunks(activeCampaignId, updated);
        } catch (e) {
            console.warn('[LoreTab] Indexing failed:', e);
        } finally {
            setIndexing(false);
            setProgress(null);
        }
    };

    const addKeyword = (chunkId: string) => {
        const kw = (newKeyword[chunkId] || '').trim().toLowerCase();
        if (!kw) return;
        const chunk = loreChunks.find(c => c.id === chunkId);
        if (!chunk) return;
        if (chunk.triggerKeywords.includes(kw)) return;
        updateLoreChunk(chunkId, { triggerKeywords: [...chunk.triggerKeywords, kw] });
        setNewKeyword(prev => ({ ...prev, [chunkId]: '' }));
    };

    const removeKeyword = (chunkId: string, kw: string) => {
        const chunk = loreChunks.find(c => c.id === chunkId);
        if (!chunk) return;
        updateLoreChunk(chunkId, { triggerKeywords: chunk.triggerKeywords.filter(k => k !== kw) });
    };

    const toggleMode = (chunkId: string, mode: ActivationMode) => {
        const chunk = loreChunks.find(c => c.id === chunkId);
        if (!chunk) return;
        const current = getModes(chunk);
        const modes = current.includes(mode)
            ? current.filter(m => m !== mode)
            : [...current, mode];
        // Empty modes = disabled (chunk never retrieved). Allowed.
        updateLoreChunk(chunkId, { activationModes: modes, modesUserEdited: true });
    };

    const toggleDisabled = (chunkId: string) => {
        const chunk = loreChunks.find(c => c.id === chunkId);
        if (!chunk) return;
        const isDisabled = getModes(chunk).length === 0;
        // Re-enable restores the standard vector+keyword default; disable clears all modes.
        updateLoreChunk(chunkId, {
            activationModes: isDisabled ? ['vector', 'keyword'] : [],
            modesUserEdited: true,
        });
    };

    const persistBulk = (updated: LoreChunk[]) => {
        setLoreChunks(updated);
        if (activeCampaignId) {
            import('../../store/campaignStore').then(m => m.saveLoreChunks(activeCampaignId, updated));
        }
    };

    // Toggle one mode across every chunk. Direction follows the majority:
    // if most chunks already have the mode, turn it OFF for all; else turn it ON.
    const bulkToggleMode = (mode: ActivationMode) => {
        if (loreChunks.length === 0) return;
        const withMode = loreChunks.filter(c => getModes(c).includes(mode)).length;
        const turnOn = withMode < loreChunks.length / 2;
        const updated = loreChunks.map(c => {
            const modes = getModes(c);
            const has = modes.includes(mode);
            const next = turnOn
                ? (has ? modes : [...modes, mode])
                : modes.filter(m => m !== mode);
            return { ...c, activationModes: next, modesUserEdited: true };
        });
        persistBulk(updated);
    };

    const bulkDisableAll = () => {
        if (loreChunks.length === 0) return;
        persistBulk(loreChunks.map(c => ({ ...c, activationModes: [], modesUserEdited: true })));
    };

    // Reflects whether the next press of a mode button will turn it on or off.
    const bulkModeIsOn = (mode: ActivationMode) =>
        loreChunks.length > 0 && loreChunks.filter(c => getModes(c).includes(mode)).length >= loreChunks.length / 2;

    const addSecondaryKeyword = (chunkId: string) => {
        const kw = (newSecondary[chunkId] || '').trim().toLowerCase();
        if (!kw) return;
        const chunk = loreChunks.find(c => c.id === chunkId);
        if (!chunk) return;
        const existing = chunk.secondaryKeywords ?? [];
        if (existing.includes(kw)) return;
        updateLoreChunk(chunkId, { secondaryKeywords: [...existing, kw] });
        setNewSecondary(prev => ({ ...prev, [chunkId]: '' }));
    };

    const removeSecondaryKeyword = (chunkId: string, kw: string) => {
        const chunk = loreChunks.find(c => c.id === chunkId);
        if (!chunk) return;
        updateLoreChunk(chunkId, { secondaryKeywords: (chunk.secondaryKeywords || []).filter(k => k !== kw) });
    };

    const regenerateKeywords = (chunkId: string) => {
        const chunk = loreChunks.find(c => c.id === chunkId);
        if (!chunk) return;
        if (confirmRegenId !== chunkId) {
            setConfirmRegenId(chunkId);
            return;
        }
        const fresh = deriveDefaultLoreMeta(chunk);
        updateLoreChunk(chunkId, {
            activationModes: fresh,
            modesUserEdited: false,
        });
        setConfirmRegenId(null);
    };

    const renderChunk = (chunk: LoreChunk) => {
        const modes = getModes(chunk);
        const isVector = modes.includes('vector');
        const isKeyword = modes.includes('keyword');
        const isAlways = modes.includes('always');
        const isDisabled = modes.length === 0;

        return (
            <div key={chunk.id} className={`bg-void rounded border p-2 transition-colors ${isDisabled ? 'border-border opacity-50' : isAlways ? 'border-terminal/40' : 'border-border'}`}>
                <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[10px] text-text-primary font-bold truncate flex-1 mr-2" title={chunk.header}>
                        {chunk.header}
                    </span>
                    <span className="text-[9px] text-text-dim shrink-0">
                        {chunk.tokens}tk
                    </span>
                </div>

                <div className="flex items-center gap-3 mb-1.5">
                    <label className="flex items-center gap-1 text-[9px] text-text-dim cursor-pointer">
                        <input
                            type="checkbox"
                            checked={isVector}
                            onChange={() => toggleMode(chunk.id, 'vector')}
                            className="w-3 h-3 accent-terminal"
                        />
                        Vector
                    </label>
                    <label className="flex items-center gap-1 text-[9px] text-text-dim cursor-pointer">
                        <input
                            type="checkbox"
                            checked={isKeyword}
                            onChange={() => toggleMode(chunk.id, 'keyword')}
                            className="w-3 h-3 accent-terminal"
                        />
                        Keyword
                    </label>
                    <label className="flex items-center gap-1 text-[9px] text-text-dim cursor-pointer">
                        <input
                            type="checkbox"
                            checked={isAlways}
                            onChange={() => toggleMode(chunk.id, 'always')}
                            className="w-3 h-3 accent-terminal"
                        />
                        Always
                    </label>
                    <label className="flex items-center gap-1 text-[9px] text-text-dim cursor-pointer">
                        <input
                            type="checkbox"
                            checked={isDisabled}
                            onChange={() => toggleDisabled(chunk.id)}
                            className="w-3 h-3 accent-danger"
                        />
                        Disabled
                    </label>
                    <label className="flex items-center gap-1 text-[9px] text-text-dim">
                        Depth:
                        <select
                            value={chunk.scanDepth || 3}
                            onChange={(e) => updateLoreChunk(chunk.id, { scanDepth: parseInt(e.target.value) })}
                            className="bg-surface border border-border rounded px-2 py-1.5 md:py-0.5 text-xs md:text-[9px] text-text-primary min-h-[36px] md:min-h-0"
                        >
                            <option value={1}>1</option>
                            <option value={2}>2</option>
                            <option value={3}>3</option>
                            <option value={5}>5</option>
                            <option value={10}>10</option>
                        </select>
                    </label>
                </div>

                {isKeyword && (
                    <div className="mb-1.5">
                        <div className="text-[8px] text-text-dim uppercase tracking-wider mb-0.5">Secondary (AND-gate)</div>
                        <div className="flex flex-wrap gap-1 mb-1">
                            {(chunk.secondaryKeywords || []).map(kw => (
                                <span
                                    key={kw}
                                    className="inline-flex items-center gap-1 bg-surface border border-terminal/30 rounded px-1.5 py-0.5 text-[8px] text-terminal-dim hover:border-danger cursor-pointer"
                                    onClick={() => removeSecondaryKeyword(chunk.id, kw)}
                                    title="Click to remove"
                                >
                                    {kw}
                                    <span className="text-[8px]">×</span>
                                </span>
                            ))}
                        </div>
                        <div className="flex gap-1">
                            <input
                                type="text"
                                value={newSecondary[chunk.id] || ''}
                                onChange={(e) => setNewSecondary(prev => ({ ...prev, [chunk.id]: e.target.value }))}
                                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSecondaryKeyword(chunk.id); } }}
                                placeholder="+ secondary kw"
                                className="flex-1 bg-surface border border-border rounded px-2 py-1 md:py-0.5 text-[16px] md:text-[8px] text-text-primary placeholder:text-text-dim/40 min-h-[36px] md:min-h-0"
                            />
                            <button
                                onClick={() => addSecondaryKeyword(chunk.id)}
                                className="text-[10px] md:text-[8px] text-terminal hover:text-text-primary px-2 md:px-1 touch-btn md:min-h-0 md:min-w-0"
                            >
                                +
                            </button>
                        </div>
                    </div>
                )}

                <div className="flex flex-wrap gap-1 mb-1.5">
                    {(chunk.triggerKeywords || []).map((kw) => (
                        <span
                            key={kw}
                            className="inline-flex items-center gap-1 bg-surface border border-border rounded px-2.5 md:px-1.5 py-1.5 md:py-0.5 text-xs md:text-[9px] text-text-dim hover:border-danger group cursor-pointer min-h-[32px] md:min-h-0"
                            onClick={() => removeKeyword(chunk.id, kw)}
                            title="Click to remove"
                        >
                            {kw}
                            <span className="text-danger opacity-100 md:opacity-0 md:group-hover:opacity-100 text-[10px] md:text-[8px]">×</span>
                        </span>
                    ))}
                </div>

                <div className="flex gap-1">
                    <input
                        type="text"
                        value={newKeyword[chunk.id] || ''}
                        onChange={(e) => setNewKeyword(prev => ({ ...prev, [chunk.id]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addKeyword(chunk.id); } }}
                        placeholder="+ keyword"
                        className="flex-1 bg-surface border border-border rounded px-3 py-2 md:py-0.5 text-[16px] md:text-[9px] text-text-primary placeholder:text-text-dim/40 min-h-[44px] md:min-h-0"
                    />
                    <button
                        onClick={() => addKeyword(chunk.id)}
                        className="text-[14px] md:text-[9px] text-terminal hover:text-text-primary px-3 md:px-1 touch-btn md:min-h-0 md:min-w-0"
                    >
                        +
                    </button>
                    <button
                        onClick={() => regenerateKeywords(chunk.id)}
                        onBlur={() => setConfirmRegenId(null)}
                        className={`text-[9px] transition-colors ${
                            confirmRegenId === chunk.id
                                ? 'text-danger font-bold'
                                : 'text-text-dim hover:text-terminal'
                        }`}
                        title={confirmRegenId === chunk.id ? 'Click again to confirm — resets activation modes to defaults' : 'Reset activation modes to defaults'}
                    >
                        {confirmRegenId === chunk.id ? 'Confirm?' : <RotateCcw size={10} />}
                    </button>
                </div>
            </div>
        );
    };

    const alwaysChunks = loreChunks.filter(c => {
        const modes = getModes(c);
        return modes.includes('always');
    });
    const conditionalChunks = loreChunks.filter(c => {
        const modes = getModes(c);
        return !modes.includes('always');
    });

    const totalTokens = loreChunks.reduce((sum, c) => sum + c.tokens, 0);

    return (
        <div className="px-4 py-4 space-y-4">
            <div className="flex items-center justify-between">
                <p className="text-[9px] text-text-dim/50">
                    Always On = included every turn (AI is stateless). Conditional = triggered by keyword / vector match only.
                </p>
            </div>

            <div className="text-[9px] text-text-dim/70 space-y-1">
                <div>Total lore: {totalTokens} tokens across {loreChunks.length} chunks</div>
                <div>Token budget: {settings.contextLimit || 8192} tokens/turn</div>
            </div>

            <button
                onClick={runIndex}
                disabled={indexing || loreChunks.length === 0}
                className={`w-full py-2 text-[10px] uppercase tracking-wider font-bold rounded transition-colors ${
                    indexing
                        ? 'bg-surface text-text-dim cursor-not-allowed'
                        : 'bg-terminal/10 text-terminal hover:bg-terminal/20'
                }`}
            >
                {indexing
                    ? `Indexing... ${progress ? `${progress.current}/${progress.total} (${progress.phase})` : ''}`
                    : 'Re-index Lore'}
            </button>

            {indexing && progress && (
                <div className="h-1 bg-void-lighter rounded overflow-hidden">
                    <div
                        className="h-full bg-terminal transition-all duration-200"
                        style={{ width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%` }}
                    />
                </div>
            )}

            {loreChunks.length > 0 && (
                <div className="flex items-center gap-1.5">
                    <span className="text-[8px] text-text-dim/60 uppercase tracking-wider shrink-0">Bulk:</span>
                    {(['vector', 'keyword', 'always'] as ActivationMode[]).map(mode => {
                        const on = bulkModeIsOn(mode);
                        return (
                            <button
                                key={mode}
                                onClick={() => bulkToggleMode(mode)}
                                title={`${on ? 'Turn off' : 'Turn on'} ${mode} for all chunks`}
                                className={`flex-1 py-1.5 md:py-1 text-[9px] uppercase tracking-wider rounded border transition-colors ${
                                    on
                                        ? 'bg-terminal/15 text-terminal border-terminal/40'
                                        : 'bg-surface text-text-dim border-transparent hover:text-terminal hover:bg-terminal/10'
                                }`}
                            >
                                {mode}
                            </button>
                        );
                    })}
                    <button
                        onClick={bulkDisableAll}
                        title="Disable all chunks (clears every mode)"
                        className="flex-1 py-1.5 md:py-1 text-[9px] uppercase tracking-wider rounded bg-surface text-text-dim hover:text-danger hover:bg-danger/10 transition-colors"
                    >
                        Disable All
                    </button>
                </div>
            )}

            {loreChunks.length === 0 ? (
                <p className="text-text-dim/50 text-xs text-center mt-8">
                    No lore uploaded for this campaign.
                </p>
            ) : (
                <div className="space-y-3">
                    {alwaysChunks.length > 0 && (
                        <div className="space-y-2 mb-4">
                            <div className="text-[10px] text-terminal uppercase tracking-wider font-bold mb-1 border-b border-terminal/20 pb-1 flex items-center gap-2">
                                <div className="w-1.5 h-1.5 rounded-full bg-terminal animate-pulse" />
                                Always On ({alwaysChunks.length})
                            </div>
                            {alwaysChunks.map(renderChunk)}
                        </div>
                    )}
                    {conditionalChunks.length > 0 && (
                        <div className="space-y-2">
                            <div className="text-[10px] text-text-dim uppercase tracking-wider font-bold mb-1 border-b border-border/50 pb-1 flex items-center gap-2">
                                <div className="w-1.5 h-1.5 rounded-full bg-text-dim/50" />
                                Conditional ({conditionalChunks.length})
                            </div>
                            {conditionalChunks.map(renderChunk)}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}