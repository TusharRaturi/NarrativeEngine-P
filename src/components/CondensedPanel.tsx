import { useState } from 'react';
import { FileText, Edit2, RotateCcw, Check, X, RotateCw, List, Sparkles, Plus } from 'lucide-react';
import { toast } from './Toast';
import type { DivergenceCategory, DivergenceEntry, DivergenceRegister, EndpointConfig } from '../types';
import { QuestPanel } from './QuestPanel';
import { countRegisterTokens } from '../services/divergenceRegister';

const CATEGORIES: DivergenceCategory[] = ['canon_override', 'world_change', 'entity_state', 'player_state', 'obligation'];

interface CondensedPanelProps {
    condensedSummary: string;
    condensedUpToIndex: number;
    messageCount: number;
    onSave: (draft: string) => void;
    onRetcon: (draft: string) => void;
    onReset: () => void;
    divergenceRegister?: DivergenceRegister;
    onResolveDivergence?: (id: string) => void;
    onDeleteDivergence?: (id: string) => void;
    onEditDivergence?: (id: string, patch: Partial<DivergenceEntry>) => void;
    onAISummary?: (provider: EndpointConfig) => Promise<string>;
    onAddManual?: () => void;
    provider?: EndpointConfig;
    contextLimit?: number;
}

type Tab = 'summary' | 'register';

