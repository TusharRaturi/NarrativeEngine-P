import type { NPCEntry, CharacterIdentity, SceneSteer, WitnessSource } from '../../types';

// Shared style + single-subject negative. These were previously duplicated across
// index.ts (scene) and portrait.ts (NPC portrait); unifying them here is what keeps
// a character's solo portrait and their in-scene render visually consistent.
export const DEFAULT_STYLE = 'fantasy illustration, cinematic lighting, detailed, no text, no watermark, no UI, no speech bubbles';
export const PORTRAIT_NEGATIVE = 'multiple people, group, crowd, split screen, twins, double, text, watermark, signature';

const CHIP_RE = /\[[\s\S]*?\]/g;
const THINK_OPEN = /<think/gi;
const MAX_PROMPT_LEN = 1000;

// Focal subjects get a full "Name: look" clause. Beyond this they're demoted to an
// "others present" mention with no per-attribute description (limits attribute bleed,
// which is how SD-class models smear one character's traits onto another).
const MAX_FOCAL = 2;

const FRAMING_CLAUSE: Record<NonNullable<SceneSteer['framing']>, string> = {
    wide: 'wide establishing shot',
    medium: 'medium shot',
    close: 'close-up shot',
    portrait: 'portrait, head and shoulders',
};

export type ComposeInput = {
    /** Assistant scene prose (scene mode). Ignored in portrait mode. */
    sceneText?: string;
    /** Set => single-subject portrait mode; presence resolution is skipped. */
    portraitNpcId?: string;
    npcLedger: NPCEntry[];
    /** PC look source (context.characterProfile.identity). */
    pc?: CharacterIdentity;
    /** Live "who is on stage" from the engine (npcSlice). Primary presence signal. */
    onStageNpcIds?: string[];
    /** Per-scene witness IDs, if ever available on the message. Outranks onStage. */
    witnessedNpcIds?: string[];
    witnessSource?: WitnessSource;
    stylePrompt?: string;
    negativePrompt?: string;
    /** Steering inputs from the Scene Image modal (WO-03). */
    steer?: SceneSteer;
};

export type ComposedPrompt = {
    prompt: string;
    negativePrompt?: string;
    /** Only set when the image is single-subject; multi-subject scenes share one
     *  canvas seed, so a per-character seed is meaningless and is omitted. */
    seed?: number;
    subjectCount: number;
};

