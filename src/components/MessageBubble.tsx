import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Edit2, Trash2, Loader2, Check, X, Volume2, Square, RotateCw, Play, Pause, RefreshCw, Rewind, ChevronLeft, ChevronRight, FastForward } from 'lucide-react';
import type { ChatMessage, DebugSection, NPCEntry } from '../types';
import { DebugPayloadView } from './DebugPayloadView';
import { ToolCallChips } from './chat/ToolCallChips';
import { useRef, useEffect, useState, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useTtsStatus } from '../services/tts/useTtsStatus';
import { generateTts, loadCachedTts, checkCachedChunks } from '../services/tts/ttsClient';
import { proseForTTS, chunkSentencesForTTS, splitWords } from '../services/tts/proseStripper';
import { useAppStore } from '../store/useAppStore';
import { hasSwipeSet } from '../services/turn/pendingCommit';
import { MAX_SWIPES } from '../services/turn/swipeGeneration';

// WO-J: NPC names arrive wrapped in [Name] / [**Name**] brackets so the ledger detector
// can read them out of the raw content. Render them as inline **bold** markdown instead of
// literal bracketed text, so the name flows inside the surrounding paragraph. The brackets
// only live in the display copy; the raw stored content the detector reads is untouched.
const NAME_BRACKET_RE = /\[\*{0,2}\s*([A-Za-z][A-Za-z0-9 _.'-]*[A-Za-z0-9.])\s*\*{0,2}\]/g;

function looksLikeSystemTag(s: string): boolean {
    return s.includes(':') || s.includes('SURPRISE') || s.includes('ENCOUNTER') || s.includes('WORLD_EVENT');
}

function inlineNameBrackets(text: string): string {
    return text.replace(NAME_BRACKET_RE, (full, inner: string) =>
        looksLikeSystemTag(inner) ? full : `**${inner.trim()}**`
    );
}

// ── NPC hover-thumbnail wiring ──────────────────────────────────────────────
// Wrap known ledger NPC names (by name + alias, case-insensitive, whole-word) in
// markdown link syntax `[Name](#npc-p-{id})` so react-markdown parses them. The
// custom `a` renderer below turns those sentinel-href links into hover thumbnails
// instead of real anchors. We split on code fences / inline code / existing links
// to avoid mangling code or nested links.
type NpcLookup = {
    re: RegExp;
    idToNpc: Map<string, { id: string; name: string; portrait: string }>;
    nameToId: Map<string, string>;
};

function buildNpcLookup(ledger: NPCEntry[]): NpcLookup | null {
    const withPortrait = ledger.filter(n => n.portrait && !n.archived);
    if (withPortrait.length === 0) return null;

    const idToNpc = new Map<string, { id: string; name: string; portrait: string }>();
    const nameToId = new Map<string, string>();
    for (const npc of withPortrait) {
        idToNpc.set(npc.id, { id: npc.id, name: npc.name, portrait: npc.portrait! });
        const explicitVariants = [npc.name, ...(npc.aliases ? npc.aliases.split(',').map(s => s.trim()).filter(Boolean) : [])];
        // Auto-index the first token of multi-word names (e.g. "Rin" from "Rin Holmes")
        // so recurring NPCs get highlighted by their first name in prose. Skip tokens
        // shorter than 3 chars to limit false-positive common-word matches.
        const firstName = npc.name.split(/\s+/)[0]?.trim();
        const autoVariants = firstName && firstName.length >= 3 ? [firstName] : [];
        const variants = [...explicitVariants, ...autoVariants];
        for (const v of variants) {
            const key = v.toLowerCase();
            // Longer names win — only set if not already present (we sort names desc below).
            if (v && !nameToId.has(key)) nameToId.set(key, npc.id);
        }
    }
    // Sort names by length descending so "Captain Aldric" matches before "Aldric".
    const names = [...nameToId.keys()].sort((a, b) => b.length - a.length);
    if (names.length === 0) return null;
    const escaped = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    // Lookbehind/lookahead on a non-letter boundary. Chromium (Electron) supports lookbehind.
    const re = new RegExp(`(?<![A-Za-z])(${escaped.join('|')})(?![A-Za-z])`, 'gi');
    return { re, idToNpc, nameToId };
}

function wrapNpcNames(text: string, lookup: NpcLookup): string {
    const replaceInSegment = (s: string) =>
        s.replace(lookup.re, (_full, name: string) => {
            const id = lookup.nameToId.get(name.toLowerCase());
            if (!id) return name;
            return `[${name}](#npc-p-${id})`;
        });

    // Split out fenced code blocks (```...```) — don't touch their contents.
    return text.split(/(```[\s\S]*?```)/g).map((segment, i) => {
        if (i % 2 === 1) return segment; // inside a code fence
        // Split out inline code (`...`) — don't touch.
        return segment.split(/(`[^`]+`)/g).map((seg2, j) => {
            if (j % 2 === 1) return seg2; // inside inline code
            // Split out existing markdown links [text](url) — don't touch.
            return seg2.split(/(\[[^\]]*\]\([^)]*\))/g).map((seg3, k) => {
                if (k % 2 === 1) return seg3; // inside an existing link
                return replaceInSegment(seg3);
            }).join('');
        }).join('');
    }).join('');
}

interface MessageBubbleProps {
    message: ChatMessage;
    isStreaming: boolean;
    isLastMessage: boolean;
    showReasoning: boolean;
    debugMode: boolean;
    onStartEdit: (message: ChatMessage) => void;
    onRegenerate: (id: string) => void;
    onDelete: (id: string) => void;
    /** Raw result content for the first tool call on this message, if any. */
    toolResult?: string;
    /** WO-EDIT — inline edit wiring. When set, this bubble is the live editor. */
    isEditing?: boolean;
    inlineDraft?: string;
    onInlineDraftChange?: (v: string) => void;
    onInlineSubmit?: () => void;
    onInlineCancel?: () => void;
    /** Swipe Generation v1: called when the user taps 🔄 on the latest GM bubble. */
    onOpenSwipeSheet?: (messageId: string) => void;
    /** Swipe Generation v1: called when the user swipes left/right on the bubble. */
    onSwipeNavigate?: (messageId: string, direction: 'prev' | 'next') => void;
    /** Scene Continue v1: called when the user taps the Continue button on the latest GM bubble.
     *  Returns a promise the caller can await if it wants to block on completion. */
    onSceneContinue?: (messageId: string) => void | Promise<void>;
    /** Scene Continue v1: true while a continue is streaming into ANY pending GM bubble. */
    sceneContinueLoading?: boolean;
    /** Swipe Generation v1: true while a swipe is generating (mutual exclusion — Continue is disabled during swipes). */
    swipeGenLoading?: boolean;
    /** Global stream lock — true while a real turn is streaming (mutual exclusion — Continue is disabled during turns). */
    globalIsStreaming?: boolean;
}

/**
 * SwipeIndicator — shows "2/5" position and prev/next chevrons for the
 * latest GM message's swipe set. Touch-swipe left/right on the bubble
 * navigates; the chevrons are tap targets for desktop / accessibility.
 */
function SwipeIndicator({
    msg,
    onPrev,
    onNext,
}: {
    msg: ChatMessage;
    onPrev: () => void;
    onNext: () => void;
}) {
    const swipeSet = msg.swipeSet;
    if (!swipeSet) return null;
    const current = (msg.swipeActiveIndex ?? 0) + 1;
    const total = Math.max(swipeSet.length, MAX_SWIPES);
    const atFirst = (msg.swipeActiveIndex ?? 0) === 0;
    const atLast = (msg.swipeActiveIndex ?? 0) >= swipeSet.length - 1 && swipeSet.length >= MAX_SWIPES;
    const isStreaming = swipeSet[msg.swipeActiveIndex ?? 0]?.streaming === true;

    return (
        <div className="flex items-center justify-center gap-2 text-[10px] uppercase tracking-widest text-text-dim select-none">
            <button
                onClick={onPrev}
                disabled={atFirst}
                className="p-0.5 rounded text-text-dim hover:text-ice disabled:opacity-30 disabled:pointer-events-none transition-colors"
                title="Previous variant"
            >
                <ChevronLeft size={12} />
            </button>
            <span className="font-mono text-text-dim/80">
                {isStreaming ? '…' : current}/{total}
            </span>
            <button
                onClick={onNext}
                disabled={atLast}
                className="p-0.5 rounded text-text-dim hover:text-ice disabled:opacity-30 disabled:pointer-events-none transition-colors"
                title="Next variant"
            >
                <ChevronRight size={12} />
            </button>
        </div>
    );
}

/**
 * ContinueButton — extends the latest GM reply in place (a swipe that appends
 * instead of replaces). Mounted beside the swipe controls; same visibility
 * condition as the swipe indicator (latest GM message + pending commit).
 * Disabled while a continue, swipe, or real turn is streaming (mutual exclusion).
 */
function ContinueButton({
    loading,
    disabled,
    onClick,
}: {
    loading: boolean;
    disabled: boolean;
    onClick: () => void;
}) {
    return (
        <button
            onClick={onClick}
            disabled={disabled}
            title="Continue — extend this reply"
            className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] uppercase tracking-widest text-text-dim hover:text-ice border border-border/50 hover:border-ice/50 transition-colors disabled:opacity-30 disabled:pointer-events-none"
        >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <FastForward size={12} />}
            <span>Continue</span>
        </button>
    );
}

export function MessageBubble({
    message: msg,
    isStreaming,
    isLastMessage,
    showReasoning,
    debugMode,
    onStartEdit,
    onRegenerate,
    onDelete,
    toolResult,
    isEditing,
    inlineDraft,
    onInlineDraftChange,
    onInlineSubmit,
    onInlineCancel,
    onOpenSwipeSheet,
    onSwipeNavigate,
    onSceneContinue,
    sceneContinueLoading,
    swipeGenLoading,
    globalIsStreaming,
}: MessageBubbleProps) {
    let markdownContent: string = typeof msg.displayContent === 'string'
        ? msg.displayContent
        : (typeof msg.content === 'string' ? msg.content : '');

    let thinkingBlock = '';
    const thinkMatch = markdownContent.match(/<think([\s\S]*?)<\/think>/i);
    if (thinkMatch) {
        thinkingBlock = thinkMatch[1].trim();
        if (showReasoning === false) {
            markdownContent = markdownContent.replace(/<think[\s\S]*?<\/think>/gi, '').trim();
        } else {
            markdownContent = markdownContent.replace(/<think[\s\S]*?<\/think>/gi, '').trim();
        }
    }

    const parsedArgs = (msg as any).parsedArgs;
    const hasSummary = msg.role === 'tool' && parsedArgs && Array.isArray(parsedArgs.summary);
    const hasDebug = debugMode === true && !!msg.debugPayload;

    // WO-EDIT — autofocus + auto-grow the inline editor when this bubble enters edit mode.
    const inlineRef = useRef<HTMLTextAreaElement | null>(null);
    useEffect(() => {
        if (!isEditing) return;
        const ta = inlineRef.current;
        if (!ta) return;
        ta.focus();
        // Defer one frame so the textarea has its final width before we measure scrollHeight.
        const raf = requestAnimationFrame(() => {
            ta.style.height = 'auto';
            ta.style.height = `${Math.max(ta.scrollHeight, 160)}px`;
        });
        return () => cancelAnimationFrame(raf);
    }, [isEditing]);

    const onInlineKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onInlineSubmit?.();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            onInlineCancel?.();
        }
    };

    const onInlineChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        onInlineDraftChange?.(e.target.value);
        const ta = e.currentTarget;
        ta.style.height = 'auto';
        ta.style.height = `${Math.max(ta.scrollHeight, 160)}px`;
    };

    // ── TTS playback (Kokoro, local) — chunked + highlight-synced + controllable ──
    const ttsStatus = useTtsStatus();
    const ttsEnabled = useAppStore(s => s.settings.ttsEnabled);
    const ttsVoice = useAppStore(s => s.settings.ttsVoice);
    const [ttsLoading, setTtsLoading] = useState(false);
    const [ttsPlaying, setTtsPlaying] = useState(false);
    const [ttsPaused, setTtsPaused] = useState(false);
    const [ttsFinished, setTtsFinished] = useState(false);
    const [activeSentenceIdx, setActiveSentenceIdx] = useState(-1);
    const [activeWordIdx, setActiveWordIdx] = useState(-1);
    const [playbackRate, setPlaybackRate] = useState(1);
    const [totalChunks, setTotalChunks] = useState(0);
    const [generatedChunks, setGeneratedChunks] = useState(0);
    const [hasCache, setHasCache] = useState(false);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const chunkAbortRef = useRef<boolean>(false);
    const sentenceTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
    const wordTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
    const queueRef = useRef<{ idx: number; blob: Blob; url: string; words: string[] }[]>([]);
    // Persistent cache of generated chunks — survives stop + replay.
    // Only wiped by the trash button or component unmount.
    const cacheRef = useRef<Map<number, { blob: Blob; url: string; words: string[] }>>(new Map());
    const skipToChunkRef = useRef<number | null>(null);
    const initialSkipRef = useRef<number | null>(null);  // set before handleSpeak to start from a chunk
    const rateRef = useRef(1);
    const pauseRef = useRef(false);
    // Resolve function for the currently-playing chunk's `finished` promise.
    // stopPlayback calls this to wake up the zombie consumer so it exits cleanly.
    const finishResolveRef = useRef<(() => void) | null>(null);

    const canSpeak = msg.role === 'assistant'
        && !isEditing
        && !!ttsStatus?.modelReady
        && !!ttsEnabled
        && !!markdownContent.trim();

    const clearTimers = () => {
        for (const t of sentenceTimersRef.current) clearTimeout(t);
        for (const t of wordTimersRef.current) clearTimeout(t);
        sentenceTimersRef.current = [];
        wordTimersRef.current = [];
    };

    // Stop playback + generation, but KEEP the cache. Next press resumes from
    // chunk 0 using cached blobs, only generating chunks that don't exist yet.
    const stopPlayback = () => {
        chunkAbortRef.current = true;
        clearTimers();
        // Wake up the zombie consumer's `await finished` promise so it exits.
        const resolve = finishResolveRef.current;
        finishResolveRef.current = null;
        if (audioRef.current) {
            audioRef.current.onended = null;
            audioRef.current.onerror = null;
            audioRef.current.pause();
            audioRef.current = null;
        }
        if (resolve) resolve();
        queueRef.current = [];
        pauseRef.current = false;
        setTtsPlaying(false);
        setTtsLoading(false);
        setTtsPaused(false);
        setTtsFinished(false);
        setActiveSentenceIdx(-1);
        setActiveWordIdx(-1);
    };

    // Full wipe — only called by the trash button on the TTS panel.
    const handleWipeTts = () => {
        stopPlayback();
        for (const [, c] of cacheRef.current) URL.revokeObjectURL(c.url);
        cacheRef.current.clear();
        setGeneratedChunks(0);
        setTotalChunks(0);
        setHasCache(false);
    };

    // Pause / resume the current audio.
    const handlePauseResume = () => {
        if (!audioRef.current) return;
        if (pauseRef.current) {
            pauseRef.current = false;
            setTtsPaused(false);
            audioRef.current.play().catch(() => {});
        } else {
            pauseRef.current = true;
            setTtsPaused(true);
            audioRef.current.pause();
        }
    };

    const handleSpeak = async () => {
        // If currently playing or loading, stop (keep cache).
        if (ttsPlaying || ttsLoading) {
            stopPlayback();
            return;
        }
        const clean = proseForTTS(markdownContent);
        if (!clean) return;
        const chunks = chunkSentencesForTTS(clean);
        if (!chunks.length) return;

        // Soft reset — keep cache.
        chunkAbortRef.current = true;
        clearTimers();
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current = null;
        }
        queueRef.current = [];
        skipToChunkRef.current = null;
        pauseRef.current = false;
        chunkAbortRef.current = false;
        setTotalChunks(chunks.length);
        setTtsPaused(false);
        setTtsFinished(false);
        setActiveSentenceIdx(-1);
        setActiveWordIdx(-1);

        // If a start-from-chunk was requested (clicking a sentence while stopped),
        // seed the queue from cache at that index and set currentIdx.
        const startAt = initialSkipRef.current;
        initialSkipRef.current = null;

        const chunkWords = chunks.map(splitWords);
        const WORDS_PER_SEC = 2.5;

        let producerDone = false;

        // ── Producer: load cached blobs instantly, generate missing chunks.
        const produce = async () => {
            for (let i = 0; i < chunks.length; i++) {
                if (chunkAbortRef.current) return;
                const cached = cacheRef.current.get(i);
                if (cached) {
                    queueRef.current.push({ idx: i, ...cached });
                    setGeneratedChunks(i + 1);
                    continue;
                }
                try {
                    const blob = await generateTts(chunks[i], ttsVoice);
                    if (chunkAbortRef.current) return;
                    const entry = { blob, url: URL.createObjectURL(blob), words: chunkWords[i] };
                    cacheRef.current.set(i, entry);
                    queueRef.current.push({ idx: i, ...entry });
                    setGeneratedChunks(i + 1);
                    setHasCache(true);
                } catch {
                    producerDone = true;
                    return;
                }
            }
            producerDone = true;
        };

        // If everything is cached, skip the loading spinner.
        const allCached = cacheRef.current.size >= chunks.length;
        if (allCached) {
            setGeneratedChunks(chunks.length);
            setTtsPlaying(true);
        } else {
            setTtsLoading(true);
        }

        produce();

        // Wait for the first chunk if not fully cached.
        if (!allCached) {
            while (!chunkAbortRef.current && queueRef.current.length === 0 && !producerDone) {
                await new Promise(r => setTimeout(r, 50));
            }
            if (chunkAbortRef.current) return;
            setTtsLoading(false);
            setTtsPlaying(true);
        }

        // ── Consumer — plays chunks in order, respects skip + pause.
        let currentIdx = startAt ?? 0;
        // If starting from a specific chunk, seed the queue from cache.
        if (startAt !== null && startAt > 0) {
            for (let ci = startAt; ci < chunks.length; ci++) {
                const cached = cacheRef.current.get(ci);
                if (cached) queueRef.current.push({ idx: ci, ...cached });
            }
        }
        while (!chunkAbortRef.current) {
            // Check for a chunk-skip request (click a sentence).
            if (skipToChunkRef.current !== null) {
                const target = skipToChunkRef.current;
                skipToChunkRef.current = null;
                clearTimers();
                // Rebuild the queue from cache starting at the target chunk.
                // If the target isn't cached yet, the producer will generate it.
                queueRef.current = [];
                for (let ci = target; ci < chunks.length; ci++) {
                    const cached = cacheRef.current.get(ci);
                    if (cached) {
                        queueRef.current.push({ idx: ci, ...cached });
                    }
                }
                currentIdx = target;
                // If the target chunk isn't generated yet, wait for the producer.
                while (!chunkAbortRef.current && queueRef.current.length === 0 && !producerDone) {
                    await new Promise(r => setTimeout(r, 50));
                }
                if (chunkAbortRef.current) return;
                if (queueRef.current.length === 0 && producerDone) break;
            }

            if (queueRef.current.length === 0) {
                if (producerDone) break;
                await new Promise(r => setTimeout(r, 50));
                continue;
            }

            // Find the chunk matching currentIdx.
            let item = queueRef.current.shift();
            while (item && item.idx < currentIdx) {
                item = queueRef.current.shift();
            }
            if (!item) continue;
            if (item.idx > currentIdx) {
                queueRef.current.unshift(item);
                currentIdx = item.idx;
            }

            const audio = new Audio(item.url);
            audioRef.current = audio;
            audio.playbackRate = rateRef.current;
            setActiveSentenceIdx(item.idx);
            setActiveWordIdx(0);

            // Word highlight schedule.
            const scheduleWords = () => {
                clearTimers();
                const dur = audio.duration && isFinite(audio.duration) ? audio.duration : (item!.words.length / WORDS_PER_SEC);
                const perWord = dur / Math.max(item!.words.length, 1);
                item!.words.forEach((_w, wi) => {
                    const t = setTimeout(() => {
                        if (!chunkAbortRef.current && skipToChunkRef.current === null) setActiveWordIdx(wi);
                    }, wi * perWord * 1000);
                    wordTimersRef.current.push(t);
                });
            };
            audio.onloadedmetadata = () => {
                if (chunkAbortRef.current) return;
                scheduleWords();
            };

            const finished = new Promise<void>(resolve => {
                finishResolveRef.current = resolve;
                audio.onended = () => { finishResolveRef.current = null; resolve(); };
                audio.onerror = () => { finishResolveRef.current = null; resolve(); };
            });

            // Signal promise — resolves when a skip or stop is requested during playback.
            // This lets us race `finished` against user intervention instead of blocking.
            const interrupted = new Promise<boolean>(resolve => {
                const checker = setInterval(() => {
                    if (chunkAbortRef.current || skipToChunkRef.current !== null) {
                        clearInterval(checker);
                        resolve(true);
                    }
                }, 50);
                // Clean up the checker if finished wins the race.
                finished.then(() => clearInterval(checker));
            });

            try {
                await audio.play();
            } catch {
                stopPlayback();
                return;
            }

            const wasInterrupted = await Promise.race([finished.then(() => false), interrupted]);
            // Clean up audio whether we finished naturally or were interrupted.
            if (audioRef.current) {
                (audioRef.current as HTMLAudioElement).onended = null;
                (audioRef.current as HTMLAudioElement).onerror = null;
                (audioRef.current as HTMLAudioElement).pause();
            }
            audioRef.current = null;
            finishResolveRef.current = null;
            if (chunkAbortRef.current) return;
            if (wasInterrupted) {
                // A skip was requested — loop back to the top to process it.
                continue;
            }

            currentIdx = item.idx + 1;
        }

        // Finished all chunks — keep the panel visible for replay.
        if (!chunkAbortRef.current) {
            setTtsPlaying(false);
            setTtsFinished(true);
            setActiveSentenceIdx(-1);
            setActiveWordIdx(-1);
        }
    };

    // ── Playback controls ──
    const handleSpeedChange = (delta: number) => {
        const newRate = Math.min(2, Math.max(0.5, Math.round((rateRef.current + delta) * 10) / 10));
        rateRef.current = newRate;
        setPlaybackRate(newRate);
        if (audioRef.current) audioRef.current.playbackRate = newRate;
    };

    // Cleanup on unmount
    useEffect(() => {
        const queue = queueRef.current;
        const cache = cacheRef.current;
        return () => {
            chunkAbortRef.current = true;
            clearTimers();
            if (audioRef.current) (audioRef.current as HTMLAudioElement).pause();
            for (const item of queue) URL.revokeObjectURL(item.url);
            for (const [, c] of cache) URL.revokeObjectURL(c.url);
            cache.clear();
        };
    }, []);

    // ── Preload disk-cached chunks on mount ──
    // If this GM message was read before (audio generated + saved to disk by the
    // server), load all cached chunks into cacheRef so the speaker button works
    // instantly with no Kokoro calls. This survives server restarts + campaign switches.
    useEffect(() => {
        if (!ttsEnabled || msg.role !== 'assistant') return;
        let cancelled = false;
        const clean = proseForTTS(markdownContent);
        if (!clean) return;
        const chunks = chunkSentencesForTTS(clean);
        if (!chunks.length) return;

        (async () => {
            try {
                const cachedFlags = await checkCachedChunks(chunks, ttsVoice);
                if (cancelled) return;
                const cachedCount = cachedFlags.filter(Boolean).length;
                if (cachedCount === 0) return;

                // Load all cached WAVs from disk in parallel.
                const loadPromises = chunks.map(async (text, i) => {
                    if (!cachedFlags[i]) return null;
                    const blob = await loadCachedTts(text, ttsVoice);
                    if (!blob || cancelled) return null;
                    return { idx: i, blob };
                });
                const results = await Promise.all(loadPromises);
                if (cancelled) return;

                let loaded = 0;
                for (const r of results) {
                    if (!r) continue;
                    const words = splitWords(chunks[r.idx]);
                    const url = URL.createObjectURL(r.blob);
                    cacheRef.current.set(r.idx, { blob: r.blob, url, words });
                    loaded++;
                }
                if (loaded > 0 && !cancelled) {
                    setHasCache(true);
                    setTotalChunks(chunks.length);
                    setGeneratedChunks(loaded);
                }
            } catch {
                // best-effort — if the server is down or TTS isn't ready, silently skip.
            }
        })();

        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ttsEnabled, ttsVoice, msg.id]);

    const isUser = msg.role === 'user';

    // ── Swipe Generation v1: touch-swipe gesture handling ──
    // Only the latest GM message (with a swipe set) responds to horizontal
    // swipes. A swipe left → next variant, right → previous. The threshold
    // is generous so a normal vertical scroll never triggers a swipe.
    const touchStartX = useRef<number | null>(null);
    const touchStartY = useRef<number | null>(null);
    const SWIPE_THRESHOLD = 50;  // px horizontal travel before it counts as a swipe

    const handleTouchStart = (e: React.TouchEvent) => {
        if (!hasSwipeSet(msg)) return;
        const t = e.touches[0];
        touchStartX.current = t.clientX;
        touchStartY.current = t.clientY;
    };

    const handleTouchEnd = (e: React.TouchEvent) => {
        if (!hasSwipeSet(msg) || touchStartX.current === null || touchStartY.current === null) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - touchStartX.current;
        const dy = t.clientY - touchStartY.current;
        touchStartX.current = null;
        touchStartY.current = null;
        // Only trigger on predominantly horizontal swipes
        if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dy) > Math.abs(dx)) return;
        if (dx < 0) {
            onSwipeNavigate?.(msg.id, 'next');
        } else {
            onSwipeNavigate?.(msg.id, 'prev');
        }
    };

    // ── NPC hover thumbnail lookup (ledger-side, no prop threading needed) ──
    const npcLedger = useAppStore(s => s.npcLedger);
    const npcLookup = useMemo(() => buildNpcLookup(npcLedger), [npcLedger]);
    const renderMarkdown = (raw: string) => {
        let out = inlineNameBrackets(raw);
        if (npcLookup) out = wrapNpcNames(out, npcLookup);
        return out;
    };

    // react-markdown custom `a` renderer: sentinel-href NPC links become hover chips.
    const mdComponents = useMemo(() => ({
        a: ({ href, children }: { href?: string; children?: ReactNode }) => {
            if (!href || !href.startsWith('#npc-p-')) {
                // Default anchor rendering for real links.
                return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
            }
            const id = href.slice('#npc-p-'.length);
            const npc = npcLookup?.idToNpc.get(id);
            if (!npc) return <>{children}</>;
            return <NpcNameChip name={npc.name} portrait={npc.portrait}>{children}</NpcNameChip>;
        },
    }), [npcLookup]);

    const actionRail = (
        <div className="flex flex-col gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity bg-void-darker border border-border p-1 rounded-md self-start sticky top-1/2 -translate-y-1/2 z-10">
            {isEditing ? (
                <>
                    <button title="Save edit (Enter)" onClick={() => onInlineSubmit?.()} className="text-terminal hover:text-terminal p-1.5 bg-void-lighter rounded">
                        <Check size={14} />
                    </button>
                    <button title="Cancel (Esc)" onClick={() => onInlineCancel?.()} className="text-text-dim hover:text-red-400 p-1.5 bg-void-lighter rounded">
                        <X size={14} />
                    </button>
                </>
            ) : (
                <>
                    {msg.role !== 'system' && (
                        <button title="Edit" onClick={() => onStartEdit(msg)} className="text-text-dim hover:text-terminal p-1.5 bg-void-lighter rounded">
                            <Edit2 size={14} />
                        </button>
                    )}
                    {msg.role === 'assistant' && hasSwipeSet(msg) && onOpenSwipeSheet && (
                        <button
                            title="Browse variants (swipe)"
                            onClick={() => onOpenSwipeSheet(msg.id)}
                            className="text-text-dim hover:text-terminal p-1.5 bg-void-lighter rounded"
                        >
                            <RefreshCw size={14} />
                        </button>
                    )}
                    {msg.role === 'assistant' && !hasSwipeSet(msg) && (
                        <button
                            title="Rewind to here (destructive — regenerates from this point)"
                            onClick={() => {
                                if (window.confirm('Rewind to this message? This regenerates the turn from here — the current GM reply and everything after it is discarded.')) {
                                    onRegenerate(msg.id);
                                }
                            }}
                            className="text-text-dim hover:text-amber-400 p-1.5 bg-void-lighter rounded"
                        >
                            <Rewind size={14} />
                        </button>
                    )}
                    {canSpeak && (
                        <button
                            title={ttsPlaying ? 'Stop' : ttsFinished ? 'Replay' : 'Read aloud'}
                            onClick={handleSpeak}
                            className={`p-1.5 bg-void-lighter rounded ${ttsPlaying ? 'text-terminal' : 'text-text-dim hover:text-terminal'}`}
                        >
                            {ttsLoading ? <Loader2 size={14} className="animate-spin" /> : ttsPlaying ? <Square size={14} /> : ttsFinished ? <RotateCw size={14} /> : <Volume2 size={14} />}
                        </button>
                    )}
                    {canSpeak && ttsPlaying && (
                        <button
                            title={ttsPaused ? 'Resume' : 'Pause'}
                            onClick={handlePauseResume}
                            className="p-1.5 bg-void-lighter rounded text-text-dim hover:text-terminal"
                        >
                            {ttsPaused ? <Play size={14} /> : <Pause size={14} />}
                        </button>
                    )}
                    <button title="Delete" onClick={() => onDelete(msg.id)} className="text-text-dim hover:text-red-400 p-1.5 bg-void-lighter rounded">
                        <Trash2 size={14} />
                    </button>
                </>
            )}
        </div>
    );

    return (
        <div
            key={msg.id}
            className={`group flex items-start gap-2 animate-[msg-in_0.2s_ease-out] ${isEditing ? 'w-full' : isUser ? 'justify-end' : 'justify-start'}`}
        >
            {isUser && !isEditing && actionRail}
            <div
                {...(msg.role === 'assistant' ? { 'data-lore-checkable': 'true', 'data-message-id': msg.id } : {})}
                onTouchStart={handleTouchStart}
                onTouchEnd={handleTouchEnd}
                className={`chat-bubble-base ${isEditing ? 'w-full max-w-full' : 'max-w-[95%] md:max-w-[75%]'} px-3 md:px-4 py-2 md:py-3 text-sm font-mono leading-relaxed relative ${isUser
                    ? 'bg-terminal/8 border-l-2 border-terminal text-text-primary'
                    : msg.role === 'system'
                        ? 'bg-ember/8 border-l-2 border-ember text-ember/80'
                        : 'chat-bubble bg-void-lighter border-l-2 border-border text-text-primary'
                    }`}
            >
                <div className="flex items-center gap-2 mb-1">
                    <span
                        className={`text-[10px] uppercase tracking-widest ${msg.role === 'user'
                            ? 'text-terminal'
                            : msg.role === 'system'
                                ? 'text-ember'
                                : 'text-ice'
                            }`}
                    >
                        {msg.role === 'user' ? '► YOU' : msg.role === 'tool' ? '◈ TOOL' : msg.role === 'system' ? '◆ SYS' : '◇ GM'}
                    </span>
                    {msg.role === 'tool' && msg.name && (
                        <span className="text-[9px] text-terminal font-bold tracking-wider opacity-80">
                            [{msg.name}]
                        </span>
                    )}
                    <span className="text-[9px] text-text-dim">
                        {new Date(msg.timestamp).toLocaleTimeString()}
                    </span>
                </div>

                <div className="gm-prose">
                    {msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0 && (
                        <ToolCallChips toolCalls={msg.tool_calls} toolResult={toolResult} />
                    )}
                    {thinkingBlock && showReasoning && (
                        <details className="mb-3 bg-void-darker border border-terminal/20 rounded overflow-hidden">
                            <summary className="cursor-pointer p-2 text-[10px] text-terminal/60 hover:text-terminal transition-colors select-none uppercase tracking-widest flex items-center gap-2 bg-terminal/5">
                                <Loader2 size={10} className={isStreaming && isLastMessage ? "animate-spin" : ""} />
                                Cognitive Process
                            </summary>
                            <div className="p-3 text-[11px] text-text-dim/80 italic border-t border-terminal/10 max-h-[300px] overflow-y-auto whitespace-pre-wrap leading-relaxed">
                                {thinkingBlock}
                            </div>
                        </details>
                    )}
                    {isEditing ? (
                        <div className="w-full">
                            <div className="sticky top-2 flex justify-end gap-1 z-20 mb-1">
                                <button title="Save edit (Enter)" onClick={() => onInlineSubmit?.()} className="text-terminal hover:text-terminal p-1.5 bg-void-darker rounded border border-border">
                                    <Check size={14} />
                                </button>
                                <button title="Cancel (Esc)" onClick={() => onInlineCancel?.()} className="text-text-dim hover:text-red-400 p-1.5 bg-void-darker rounded border border-border">
                                    <X size={14} />
                                </button>
                            </div>
                            <textarea
                                ref={inlineRef}
                                value={inlineDraft}
                                onChange={onInlineChange}
                                onKeyDown={onInlineKeyDown}
                                className="w-full bg-void-darker border border-terminal/40 text-text-primary font-mono text-sm p-2 rounded resize-none outline-none focus:border-terminal min-h-[160px] leading-relaxed"
                                placeholder="Edit message..."
                            />
                        </div>
                    ) : (
                        <>
                            {(ttsPlaying || ttsLoading || ttsFinished || hasCache) && (
                                <div className="mb-3 rounded border border-terminal/30 bg-terminal/5 max-h-[160px] overflow-y-auto relative">
                                    {/* Sticky header — status + controls, always visible while scrolling */}
                                    <div className="sticky top-0 z-10 bg-void-darker/95 backdrop-blur-sm border-b border-terminal/20 px-2 py-1 flex items-center gap-1 justify-between flex-wrap">
                                        <span className="flex items-center gap-1.5 text-[9px] text-terminal/60 uppercase tracking-widest shrink-0">
                                            {ttsLoading ? <Loader2 size={10} className="animate-spin" /> : ttsFinished ? <RotateCw size={10} /> : ttsPaused ? <Pause size={10} /> : <Volume2 size={10} />}
                                            {ttsLoading ? 'Synthesizing' : ttsFinished ? 'Finished' : ttsPaused ? 'Paused' : 'Reading'}
                                        </span>
                                        {totalChunks > 0 && (
                                            <span className="text-[9px] text-text-dim/60 normal-case tracking-normal shrink-0 mr-1 flex items-center gap-1.5">
                                                <span title="Playback position">
                                                    ▶ {ttsFinished ? totalChunks : (activeSentenceIdx >= 0 ? activeSentenceIdx + 1 : 0)}/{totalChunks}
                                                </span>
                                                {generatedChunks < totalChunks && (
                                                    <span title="Kokoro generation progress" className="text-terminal/70 flex items-center gap-0.5">
                                                        <Loader2 size={8} className="animate-spin" /> gen {generatedChunks}/{totalChunks}
                                                    </span>
                                                )}
                                                {generatedChunks >= totalChunks && !ttsFinished && (
                                                    <span className="text-terminal/50">all buffered</span>
                                                )}
                                            </span>
                                        )}
                                        {/* Controls inline in the header */}
                                        <div className="flex items-center gap-1 ml-auto">
                                            {ttsPlaying && (
                                                <button title={ttsPaused ? 'Resume' : 'Pause'} onClick={handlePauseResume} className="text-text-dim hover:text-terminal px-1 py-0.5 rounded flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider">
                                                    {ttsPaused ? <><Play size={10} /> Resume</> : <><Pause size={10} /> Pause</>}
                                                </button>
                                            )}
                                            <span className="text-[8px] text-text-dim/50 normal-case tracking-normal hidden lg:inline">click a sentence to jump</span>
                                            <div className="w-px h-4 bg-border/40 mx-0.5" />
                                            <button title="Slower" onClick={() => handleSpeedChange(-0.25)} className="text-text-dim hover:text-terminal px-1 py-0.5 rounded text-[9px] font-bold">
                                                ½×
                                            </button>
                                            <span className="text-[9px] text-text-dim font-mono w-9 text-center">{playbackRate.toFixed(2)}×</span>
                                            <button title="Faster" onClick={() => handleSpeedChange(0.25)} className="text-text-dim hover:text-terminal px-1 py-0.5 rounded text-[9px] font-bold">
                                                2×
                                            </button>
                                            {ttsFinished && (
                                                <>
                                                    <div className="w-px h-4 bg-border/40 mx-0.5" />
                                                    <button title="Replay" onClick={handleSpeak} className="text-terminal hover:text-terminal px-1 py-0.5 rounded flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider">
                                                        <Play size={10} /> Replay
                                                    </button>
                                                </>
                                            )}
                                            {/* Trash — only thing that wipes the cache */}
                                            <div className="w-px h-4 bg-border/40 mx-0.5" />
                                            <button title="Delete generated audio" onClick={handleWipeTts} className="text-text-dim hover:text-red-400 px-1 py-0.5 rounded flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider">
                                                <Trash2 size={10} />
                                            </button>
                                        </div>
                                    </div>
                                    {/* Karaoke text scrolls under the frozen header */}
                                    <div className="px-2 py-1.5">
                                        <KaraokeText
                                            prose={proseForTTS(markdownContent)}
                                            sentenceIdx={activeSentenceIdx}
                                            wordIdx={activeWordIdx}
                                            finished={ttsFinished}
                                            generatedChunks={generatedChunks}
                                            onSentenceClick={(si) => {
                                                if (ttsPlaying || ttsLoading) {
                                                    skipToChunkRef.current = si;
                                                } else {
                                                    // Not currently playing — start from this chunk.
                                                    initialSkipRef.current = si;
                                                    handleSpeak();
                                                }
                                            }}
                                        />
                                    </div>
                                </div>
                            )}
                            <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{renderMarkdown(markdownContent)}</ReactMarkdown>
                        </>
                    )}
                    {hasSummary && (
                        <div className="mt-2 pl-3 border-l-2 border-terminal/30 text-[10px] text-text-dim">
                            <div className="uppercase tracking-widest text-terminal/60 mb-1">Generated Output:</div>
                            <ul className="list-disc leading-tight space-y-1">
                                {(parsedArgs.summary as any[]).map((s: any, i: number) => (
                                    <li key={i}>{typeof s === 'string' ? s : String(s)}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>

                {hasSwipeSet(msg) && (
                    <div className="mt-2 flex items-center justify-center gap-3 select-none">
                        <SwipeIndicator
                            msg={msg}
                            onPrev={() => onSwipeNavigate?.(msg.id, 'prev')}
                            onNext={() => onSwipeNavigate?.(msg.id, 'next')}
                        />
                        <ContinueButton
                            loading={!!sceneContinueLoading}
                            disabled={
                                !!sceneContinueLoading ||
                                !!swipeGenLoading ||
                                !!globalIsStreaming ||
                                msg.swipeSet?.[msg.swipeActiveIndex ?? 0]?.streaming === true
                            }
                            onClick={() => onSceneContinue?.(msg.id)}
                        />
                    </div>
                )}

                {hasDebug && (
                    <DebugPayloadView debugPayload={msg.debugPayload as { sections?: DebugSection[]; raw?: unknown }} />
                )}
            </div>
            {!isUser && !isEditing && actionRail}
        </div>
    );
}

/**
 * Karaoke-style prose renderer for TTS highlight sync.
 * Each sentence is clickable (jumps playback to that chunk). Generated chunks
 * are normal text; ungenerated chunks are dimmed + italicized. The active word
 * in the active sentence is highlighted. Past sentences are dimmed.
 */
function KaraokeText({
    prose,
    sentenceIdx,
    wordIdx,
    finished,
    generatedChunks = 0,
    onSentenceClick,
}: {
    prose: string;
    sentenceIdx: number;
    wordIdx: number;
    finished?: boolean;
    generatedChunks?: number;
    onSentenceClick?: (sentenceIndex: number) => void;
}) {
    const sentences = chunkSentencesForTTS(prose);
    const isInteractive = !!onSentenceClick && (sentenceIdx >= 0 || finished);
    return (
        <div className={`text-[11px] leading-relaxed ${finished ? 'text-text-dim/50' : 'text-text-primary'}`}>
            {sentences.map((sent, si) => {
                const words = splitWords(sent);
                const isPast = sentenceIdx >= 0 && si < sentenceIdx;
                const isActive = si === sentenceIdx && !finished;
                const isGenerated = si < generatedChunks || finished;
                const canClick = isInteractive && isGenerated;
                return (
                    <span
                        key={si}
                        onClick={canClick ? () => onSentenceClick!(si) : undefined}
                        className={[
                            isPast || finished ? 'text-text-dim/40' : '',
                            !isGenerated ? 'text-text-dim/30 italic' : '',
                            canClick ? 'cursor-pointer hover:bg-terminal/20 hover:text-terminal rounded px-0.5 transition-colors' : '',
                        ].join(' ')}
                    >
                        {words.map((w, wi) => (
                            <span
                                key={wi}
                                className={
                                    isActive && wi === wordIdx
                                        ? 'bg-terminal/30 text-terminal font-bold rounded px-[1px]'
                                        : isActive
                                            ? 'text-text-primary'
                                            : ''
                                }
                            >
                                {w}{' '}
                            </span>
                        ))}
                        {' '}
                    </span>
                );
            })}
        </div>
    );
}

/**
 * Inline NPC-name chip that shows a reduced portrait thumbnail on hover.
 * Renders as bold-styled text (matching the bracket→**bold** display transform);
 * hovering reveals a small 96px portrait card. Purely display — the name stays
 * in the document flow and is selectable.
 */
function NpcNameChip({ name, portrait, children }: { name: string; portrait: string; children: ReactNode }) {
    return (
        <span className="relative inline-block group/npc text-terminal font-bold cursor-help">
            {children}
            <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-1 z-50 opacity-0 group-hover/npc:opacity-100 transition-opacity duration-150">
                <span className="block bg-void-darker border border-terminal/40 rounded shadow-lg p-1 w-[96px]">
                    <img
                        src={portrait}
                        alt={name}
                        className="w-full aspect-[3/4] object-cover object-top rounded"
                        loading="lazy"
                        draggable={false}
                    />
                    <span className="block text-[9px] text-center text-text-dim uppercase tracking-wider truncate mt-0.5">{name}</span>
                </span>
            </span>
        </span>
    );
}
