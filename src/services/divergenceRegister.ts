import type { EndpointConfig, DivergenceEntry, DivergenceRegister, DivergenceCategory, ArchiveIndexEntry, ChatMessage } from '../types';
import { callLLM } from './callLLM';
import { uid } from '../utils/uid';
import { countTokens } from './tokenizer';
import { extractJson } from './payloadBuilder';
import { stripThinkTags } from '../utils/stripThink';

export const IMPORTANCE_GATE = 7;

export const EMPTY_REGISTER: DivergenceRegister = {
    entries: [],
    lastUpdatedSceneId: '',
    lastUpdatedAt: 0,
    version: 1,
};

const VALID_CATEGORIES: ReadonlySet<DivergenceCategory> = new Set([
    'canon_override', 'world_change', 'entity_state', 'player_state', 'obligation',
]);

const BULLET_RE = /^\s*-?\s*\[\s*([^|\]]+?)\s*\|\s*([^|\]]+?)\s*\|\s*scene\s*:\s*([^|\]]+?)\s*(?:\|\s*supersedes\s*:\s*([^|\]]+?)\s*)?\]\s*(.+?)\s*$/i;
const BULLET_RE_LOOSE = /^\s*-?\s*([a-z_]+)\s*\|\s*([^|]+?)\s*\|\s*scene\s*:\s*([^|]+?)\s*(?:\|\s*supersedes\s*:\s*([^|]+?)\s*)?\|\s*(.+?)\s*$/i;

export function stripReasoning(raw: string): string {
    return stripThinkTags(raw);
}

type ParsedBullet = {
    category: DivergenceCategory;
    subject: string;
    divergence: string;
    sceneRef: string;
    supersedes?: string;
    parseError?: boolean;
};

export function parseBulletDivergences(raw: string, validSceneIds: string[]): ParsedBullet[] {
    const cleaned = stripReasoning(raw);
    const fallbackScene = validSceneIds[0] ?? '000';
    const sceneSet = new Set(validSceneIds);
    const out: ParsedBullet[] = [];

    for (const rawLine of cleaned.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        if (/^none$/i.test(line)) continue;
        if (/^\s*importance\s*:\s*\d+\s*$/i.test(line)) continue;
        if (/^(here|the|note|output|entries|new|existing)\b/i.test(line) && !line.includes('[') && !line.includes('|')) continue;

        const m = line.match(BULLET_RE) ?? line.match(BULLET_RE_LOOSE);
        if (!m) {
            out.push({
                category: 'entity_state',
                subject: '(unparsed)',
                divergence: line,
                sceneRef: fallbackScene,
                parseError: true,
            });
            continue;
        }
        const [, catRaw, subjectRaw, sceneRaw, supersedesRaw, divergenceRaw] = m;
        const catNorm = catRaw.toLowerCase().replace(/\s+/g, '_') as DivergenceCategory;
        const category: DivergenceCategory = VALID_CATEGORIES.has(catNorm) ? catNorm : 'entity_state';
        const sceneRef = sceneSet.has(sceneRaw) ? sceneRaw : fallbackScene;
        out.push({
            category,
            subject: subjectRaw,
            divergence: divergenceRaw,
            sceneRef,
            supersedes: supersedesRaw || undefined,
        });
    }

    return out;
}

function buildExtractionPrompt(
    sceneText: string,
    sceneId: string,
    currentRegister: DivergenceRegister,
    multiScene?: boolean
): string {
    const registerLines = currentRegister.entries.length > 0
        ? currentRegister.entries.map(e =>
            `${e.id} [Scene #${e.sceneRef}, imp:${e.importance}] ${e.category} — ${e.subject}: ${e.divergence}`
        ).join('\n')
        : '(empty)';
    const registerTokens = countTokens(registerLines);

    const sceneNote = multiScene
        ? 'The scene text below contains messages from multiple scenes, marked with [Scene #XX] headers. Use the matching scene number for each fact.'
        : `Use scene:${sceneId} for every fact unless the text explicitly attributes it to a different scene number.`;

    return `EXISTING REGISTER (${registerTokens} tokens) — facts already captured. Do NOT re-extract these. Only add NEW facts, or use "supersedes:ID" when a new fact updates an existing one above.
${registerLines}

NEW SCENE TEXT (Scene #${sceneId}):
${sceneText}

TASK:
1. Rate this scene's importance 1-10 on the FIRST line as: importance:N
2. ${sceneNote}
3. Extract every story-relevant fact that affects future continuity (NPC states, items, locations, relationships, abilities, debuffs, quest progress, obligations, world state, canon overrides).

Categories (use exactly one per line): canon_override, world_change, entity_state, player_state, obligation.

Output format — one divergence per line after the importance line, no JSON, no markdown:
- [category | subject | scene:NNN] divergence sentence
- [category | subject | scene:NNN | supersedes:ID] divergence sentence

Preserve proper nouns exactly. If there are NO divergences, output only the importance line.`;
}