function stripMarkup(text: string): string {
    let cleaned = text.replace(THINK_OPEN, '').replace(/<\/think>/gi, '').trim();
    cleaned = cleaned.replace(CHIP_RE, '').trim();
    cleaned = cleaned.replace(/[*_~`#>]/g, '').trim();
    cleaned = cleaned.replace(/\n{2,}/g, '\n').trim();
    return cleaned;
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word-boundary match — mirrors arcStance/scanPressure. Replaces the old bare
// `text.includes(name)` so "Ed" no longer matches "edge", "Mara" not "nightmare".
function nameInText(name: string, lowerText: string): boolean {
    const n = name.trim().toLowerCase();
    if (n.length < 2) return false;
    return new RegExp(`\\b${escapeRegExp(n)}\\b`).test(lowerText);
}

function npcLook(npc: NPCEntry): string | undefined {
    return npc.appearanceTags?.trim() || npc.appearance?.trim() || undefined;
}

function dedupeById(npcs: NPCEntry[]): NPCEntry[] {
    const seen = new Set<string>();
    const out: NPCEntry[] = [];
    for (const n of npcs) {
        if (!n || seen.has(n.id)) continue;
        seen.add(n.id);
        out.push(n);
    }
    return out;
}

// Rank candidates so the cap keeps the most scene-relevant subjects: explicit
// recurring cast and characters actually named this beat outrank walk-ons.
function rankSalience(npcs: NPCEntry[], lowerScene: string): NPCEntry[] {
    const score = (n: NPCEntry): number => {
        let s = 0;
        if (n.tier === 'recurring') s += 100;
        else if (n.tier === 'oneshot') s += 20;
        if (lowerScene && nameInText(n.name, lowerScene)) s += 50;
        s += Math.max(0, Math.min(100, n.affinity ?? 0)) / 100; // sub-1 tiebreak
        return s;
    };
    return [...npcs].sort((a, b) => score(b) - score(a));
}

function defaultPov(focusPc: boolean): 'pc_pov' | 'pc_visible' {
    // First-person RP films from the PC's eyes by default — injecting the PC look
    // unconditionally produces a selfie every scene. Only show the PC when the user
    // explicitly focuses on them.
    return focusPc ? 'pc_visible' : 'pc_pov';
}

function composeNegative(userNeg: string | undefined, singleSubject: boolean): string | undefined {
    const parts: string[] = [];
    if (singleSubject) parts.push(PORTRAIT_NEGATIVE);
    if (userNeg?.trim()) parts.push(userNeg.trim());
    return parts.length ? parts.join(', ') : undefined;
}

function joinParts(parts: (string | undefined)[]): string {
    return parts.map(p => p?.trim()).filter(Boolean).join('. ');
}

export function composeImagePrompt(input: ComposeInput): ComposedPrompt {
    const style = input.stylePrompt?.trim() || DEFAULT_STYLE;
    const ledger = input.npcLedger ?? [];
    const byId = new Map(ledger.map(n => [n.id, n]));
    const resolveIds = (ids?: string[]): NPCEntry[] =>
        dedupeById((ids ?? []).map(id => byId.get(id)).filter((n): n is NPCEntry => !!n));

    // ── Portrait mode: one NPC, presence resolution skipped ──
    if (input.portraitNpcId) {
        const npc = byId.get(input.portraitNpcId);
        const look = npc ? npcLook(npc) : undefined;
        const prompt = joinParts([style, npc ? `portrait of ${npc.name}` : 'portrait', look])
            .slice(0, MAX_PROMPT_LEN);
        return {
            prompt,
            negativePrompt: composeNegative(input.negativePrompt, true),
            seed: npc?.portraitSeed,
            subjectCount: 1,
        };
    }

    // ── Scene mode ──
    const scene = stripMarkup(input.sceneText ?? '');
    const lowerScene = scene.toLowerCase();
    const steer = input.steer;

    // Presence priority: explicit focus → per-scene witnesses → live on-stage →
    // word-boundary name match in the scene text (fallback for old messages).
    let present: NPCEntry[];
    if (steer?.focusNpcIds?.length) {
        present = resolveIds(steer.focusNpcIds);
    } else if (input.witnessedNpcIds?.length && input.witnessSource !== 'empty') {
        present = resolveIds(input.witnessedNpcIds);
    } else if (input.onStageNpcIds?.length) {
        present = resolveIds(input.onStageNpcIds);
    } else {
        present = ledger.filter(n => nameInText(n.name, lowerScene));
    }

    const ranked = rankSalience(present, lowerScene);
    const focal = ranked.slice(0, MAX_FOCAL);
    const others = ranked.slice(MAX_FOCAL);

    // PC injection: only when in frame (POV trap §2c).
    const pcLook = input.pc?.appearance?.trim();
    const focusPc = !!steer?.focusPc;
    const pov = steer?.pov ?? defaultPov(focusPc);
    const includePc = !!pcLook && (focusPc || pov === 'pc_visible');

    const subjectCount = focal.length + (includePc ? 1 : 0);
    const singleSubject = subjectCount <= 1;

    // Single-subject seed: prefer the lone focal NPC, else the PC if they're it.
    let seed: number | undefined;
    if (singleSubject) {
        if (focal.length === 1 && !includePc) seed = focal[0].portraitSeed;
        else if (focal.length === 0 && includePc) seed = input.pc?.portraitSeed;
    }
    const negativePrompt = composeNegative(input.negativePrompt, singleSubject);

    // Hand-edited prompt wins wholesale (still gets negative + seed handling).
    if (steer?.promptOverride?.trim()) {
        return {
            prompt: steer.promptOverride.trim().slice(0, MAX_PROMPT_LEN),
            negativePrompt,
            seed,
            subjectCount,
        };
    }

    const framingClause = steer?.framing ? FRAMING_CLAUSE[steer.framing] : undefined;
    const pcClause = includePc ? pcLook : undefined;
    const focalClauses = focal.map(n => {
        const look = npcLook(n);
        return look ? `${n.name}: ${look}` : n.name;
    });
    const othersClause = others.length ? `others present: ${others.map(n => n.name).join(', ')}` : undefined;
    const note = steer?.note?.trim() || undefined;

    // Subjects + style + note are protected; only the scene-action layer is truncated
    // to fit. (The old builder sliced the whole concatenation, which could cut a
    // subject description off the front.)
    const head = joinParts([style, framingClause, pcClause, ...focalClauses, othersClause]);
    const sep = '. ';
    const reserved = head.length
        + (note ? note.length + sep.length : 0)
        + (scene ? sep.length : 0);
    let sceneOut = scene;
    const sceneBudget = MAX_PROMPT_LEN - reserved;
    if (scene && scene.length > sceneBudget) {
        sceneOut = sceneBudget > 1 ? scene.slice(0, sceneBudget - 1) + '…' : '';
    }

    const prompt = joinParts([head, sceneOut, note]).slice(0, MAX_PROMPT_LEN);
    return { prompt, negativePrompt, seed, subjectCount };
}