export function CondensedPanel({
    condensedSummary,
    condensedUpToIndex,
    messageCount,
    onSave,
    onRetcon,
    onReset,
    divergenceRegister,
    onResolveDivergence,
    onDeleteDivergence,
    onEditDivergence,
    onAISummary,
    onAddManual,
    provider,
    contextLimit = 8192,
}: CondensedPanelProps) {
    const hasSummary = !!condensedSummary;
    const [isEditing, setIsEditing] = useState(false);
    const [draft, setDraft] = useState('');
    const [tab, setTab] = useState<Tab>(hasSummary ? 'summary' : 'register');
    const [aiSummaryLoading, setAiSummaryLoading] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editCat, setEditCat] = useState<DivergenceCategory>('entity_state');
    const [editSubject, setEditSubject] = useState('');
    const [editDivergence, setEditDivergence] = useState('');
    const [editSceneRef, setEditSceneRef] = useState('');

    const entries = divergenceRegister?.entries ?? [];
    const regTokens = divergenceRegister ? countRegisterTokens(divergenceRegister) : 0;

    const startEdit = (e: DivergenceEntry) => {
        setEditingId(e.id);
        setEditCat(e.category);
        setEditSubject(e.subject);
        setEditDivergence(e.divergence);
        setEditSceneRef(e.sceneRef);
    };

    const cancelEdit = () => {
        setEditingId(null);
    };

    const saveEdit = () => {
        if (!editingId || !onEditDivergence) return;
        onEditDivergence(editingId, {
            category: editCat,
            subject: editSubject,
            divergence: editDivergence,
            sceneRef: editSceneRef,
        });
        setEditingId(null);
        toast.success('Entry updated');
    };

    return (
        <div className="mx-2 md:mx-4 mb-1 border border-amber-500/30 bg-amber-500/5 rounded-sm overflow-hidden animate-[msg-in_0.15s_ease-out]">
            <div className="flex items-center justify-between px-3 py-1.5 bg-amber-500/10 border-b border-amber-500/20">
                <div className="flex items-center gap-2">
                    <div className="flex border border-amber-500/20 rounded overflow-hidden">
                        <button
                            onClick={() => setTab('summary')}
                            className={`flex items-center gap-1 px-2 py-1 text-[9px] uppercase tracking-wider transition-colors ${tab === 'summary' ? 'bg-amber-500/20 text-amber-400 font-bold' : 'text-text-dim hover:text-amber-400'}`}
                        >
                            <FileText size={10} />
                            Summary
                        </button>
                        <button
                            onClick={() => setTab('register')}
                            className={`flex items-center gap-1 px-2 py-1 text-[9px] uppercase tracking-wider transition-colors ${tab === 'register' ? 'bg-amber-500/20 text-amber-400 font-bold' : 'text-text-dim hover:text-amber-400'}`}
                        >
                            <List size={10} />
                            Register
                            {entries.length > 0 && <span className="text-[8px] bg-amber-500/30 px-1 rounded">{entries.length}</span>}
                        </button>
                    </div>
                    <span className="text-[9px] text-text-dim">{hasSummary ? `(up to msg #${condensedUpToIndex})` : '(no summary yet)'}</span>
                </div>
                <div className="flex items-center gap-1">
                    {tab === 'summary' && hasSummary && !isEditing ? (
                        <>
                            <button
                                onClick={() => { setDraft(condensedSummary); setIsEditing(true); }}
                                className="text-text-dim hover:text-amber-500 p-1 bg-void-lighter rounded transition-colors"
                                title="Edit summary (retcon)"
                            >
                                <Edit2 size={11} />
                            </button>
                            <button
                                onClick={() => {
                                    if (window.confirm('Reset condensed memory? This will clear the summary and re-include all messages in context. Cannot be undone.')) {
                                        onReset();
                                        toast.info('Condensed memory cleared — full history restored to context');
                                    }
                                }}
                                className="text-text-dim hover:text-danger p-1 bg-void-lighter rounded transition-colors"
                                title="Reset condensed memory entirely"
                            >
                                <RotateCw size={11} />
                            </button>
                        </>
                    ) : tab === 'summary' && isEditing ? (
                        <>
                            <button
                                onClick={() => { onSave(draft); setIsEditing(false); toast.success('Condensed memory updated'); }}
                                className="text-text-dim hover:text-emerald-500 p-1 bg-void-lighter rounded transition-colors"
                                title="Save edits (keep raw history)"
                            >
                                <Check size={11} />
                            </button>
                            <button
                                onClick={() => {
                                    if (window.confirm('RETCON: This will override ALL raw conversation history. Only your edited summary + your next message will be sent to the AI. Use this to rewrite scenes.')) {
                                        onRetcon(draft);
                                        setIsEditing(false);
                                        toast.success(`Retcon applied — all ${messageCount} messages now behind summary boundary`);
                                    }
                                }}
                                className="text-text-dim hover:text-amber-500 p-1 bg-void-lighter rounded transition-colors"
                                title="RETCON: Save edits & override all raw history"
                            >
                                <RotateCcw size={11} />
                            </button>
                            <button
                                onClick={() => { setIsEditing(false); setDraft(''); }}
                                className="text-text-dim hover:text-danger p-1 bg-void-lighter rounded transition-colors"
                                title="Cancel edits"
                            >
                                <X size={11} />
                            </button>
                        </>
                    ) : null}
                </div>
            </div>
            <div className="p-3 max-h-[250px] overflow-y-auto">
                {tab === 'summary' ? (
                    isEditing ? (
                        <textarea
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            className="w-full bg-void border border-amber-500/30 focus:border-amber-500 text-text-primary text-[11px] font-mono leading-relaxed p-2 resize-y min-h-[120px] max-h-[400px] outline-none rounded-sm transition-colors"
                            placeholder="Edit condensed memory..."
                        />
                    ) : hasSummary ? (
                        <div className="text-[11px] text-text-primary/80 font-mono leading-relaxed whitespace-pre-wrap">
                            {condensedSummary}
                        </div>
                    ) : (
                        <p className="text-[10px] text-text-dim italic">No condensed summary yet. Run Condense to generate one, or switch to the Register tab to view divergence entries.</p>
                    )
                ) : (
                    <div className="space-y-3">
                        <div className="flex items-center justify-between">
                            <span className="text-[9px] text-text-dim uppercase tracking-wider">{entries.length} entries &middot; ~{regTokens} tokens</span>
                            <div className="flex items-center gap-3">
                                {onAddManual && (
                                    <button
                                        onClick={onAddManual}
                                        className="flex items-center gap-1 text-[9px] text-emerald-400 hover:text-emerald-300"
                                    >
                                        <Plus size={10} />
                                        Add Manual
                                    </button>
                                )}
                                {provider && onAISummary && (
                                    <button
                                        onClick={async () => {
                                            setAiSummaryLoading(true);
                                            try {
                                                const summary = await onAISummary(provider);
                                                if (summary) toast.success('AI summary copied to clipboard');
                                            } catch (e) {
                                                console.error('[AI Summary] failed', e);
                                            }
                                            setAiSummaryLoading(false);
                                        }}
                                        disabled={aiSummaryLoading || entries.length === 0}
                                        className="flex items-center gap-1 text-[9px] text-amber-400 hover:text-amber-300 disabled:opacity-40"
                                    >
                                        {aiSummaryLoading ? <RotateCw size={10} className="animate-spin" /> : <Sparkles size={10} />}
                                        AI Summary
                                    </button>
                                )}
                            </div>
                        </div>
                        
                        {/* Token Budget Bar */}
                        <div className="space-y-1">
                            <div className="flex justify-between text-[8px] uppercase tracking-tighter text-text-dim font-mono">
                                <span>Register Payload</span>
                                <span>{regTokens} / {Math.floor(contextLimit * 0.4)} tokens</span>
                            </div>
                            <div className="h-1 bg-void border border-white/5 rounded-full overflow-hidden">
                                <div 
                                    className={`h-full transition-all duration-500 ${regTokens > contextLimit * 0.35 ? 'bg-danger' : regTokens > contextLimit * 0.2 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                                    style={{ width: `${Math.min(100, (regTokens / (contextLimit * 0.4)) * 100)}%` }}
                                />
                            </div>
                        </div>
                        {entries.length === 0 ? (
                            <p className="text-[10px] text-text-dim italic">No divergence entries yet. Use the ⚡ button on GM messages to tag divergences.</p>
                        ) : (
                            <>
                                <QuestPanel entries={entries} onResolve={(id) => onResolveDivergence?.(id)} />
                                <div className="space-y-1.5">
                                    {entries.filter(e => e.category !== 'obligation' || e.resolved).map(e => (
                                        editingId === e.id ? (
                                            <div key={e.id} className="bg-void-lighter border border-amber-500/30 p-2 rounded-sm space-y-1.5">
                                                <div className="flex gap-1.5">
                                                    <select
                                                        value={editCat}
                                                        onChange={ev => setEditCat(ev.target.value as DivergenceCategory)}
                                                        className="bg-void border border-white/10 text-text-primary text-[10px] px-1 py-0.5 rounded-sm outline-none"
                                                    >
                                                        {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                                                    </select>
                                                    <input
                                                        value={editSceneRef}
                                                        onChange={ev => setEditSceneRef(ev.target.value)}
                                                        className="bg-void border border-white/10 text-text-primary text-[10px] px-1 py-0.5 rounded-sm outline-none w-14"
                                                        placeholder="Scene"
                                                    />
                                                </div>
                                                <input
                                                    value={editSubject}
                                                    onChange={ev => setEditSubject(ev.target.value)}
                                                    className="w-full bg-void border border-white/10 text-text-primary text-[10px] px-1 py-0.5 rounded-sm outline-none"
                                                    placeholder="Subject"
                                                />
                                                <textarea
                                                    value={editDivergence}
                                                    onChange={ev => setEditDivergence(ev.target.value)}
                                                    className="w-full bg-void border border-white/10 text-text-primary text-[10px] px-1 py-0.5 rounded-sm outline-none resize-y min-h-[28px] max-h-[60px]"
                                                    placeholder="Divergence"
                                                    rows={2}
                                                />
                                                <div className="flex gap-1.5 justify-end">
                                                    <button onClick={saveEdit} className="flex items-center gap-1 text-[9px] text-emerald-400 hover:text-emerald-300 px-1.5 py-0.5 rounded-sm bg-emerald-500/10">
                                                        <Check size={9} /> Save
                                                    </button>
                                                    <button onClick={cancelEdit} className="flex items-center gap-1 text-[9px] text-text-dim hover:text-danger px-1.5 py-0.5 rounded-sm bg-white/5">
                                                        <X size={9} /> Cancel
                                                    </button>
                                                </div>
                                            </div>
                                        ) : (
                                            <div key={e.id} className={`flex items-start gap-2 text-[10px] group p-1 rounded-sm transition-colors ${e.parseError ? 'bg-danger/10 border border-dashed border-danger/40' : 'hover:bg-white/5'}`}>
                                                <span className={`shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full ${e.category === 'canon_override' ? 'bg-red-400' : e.category === 'world_change' ? 'bg-blue-400' : e.category === 'entity_state' ? 'bg-purple-400' : e.category === 'player_state' ? 'bg-green-400' : 'bg-amber-400'}`} title={e.category} />
                                                <div className="min-w-0 flex-1">
                                                    {e.parseError && <span className="text-danger font-bold mr-1">[PARSE ERR]</span>}
                                                    <span className="text-text-primary">{e.subject}: {e.divergence}</span>
                                                    <span className="text-text-dim ml-1">[#{e.sceneRef}]</span>
                                                    {e.resolved && <span className="text-text-dim ml-1 line-through">resolved</span>}
                                                </div>
                                                {(onEditDivergence || onDeleteDivergence) && (
                                                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                                                        {onEditDivergence && (
                                                            <button
                                                                onClick={() => startEdit(e)}
                                                                className="text-text-dim hover:text-amber-400 p-0.5"
                                                                title="Edit entry"
                                                            >
                                                                <Edit2 size={9} />
                                                            </button>
                                                        )}
                                                        {onDeleteDivergence && (
                                                            <button
                                                                onClick={() => onDeleteDivergence(e.id)}
                                                                className="text-text-dim hover:text-danger p-0.5"
                                                                title="Delete entry"
                                                            >
                                                                <X size={10} />
                                                            </button>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        )
                                    ))}
                                </div>
                            </>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