export async function extractDivergences(
    provider: EndpointConfig,
    sceneText: string,
    sceneId: string,
    currentRegister: DivergenceRegister,
    options?: { forceExtract?: boolean; multiScene?: boolean }
): Promise<{ result: { importance: number } | null; entries: DivergenceEntry[] }> {
    const prompt = buildExtractionPrompt(sceneText, sceneId, currentRegister, options?.multiScene);

    try {
        const raw = await callLLM(provider, prompt, { priority: 'low', maxTokens: 800 });
        const cleaned = stripReasoning(raw);

        const impMatch = cleaned.match(/importance\s*:\s*(\d{1,2})/i);
        const importance = impMatch ? Math.min(10, Math.max(1, parseInt(impMatch[1], 10))) : 5;

        const validIds = options?.multiScene
            ? Array.from(new Set([sceneId, ...Array.from(cleaned.matchAll(/scene\s*:\s*([0-9a-z_-]+)/gi)).map(m => m[1])]))
            : [sceneId];

        const parsed = parseBulletDivergences(cleaned, validIds);

        if (!options?.forceExtract && !options?.multiScene && importance < IMPORTANCE_GATE && parsed.length === 0) {
            return { result: { importance }, entries: [] };
        }

        const entries: DivergenceEntry[] = parsed.map(ne => ({
            id: `div_${uid()}`,
            category: ne.category,
            subject: ne.subject,
            divergence: ne.divergence,
            sceneRef: ne.sceneRef || sceneId,
            linkedSceneIds: [ne.sceneRef || sceneId],
            importance,
            supersedes: ne.supersedes,
            source: options?.forceExtract ? 'manual' : 'auto',
            parseError: ne.parseError,
        }));

        return { result: { importance }, entries };
    } catch (err) {
        console.warn('[DivergenceRegister] Extraction failed:', err);
        return { result: null, entries: [] };
    }
}

function buildBatchExtractionPrompt(
    scenesText: string,
    sceneIds: string[],
    currentRegister: DivergenceRegister
): string {
    const registerLines = currentRegister.entries.length > 0
        ? currentRegister.entries.map(e =>
            `${e.id} [Scene #${e.sceneRef}, imp:${e.importance}] ${e.category} — ${e.subject}: ${e.divergence}`
        ).join('\n')
        : '(empty)';
    const registerTokens = countTokens(registerLines);
    const sceneLabel = sceneIds.length === 1 ? `Scene #${sceneIds[0]}` : `Scenes #${sceneIds.join(', #')}`;

    return `EXISTING REGISTER (${registerTokens} tokens) — facts already captured. Do NOT re-extract these. Only add NEW facts, or use "supersedes:ID" when a new fact updates an existing entry above.
${registerLines}

NEW SCENES TEXT (${sceneLabel}):
${scenesText}

TASK: Extract every story-relevant fact that affects future continuity from these scenes. Examples: NPC states (alive/dead/wounded/fled), items acquired/lost/traded, locations discovered/destroyed/changed, relationships formed/broken, abilities gained/lost, debuffs or curses applied, quest progress, obligations or oaths made, world state changes, canon overrides.

Categories (use exactly one per line):
- canon_override — contradicts source material
- world_change — permanent map / world state
- entity_state — NPCs, items, factions
- player_state — abilities, titles, curses
- obligation — debts, promises, oaths

Output format — one divergence per line, no JSON, no markdown:
- [category | subject | scene:NNN] divergence sentence
- [category | subject | scene:NNN | supersedes:ID] divergence sentence

Rules:
- scene:NNN must be one of: ${sceneIds.join(', ')}.
- Preserve proper nouns exactly.
- One sentence per line.
- If there are NO new divergences, output a single line: NONE`;
}

