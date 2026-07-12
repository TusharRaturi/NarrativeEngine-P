import { useState } from 'react';
import { ChevronDown, ChevronRight, Lock } from 'lucide-react';

type OAIMsg = { role: string; content: string | null; name?: string; cache_control?: { type: string } };

const VOLATILE_SEP = '\n\n---\n\n';

const tok = (s: string) => Math.round(s.length / 4);

function classifyHistory(m: OAIMsg): { label: string; color: string } {
    if (m.role === 'user') return { label: 'YOU', color: 'text-terminal/50' };
    if (m.role === 'tool') return { label: 'TOOL', color: 'text-amber-400/50' };
    if (m.role === 'assistant') return { label: 'GM', color: 'text-sky-400/50' };
    const c = m.content || '';
    if (c.startsWith('[SCENE NOTE')) return { label: 'GM NOTE', color: 'text-emerald-400/70' };
    if (c.startsWith('[PINNED MEMORIES')) return { label: 'PINNED', color: 'text-violet-400/70' };
    return { label: 'SYSTEM', color: 'text-text-dim/50' };
}

const Row: React.FC<{
    label: string;
    labelColor: string;
    content: string;
    locked?: boolean;
    defaultOpen?: boolean;
}> = ({ label, labelColor, content, locked, defaultOpen }) => {
    const [open, setOpen] = useState(!!defaultOpen);
    const preview = content.slice(0, 80).replace(/\n/g, ' ');
    return (
        <div>
            <button onClick={() => setOpen(p => !p)} className="w-full flex items-center gap-1.5 px-2 py-1.5 hover:bg-terminal/5 text-left">
                {open ? <ChevronDown size={9} className="text-terminal/30 shrink-0" /> : <ChevronRight size={9} className="text-terminal/30 shrink-0" />}
                <span className={`text-[8px] font-bold shrink-0 ${labelColor}`}>{label}</span>
                {locked && <Lock size={7} className="text-emerald-400/50 shrink-0" />}
                <span className="text-text-dim/40 truncate ml-1 text-[8px]">{preview}{content.length > 80 ? '…' : ''}</span>
                <span className="ml-auto text-text-dim/30 shrink-0 text-[8px]">~{tok(content)}t</span>
            </button>
            {open && (
                <div className="px-2 pb-2 text-[9px] text-text-dim/60 whitespace-pre-wrap break-words max-h-48 overflow-y-auto bg-void border-t border-terminal/5">
                    {content}
                </div>
            )}
        </div>
    );
};

const Section: React.FC<{
    title: string;
    count?: number;
    open: boolean;
    onToggle: () => void;
    children: React.ReactNode;
}> = ({ title, count, open, onToggle, children }) => (
    <div className="border border-terminal/10 rounded overflow-hidden">
        <button onClick={onToggle} className="w-full flex items-center gap-1.5 px-2 py-1.5 hover:bg-terminal/5 text-left">
            {open ? <ChevronDown size={10} className="text-terminal/40 shrink-0" /> : <ChevronRight size={10} className="text-terminal/40 shrink-0" />}
            <span className="text-terminal/50 uppercase tracking-widest">{title}</span>
            {count !== undefined && <span className="ml-auto text-text-dim/30">{count} msg{count !== 1 ? 's' : ''}</span>}
        </button>
        {open && <div className="border-t border-terminal/10 divide-y divide-terminal/5">{children}</div>}
    </div>
);

export const EngineTraceView: React.FC<{ payload: unknown }> = ({ payload }) => {
    const messages = (payload as unknown as OAIMsg[]) || [];
    const [open, setOpen] = useState({ prefix: false, history: false, turn: true });
    const toggle = (k: keyof typeof open) => setOpen(p => ({ ...p, [k]: !p[k] }));

    // Walk the array IN REAL ORDER. Leading consecutive system messages form the cached prefix
    // (rules + divergence). Everything after, up to the final user message, is history — which
    // may contain system messages spliced in at depth (scene/GM notes, pinned memories) that must
    // stay in their real position, not be hoisted to the top.
    let prefixEnd = 0;
    while (prefixEnd < messages.length && messages[prefixEnd].role === 'system') prefixEnd++;
    const prefixMsgs = messages.slice(0, prefixEnd);

    const rest = messages.slice(prefixEnd);
    const lastUserIdx = rest.reduce((acc, m, i) => (m.role === 'user' ? i : acc), -1);
    const historyMsgs = lastUserIdx >= 0 ? rest.slice(0, lastUserIdx) : rest;
    const thisTurn = lastUserIdx >= 0 ? rest[lastUserIdx] : undefined;

    // The final user turn now carries volatile context (world lore, archive recall, NPCs, retrieved
    // rules) folded in ahead of the player's typed input, separated by VOLATILE_SEP.
    const turnContent = thisTurn?.content ?? '';
    const sepIdx = turnContent.indexOf(VOLATILE_SEP);
    const volatileContext = sepIdx >= 0 ? turnContent.slice(0, sepIdx) : '';
    const playerInput = sepIdx >= 0 ? turnContent.slice(sepIdx + VOLATILE_SEP.length) : turnContent;

    return (
        <div className="mt-3 border-t border-border/10 pt-3 font-mono text-[9px] space-y-1.5">
            <div className="text-[8px] text-text-dim/30 uppercase tracking-[0.3em] flex items-center gap-1.5 mb-2">
                <span className="w-1.5 h-1.5 rounded-full bg-current opacity-50" />
                Engine Trace Data
            </div>

            <Section title="Cached Prefix" count={prefixMsgs.length} open={open.prefix} onToggle={() => toggle('prefix')}>
                {prefixMsgs.map((m, i) => (
                    <Row key={i} label="SYSTEM" labelColor="text-text-dim/50" locked={!!m.cache_control} content={m.content || ''} />
                ))}
            </Section>

            {historyMsgs.length > 0 && (
                <Section title="History (cached)" count={historyMsgs.length} open={open.history} onToggle={() => toggle('history')}>
                    {historyMsgs.map((m, i) => {
                        const { label, color } = classifyHistory(m);
                        const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content) || '';
                        return <Row key={i} label={label} labelColor={color} content={text} />;
                    })}
                </Section>
            )}

            {/* Cache boundary: everything above is the stable, cacheable prefix; This Turn is volatile. */}
            {thisTurn && (
                <div className="flex items-center gap-2 px-1 py-0.5">
                    <div className="flex-1 border-t border-dashed border-amber-400/30" />
                    <span className="text-[7px] uppercase tracking-[0.2em] text-amber-400/50">cache boundary</span>
                    <div className="flex-1 border-t border-dashed border-amber-400/30" />
                </div>
            )}

            {thisTurn && (
                <Section title="This Turn — Volatile" open={open.turn} onToggle={() => toggle('turn')}>
                    {volatileContext && (
                        <Row label="▸ VOLATILE CONTEXT" labelColor="text-amber-400/60" content={volatileContext} />
                    )}
                    <Row label="▸ PLAYER INPUT" labelColor="text-terminal/60" content={playerInput} defaultOpen />
                </Section>
            )}
        </div>
    );
};