export async function extractFromMessageBatch(
    provider: EndpointConfig,
    messages: ChatMessage[],
    sceneIdsByMessageId: Record<string, string>,
    currentRegister: DivergenceRegister,
    contextLimit: number,
    signal?: AbortSignal,
    divergenceScanBudget?: number,
): Promise<{
    newEntries: DivergenceEntry[];
    supersedes: Array<{ oldId: string; newId: string }>;
    reason?: 'no-scene-mapping';
    parseFailures: number;
    chunkCount: number;
}> {
    if (messages.length === 0) return { newEntries: [], supersedes: [], parseFailures: 0, chunkCount: 0 };

    const scenesBySceneId = new Map<string, { sceneId: string; parts: string[] }>();
    for (const msg of messages) {
        const sceneId = sceneIdsByMessageId[msg.id];
        if (!sceneId) continue;
        if (!scenesBySceneId.has(sceneId)) {
            scenesBySceneId.set(sceneId, { sceneId, parts: [] });
        }
        scenesBySceneId.get(sceneId)!.parts.push(`[${msg.role.toUpperCase()}]: ${msg.content}`);
    }

    if (scenesBySceneId.size === 0) {
        console.error('[DivergenceRegister] No messages mapped to scene IDs — extraction skipped. ' +
            `messages=${messages.length}, mappedIds=${Object.keys(sceneIdsByMessageId).length}. ` +
            'Likely cause: archiveIndex out of sync with chat messages (post-retcon or append failure).');
        return { newEntries: [], supersedes: [], reason: 'no-scene-mapping' as const, parseFailures: 0, chunkCount: 0 };
    }

    const sceneEntries = [...scenesBySceneId.values()].map(s => ({
        sceneId: s.sceneId,
        text: s.parts.join('\n'),
    }));

    const defaultBudget = Math.floor(contextLimit * 0.75);
    const CHUNK_BUDGET = divergenceScanBudget && divergenceScanBudget > 0
        ? divergenceScanBudget
        : defaultBudget;
    const chunks: Array<typeof sceneEntries> = [];
    let currentChunk: typeof sceneEntries = [];
    let currentTokens = 0;

    for (const scene of sceneEntries) {
        const cost = countTokens(scene.text);
        if (currentTokens + cost > CHUNK_BUDGET && currentChunk.length > 0) {
            chunks.push(currentChunk);
            currentChunk = [];
            currentTokens = 0;
        }
        currentChunk.push(scene);
        currentTokens += cost;
    }
    if (currentChunk.length > 0) chunks.push(currentChunk);

    const allNewEntries: DivergenceEntry[] = [];
    const allSupersedes: Array<{ oldId: string; newId: string }> = [];
    let parseFailures = 0;

    for (const chunk of chunks) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

        const combinedText = chunk.map(s => `[Scene #${s.sceneId}]:\n${s.text}`).join('\n\n');
        const sceneIds = chunk.map(s => s.sceneId);
        const prompt = buildBatchExtractionPrompt(combinedText, sceneIds, currentRegister);

        try {
            const raw = await callLLM(provider, prompt, { priority: 'low', maxTokens: 1200, signal });
            const parsed = parseBulletDivergences(raw, sceneIds);
            for (const ne of parsed) {
                const entry: DivergenceEntry = {
                    id: `div_${uid()}`,
                    category: ne.category,
                    subject: ne.subject,
                    divergence: ne.divergence,
                    sceneRef: ne.sceneRef,
                    linkedSceneIds: [...sceneIds],
                    importance: 5,
                    supersedes: ne.supersedes,
                    source: 'auto',
                    parseError: ne.parseError,
                };
                allNewEntries.push(entry);
                if (ne.supersedes) {
                    allSupersedes.push({ oldId: ne.supersedes, newId: entry.id });
                }
                if (ne.parseError) parseFailures++;
            }
        } catch (err) {
            if ((err as Error).name === 'AbortError') throw err;
            console.warn('[DivergenceRegister] Batch extraction chunk failed:', err);
            parseFailures++;
        }
    }

    return { newEntries: allNewEntries, supersedes: allSupersedes, parseFailures, chunkCount: chunks.length };
}

export function buildSceneMap(
    archiveIndex: ArchiveIndexEntry[],
    messages: ChatMessage[]
): { sceneIdsByMessageId: Record<string, string>; index: Array<{ sceneId: string; importance?: number }> } {
    const sceneIdsByMessageId: Record<string, string> = {};
    const userMessages = messages.filter(m => m.role === 'user');
    const pairCount = Math.min(userMessages.length, archiveIndex.length);
    const userTail = userMessages.slice(-pairCount);
    const archiveTail = archiveIndex.slice(-pairCount);
    for (let i = 0; i < pairCount; i++) {
        sceneIdsByMessageId[userTail[i].id] = archiveTail[i].sceneId;
    }

    // Also map assistant (GM) messages to the same scene as their preceding user message
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role === 'assistant' && !sceneIdsByMessageId[msg.id]) {
            // Walk backwards to find the nearest user message with a scene ID
            let found = false;
            for (let j = i - 1; j >= 0; j--) {
                if (messages[j].role === 'user' && sceneIdsByMessageId[messages[j].id]) {
                    sceneIdsByMessageId[msg.id] = sceneIdsByMessageId[messages[j].id];
                    found = true;
                    break;
                }
            }
            if (!found) {
                // Edge case: assistant message before any user message
                sceneIdsByMessageId[msg.id] = '000';
            }
        }
    }

    return {
        sceneIdsByMessageId,
        index: archiveIndex.map(e => ({ sceneId: e.sceneId, importance: e.importance })),
    };
}

export function mergeEntries(
    register: DivergenceRegister,
    newEntries: DivergenceEntry[],
    sceneId: string
): DivergenceRegister {
    if (newEntries.length === 0) return register;

    const supersedeIds = new Set(newEntries.filter(e => e.supersedes).map(e => e.supersedes!));
    const surviving = register.entries.filter(e => !supersedeIds.has(e.id));

    const merged = [...surviving];
    for (const ne of newEntries) {
        const existing = ne.supersedes ? register.entries.find(e => e.id === ne.supersedes) : null;
        if (existing) {
            merged.push({
                ...ne,
                linkedSceneIds: [...new Set([...existing.linkedSceneIds, ...ne.linkedSceneIds])],
                importance: Math.max(existing.importance, ne.importance),
            });
        } else {
            merged.push(ne);
        }
    }

    merged.sort((a, b) => parseInt(a.sceneRef) - parseInt(b.sceneRef));

    return {
        entries: merged,
        lastUpdatedSceneId: sceneId,
        lastUpdatedAt: Date.now(),
        version: register.version,
    };
}

export function renderRegisterForPayload(register: DivergenceRegister): string {
    if (register.entries.length === 0) return '';

    const byCategory: Record<string, DivergenceEntry[]> = {};
    for (const e of register.entries) {
        if (e.category === 'obligation' && e.resolved) continue;
        const cat = e.category;
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push(e);
    }

    const sections: string[] = [];
    const catLabels: Record<string, string> = {
        canon_override: 'CANON OVERRIDES',
        world_change: 'WORLD CHANGES',
        entity_state: 'NPC & ENTITY FATES',
        player_state: 'PLAYER STATE',
        obligation: 'OBLIGATIONS',
    };

    for (const [cat, entries] of Object.entries(byCategory)) {
        const label = catLabels[cat] || cat.toUpperCase();
        const lines = entries.map(e => {
            const marker = e.source === 'manual' ? ' ⚡' : '';
            const resolved = e.category === 'obligation' && !e.resolved ? ' — UNRESOLVED' : '';
            return `• ${e.subject}: ${e.divergence} [Scene #${e.sceneRef}]${marker}${resolved}`;
        });
        sections.push(`${label}:\n${lines.join('\n')}`);
    }

    const latestScene = register.entries.reduce((max, e) =>
        parseInt(e.sceneRef) > parseInt(max) ? e.sceneRef : max, '000'
    );

    return `[CAMPAIGN DIVERGENCE REGISTER — AUTHORITATIVE OVERRIDES]\n[Last updated: Scene #${register.lastUpdatedSceneId || latestScene}]\nThese facts are TRUE in this campaign and override your training data.\n\n${sections.join('\n\n')}\n[END DIVERGENCE REGISTER]`;
}

export function getDivergenceSceneIds(register: DivergenceRegister): Set<string> {
    const ids = new Set<string>();
    for (const e of register.entries) {
        ids.add(e.sceneRef);
        for (const sid of e.linkedSceneIds) ids.add(sid);
    }
    return ids;
}

export function backfillParseErrors(register: DivergenceRegister): DivergenceRegister {
    if (!register.entries.some(e => e.parseError)) return register;

    const allSceneIds = Array.from(getDivergenceSceneIds(register));
    let changed = false;

    const entries = register.entries.map(e => {
        if (!e.parseError) return e;

        const reconstructed = `- ${e.category} | ${e.subject} | scene:${e.sceneRef} | ${e.divergence}`;
        const parsed = parseBulletDivergences(reconstructed, allSceneIds.length > 0 ? allSceneIds : [e.sceneRef]);

        if (parsed.length === 1 && !parsed[0].parseError) {
            changed = true;
            const p = parsed[0];
            return {
                ...e,
                category: p.category,
                subject: p.subject,
                divergence: p.divergence,
                sceneRef: p.sceneRef,
                supersedes: p.supersedes ?? e.supersedes,
                parseError: false,
            };
        }

        if (e.divergence && e.subject === e.divergence.slice(0, 40)) {
            changed = true;
            return { ...e, subject: '(unparsed)' };
        }

        return e;
    });

    return changed ? { ...register, entries } : register;
}

export function countRegisterTokens(register: DivergenceRegister): number {
    return countTokens(renderRegisterForPayload(register));
}

export async function compressRegister(
    provider: EndpointConfig,
    register: DivergenceRegister,
    targetTokens: number
): Promise<DivergenceRegister> {
    const protected_ = register.entries.filter(e => e.importance >= 9);
    const compressible = register.entries.filter(e => e.importance < 9);

    if (compressible.length === 0) return register;

    const currentTokens = countRegisterTokens(register);
    if (currentTokens <= targetTokens) return register;

    const compressibleText = compressible.map(e =>
        `[Scene #${e.sceneRef}, imp:${e.importance}] ${e.category} — ${e.subject}: ${e.divergence}`
    ).join('\n');

    const prompt = `You are compressing part of a campaign divergence register to fit a token budget.

ENTRIES TO COMPRESS (${countTokens(compressibleText)} tokens, target: ${targetTokens} tokens):
${compressibleText}

COMPRESSION RULES:
1. Importance 7-8: Compress to one line but keep all proper nouns.
2. Importance 5-6: Aggressively compress. Merge related entries by subject.
3. Importance ≤ 4: Drop if superseded. Merge into parent if related.
4. If an item was ACQUIRED then LOST/TRADED, merge into one line noting final state.
5. Preserve ALL proper nouns exactly as written.
6. Preserve sceneRef on each output entry (use earliest sceneRef when merging).
7. Target: ${targetTokens} tokens.

OUTPUT: JSON array of entries: [{ "category": "...", "subject": "...", "divergence": "...", "sceneRef": "...", "importance": <number>, "linkedSceneIds": ["..."], "source": "auto" }]`;

    try {
        const raw = await callLLM(provider, prompt, { priority: 'low', maxTokens: 1000 });
        const jsonStr = extractJson(raw);
        const compressed = JSON.parse(jsonStr) as Array<Partial<DivergenceEntry>>;

        const newEntries: DivergenceEntry[] = compressed.map(ce => ({
            id: `div_${uid()}`,
            category: ce.category || 'entity_state',
            subject: ce.subject || '',
            divergence: ce.divergence || '',
            sceneRef: ce.sceneRef || '000',
            linkedSceneIds: ce.linkedSceneIds || [],
            importance: ce.importance ?? 5,
            source: ce.source || 'auto',
        }));

        const merged = [...protected_, ...newEntries];
        merged.sort((a, b) => parseInt(a.sceneRef) - parseInt(b.sceneRef));

        return {
            entries: merged,
            lastUpdatedSceneId: register.lastUpdatedSceneId,
            lastUpdatedAt: Date.now(),
            version: register.version + 1,
        };
    } catch (err) {
        console.warn('[DivergenceRegister] Compression failed:', err);
        return register;
    }
}

export async function structureManualEntry(
    provider: EndpointConfig,
    freeText: string
): Promise<{ category: DivergenceCategory; subject: string; divergence: string } | null> {
    const prompt = `A player described a campaign divergence in free text. Structure it into fields.

Player text: "${freeText}"

OUTPUT JSON only: { "category": "<canon_override|world_change|entity_state|player_state|obligation>", "subject": "<entity affected>", "divergence": "<one-line factual statement>" }`;

    try {
        const raw = await callLLM(provider, prompt, { priority: 'low', maxTokens: 200 });
        const jsonStr = extractJson(raw);
        return JSON.parse(jsonStr);
    } catch (err) {
        console.warn('[DivergenceRegister] Manual structuring failed:', err);
        return null;
    }
}
