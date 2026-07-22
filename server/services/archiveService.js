/**
 * Archive Service — orchestrator layer.
 *
 * Phase 5 split: all business logic that used to live inline in the route
 * handlers moves here. The service:
 *   - Calls the repository (pure file I/O) for read-modify-write sequences.
 *   - Calls the vector service (thin wrapper) for embed + search ops.
 *   - Holds `withCampaignLock` invocations (lock stays in the service layer,
 *     NEVER pushed deeper into the repository — per Phase 5 hard rule #2).
 *   - Runs the NLP heuristics (extractIndexKeywords / extractNPCNames / etc.)
 *     inline, since they're pure functions.
 *   - Emits `archive:written` after a scene is persisted so the NLP pipeline
 *     listener can run the deferred LLM extraction asynchronously.
 *
 * Red zone: `nlp.js`, `vectorStore.js`, `embedder.js`, `writeLock.js` are NOT
 * modified — only consumed here.
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

import {
    extractIndexKeywords, extractNPCNames, estimateImportance,
    extractKeywordStrengths, extractNPCStrengths, extractWitnessesHeuristic,
} from '../lib/nlp.js';
import { normalizeEntityName } from '../lib/entityResolution.js';
import { withCampaignLock } from '../lib/writeLock.js';
import { CAMPAIGNS_DIR, ensureDirs, validateCampaignId, readJson } from '../lib/fileStore.js';

import {
    appendSceneBlock, readArchiveMd, writeArchiveMd, archiveMdExists, deleteFiles,
    readIndex, writeIndex, readIndexAt, writeIndexAt,
    readChapters, writeChapters, writeChaptersAt, createDefaultChapter,
    readEntities, readEntitiesAt, writeEntitiesAt,
    readTimeline, writeTimeline, timelineExists,
    readFacts, writeFacts,
    getNextSceneNumber, archivePath, archiveIndexPath, chaptersPath, timelinePath, factsPath, entitiesPath,
} from './archiveRepository.js';
import {
    storeArchiveEmbedding, storeLoreEmbedding, deleteArchiveEmbedding, getEmbeddingStatus,
    EMBEDDING_VERSION, getDb,
    buildArchiveText, buildLoreText, warmup, embedBatch,
    getActiveDims, getActiveModelId, isModelReady, isJobRunning,
    searchArchiveCandidates, searchLoreCandidates,
} from './vectorService.js';
import { archiveEvents, ARCHIVE_WRITTEN } from './archiveEvents.js';

// ─── Electron shell (lazy, optional) ───────────────────────────────────────
// Loaded at module init exactly like the original archive.js. Stays null outside
// Electron, and that's fine — the open-archive route falls back to child_process.
const require_ = createRequire(import.meta.url);
let shell = null;
if (process.versions.electron) {
    try {
        const electron = require_('electron');
        shell = electron.shell;
    } catch (e) {
        console.warn('[Archive] Could not load Electron shell:', e.message);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Append a scene (the main POST /api/campaigns/:id/archive path)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Append a scene (user + assistant exchange) and write its index entry, then
 * emit `archive:written` for the deferred LLM pipeline.
 *
 * Phase split preserved: the synchronous `getNextSceneNumber` + `appendFileSync`
 * happen FIRST (before any await) so concurrent appends serialise on the scene
 * number and the prose write. Then two separate `withCampaignLock` blocks run
 * (index write, then entity+chapter update) — exactly as the original.
 *
 * @param {string} campaignId
 * @param {{userContent: string, assistantContent: string, importance?: number, utilityConfig?: any}} payload
 * @returns {{ ok: true, sceneNumber: number, sceneId: string }}
 */
export async function appendScene(campaignId, payload) {
    ensureDirs();
    const { userContent, assistantContent, importance: clientImportance, utilityConfig } = payload;

    const fp = archivePath(campaignId);
    const idxp = archiveIndexPath(campaignId);
    const sceneNum = getNextSceneNumber(campaignId);
    const sceneId = String(sceneNum).padStart(3, '0');
    const timestamp = Date.now();
    const timestampStr = new Date(timestamp).toLocaleString();

    // Write lossless scene to .archive.md — SYNCHRONOUS, before any await.
    const entry = [
        `## SCENE ${sceneId}`,
        `*${timestampStr}*`,
        '',
        `**[USER]**`,
        userContent,
        '',
        `**[GM]**`,
        assistantContent,
        '',
        '---',
        '',
    ].join('\n');
    appendSceneBlock(campaignId, entry);

    // Build the index entry — heuristics only here (LLM patch is deferred).
    const combinedText = `${userContent}\n${assistantContent}`;
    const keywords = extractIndexKeywords(combinedText);
    const npcNames = extractNPCNames(assistantContent);
    const { witnesses, mentioned: npcOnlyMentioned } = extractWitnessesHeuristic(npcNames, userContent, assistantContent);
    const indexEntry = {
        sceneId,
        timestamp,
        keywords,
        keywordStrengths: extractKeywordStrengths(combinedText, keywords),
        npcsMentioned: npcOnlyMentioned,
        witnesses,
        npcStrengths: extractNPCStrengths(assistantContent, [...npcOnlyMentioned, ...witnesses]),
        importance: (typeof clientImportance === 'number' && clientImportance >= 1 && clientImportance <= 10)
            ? clientImportance
            : estimateImportance(combinedText),
        userSnippet: userContent.slice(0, 120),
    };

    // Lock #1 — index write. Serialized per campaign to prevent lost updates
    // between concurrent appends and deferred LLM writes.
    await withCampaignLock(campaignId, () => {
        const existing = readIndexAt(idxp, []);
        existing.push(indexEntry);
        writeIndexAt(idxp, existing);
    });

    // Fire-and-forget embedding has been removed; embeddings are now generated
    // by the frontend WebGPU worker which polls for unversioned scenes.

    // Pre-compute the entity-name union used by the deferred timeline extraction.
    const entitiesFile = entitiesPath(campaignId);
    const knownEntities = readEntitiesAt(entitiesFile, []);
    const allEntityNames = [
        ...npcNames,
        ...knownEntities.map(e => e.name),
        ...knownEntities.flatMap(e => e.aliases),
    ];
    const uniqueEntityNames = [...new Set(allEntityNames.map(n => n.toLowerCase()))]
        .map(lower => allEntityNames.find(n => n.toLowerCase() === lower) || lower);

    // Determine which chapter this scene belongs to (read-only — lock #2 below
    // does the actual chapter write).
    const chaptersList = readChapters(campaignId, []);
    const openChapterForTimeline = chaptersList.find(c => !c.sealedAt) || chaptersList[chaptersList.length - 1];
    const currentChapterId = openChapterForTimeline?.chapterId || 'CH01';

    // Lock #2 — entity registry + chapter auto-lifecycle.
    await withCampaignLock(campaignId, () => {
        const ents = readEntitiesAt(entitiesFile, []);
        const updatedEntities = [...ents];
        for (const name of npcNames) {
            const canonical = normalizeEntityName(name, updatedEntities);
            if (canonical === name && !updatedEntities.some(e =>
                e.name.toLowerCase() === name.toLowerCase()
            )) {
                updatedEntities.push({
                    id: `ent_${String(updatedEntities.length + 1).padStart(4, '0')}`,
                    name,
                    type: 'npc',
                    aliases: [],
                    firstSeen: sceneId,
                });
            }
        }
        writeEntitiesAt(entitiesFile, updatedEntities);

        // --- Chapter Auto-Lifecycle ---
        const cp = chaptersPath(campaignId);
        let chapters = readChapters(campaignId, []);
        let openChapter = chapters.find(c => !c.sealedAt);

        if (!openChapter) {
            const nextNum = chapters.length + 1;
            openChapter = createDefaultChapter(
                `CH${String(nextNum).padStart(2, '0')}`,
                `Chapter ${nextNum}`,
                sceneId,
                1,
            );
            chapters.push(openChapter);
        } else {
            openChapter.sceneRange[1] = sceneId;
            openChapter.sceneCount++;
            if (openChapter.sceneIds) {
                if (!openChapter.sceneIds.includes(sceneId)) {
                    openChapter.sceneIds.push(sceneId);
                }
            } else {
                openChapter.sceneIds = [sceneId];
            }
        }
        writeChaptersAt(cp, chapters);
    });

    // Emit `archive:written` — the NLP pipeline listener picks this up and
    // schedules the deferred LLM witness + timeline extraction via setImmediate.
    // The listener is responsible for its own lock acquisitions.
    archiveEvents.emit(ARCHIVE_WRITTEN, {
        campaignId, sceneId, npcNames, userContent, assistantContent,
        combinedText, uniqueEntityNames, knownEntities, currentChapterId,
        utilityConfig,
    });

    return { ok: true, sceneNumber: sceneNum, sceneId };
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Clear archive
// ═══════════════════════════════════════════════════════════════════════════

/** Delete archive.md, index, chapters, timeline for a campaign. No lock. */
export function clearArchive(campaignId) {
    const files = [
        archivePath(campaignId),
        archiveIndexPath(campaignId),
        chaptersPath(campaignId),
        timelinePath(campaignId),
    ];
    deleteFiles(files);
    return { ok: true, chaptersCleared: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Status / next-scene / index
// ═══════════════════════════════════════════════════════════════════════════

export function getNextScene(campaignId) {
    const next = getNextSceneNumber(campaignId);
    const padded = String(next).padStart(3, '0');
    return { sceneNumber: next, sceneId: padded };
}

export function getArchiveStatus(campaignId) {
    if (!archiveMdExists(campaignId)) return { exists: false, sceneCount: 0 };
    const nextScene = getNextSceneNumber(campaignId);
    return { exists: true, sceneCount: nextScene - 1 };
}

export function getArchiveIndex(campaignId) {
    return readIndex(campaignId, []);
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Patch witnesses / events on the index (no lock — same as original)
// ═══════════════════════════════════════════════════════════════════════════

export function patchWitnesses(campaignId, patches) {
    const idxp = archiveIndexPath(campaignId);
    const entries = readIndexAt(idxp, []);
    for (const patch of patches) {
        if (!patch.sceneId || !Array.isArray(patch.witnesses)) continue;
        const entry = entries.find(e => e.sceneId === patch.sceneId);
        if (entry) {
            entry.witnesses = patch.witnesses;
            entry.witnessSource = patch.witnessSource || 'seal_correction';
        }
    }
    writeIndexAt(idxp, entries);
    return { updated: patches.length };
}

export function patchEvents(campaignId, patches) {
    const idxp = archiveIndexPath(campaignId);
    const entries = readIndexAt(idxp, []);
    for (const patch of patches) {
        if (!patch.sceneId || !Array.isArray(patch.events)) continue;
        const entry = entries.find(e => e.sceneId === patch.sceneId);
        if (entry) entry.events = patch.events;
    }
    writeIndexAt(idxp, entries);
    return { updated: patches.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Fetch verbatim scenes by comma-separated IDs
// ═══════════════════════════════════════════════════════════════════════════

export function fetchScenesByIds(campaignId, idsParam) {
    if (!archiveMdExists(campaignId)) return [];
    const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean);
    if (ids.length === 0) return [];

    const raw = readArchiveMd(campaignId);
    const sceneBlocks = raw.split(/^(?=## SCENE )/m);
    const result = [];
    for (const block of sceneBlocks) {
        const match = block.match(/^## SCENE (\d+)/);
        if (!match) continue;
        const sceneId = match[1].padStart(3, '0');
        if (ids.includes(sceneId)) {
            result.push({ sceneId, content: block.trim() });
        }
    }
    return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. Whole-word rename across archive prose + index
// ═══════════════════════════════════════════════════════════════════════════

export function renameAcrossArchive(campaignId, from, to) {
    const fromTrim = typeof from === 'string' ? from.trim() : '';
    const toTrim = typeof to === 'string' ? to.trim() : '';
    if (!fromTrim || !toTrim) {
        const err = new Error('from and to are required non-empty strings');
        err.statusCode = 400;
        throw err;
    }
    const pat = `\\b${fromTrim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`;
    const sub = (txt) => String(txt).replace(new RegExp(pat, 'gi'), to);

    const fp = archivePath(campaignId);
    const idxp = archiveIndexPath(campaignId);
    let proseChanged = 0;

    if (archiveMdExists(campaignId)) {
        const raw = readArchiveMd(campaignId);
        const next = sub(raw);
        if (next !== raw) {
            writeArchiveMd(campaignId, next);
            proseChanged = (next.match(/^## SCENE \d+/gm) || []).length;
        }
    }

    let indexChanged = false;
    if (fs.existsSync(idxp)) {
        const entries = readIndexAt(idxp, []);
        const newIndex = entries.map(e => {
            const userSnippet = e.userSnippet ? sub(e.userSnippet) : e.userSnippet;
            const keywords = Array.isArray(e.keywords) ? e.keywords.map(sub) : e.keywords;
            const npcsMentioned = Array.isArray(e.npcsMentioned) ? e.npcsMentioned.map(sub) : e.npcsMentioned;
            if (userSnippet !== e.userSnippet
                || JSON.stringify(keywords) !== JSON.stringify(e.keywords)
                || JSON.stringify(npcsMentioned) !== JSON.stringify(e.npcsMentioned)) {
                indexChanged = true;
                return { ...e, userSnippet, keywords, npcsMentioned };
            }
            return e;
        });
        if (indexChanged) writeIndexAt(idxp, newIndex);
    }

    return { ok: true, scenesTouched: proseChanged, indexUpdated: indexChanged };
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. Rollback: remove all scenes >= sceneId
// ═══════════════════════════════════════════════════════════════════════════

export function rollbackScenesFrom(campaignId, sceneIdParam) {
    const fromId = sceneIdParam.padStart(3, '0');
    const fromNum = parseInt(fromId, 10);

    // Trim .archive.md
    if (archiveMdExists(campaignId)) {
        const raw = readArchiveMd(campaignId);
        const sceneBlocks = raw.split(/^(?=## SCENE )/m);
        const kept = sceneBlocks.filter(block => {
            const match = block.match(/^## SCENE (\d+)/);
            if (!match) return true;
            return parseInt(match[1], 10) < fromNum;
        });
        writeArchiveMd(campaignId, kept.join(''));
    }

    // Trim index
    const idxp = archiveIndexPath(campaignId);
    if (fs.existsSync(idxp)) {
        const entries = readIndexAt(idxp, []);
        const kept = entries.filter(e => parseInt(e.sceneId, 10) < fromNum);
        writeIndexAt(idxp, kept);
    }

    // Trim timeline
    if (timelineExists(campaignId)) {
        const timeline = readTimeline(campaignId, []);
        const keptTimeline = timeline.filter(e => parseInt(e.sceneId, 10) < fromNum);
        writeTimeline(campaignId, keptTimeline);
    }

    // Chapter rollback cascade
    const cp = chaptersPath(campaignId);
    let chaptersRepaired = false;
    if (fs.existsSync(cp)) {
        let chapters = readChapters(campaignId, []);
        const originalCount = chapters.length;

        chapters = chapters.filter(ch => parseInt(ch.sceneRange[0], 10) < fromNum);

        for (const ch of chapters) {
            const endNum = parseInt(ch.sceneRange[1], 10);
            if (endNum >= fromNum) {
                ch.sceneRange[1] = String(fromNum - 1).padStart(3, '0');
                ch.invalidated = true;
                delete ch.sealedAt;
                ch.sceneCount = fromNum - parseInt(ch.sceneRange[0], 10);
                chaptersRepaired = true;
            }
        }

        if (chapters.length !== originalCount) chaptersRepaired = true;

        const openChapter = chapters.find(ch => !ch.sealedAt);
        if (!openChapter) {
            const nextNum = chapters.length + 1;
            chapters.push(createDefaultChapter(
                `CH${String(nextNum).padStart(2, '0')}`,
                `Chapter ${nextNum}`,
                fromId,
            ));
            chaptersRepaired = true;
        }

        writeChapters(campaignId, chapters);
    }

    return {
        ok: true,
        removedFrom: fromId,
        chaptersRepaired,
        condenserResetRecommended: true,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. Surgical scene delete
// ═══════════════════════════════════════════════════════════════════════════

export function deleteScene(campaignId, sceneIdParam) {
    validateCampaignId(campaignId);
    ensureDirs();
    const targetId = sceneIdParam.padStart(3, '0');
    const targetNum = parseInt(targetId, 10);
    if (Number.isNaN(targetNum)) {
        const err = new Error('Invalid sceneId');
        err.statusCode = 400;
        throw err;
    }
    const idEq = (id) => parseInt(id, 10) === targetNum;

    const fp = archivePath(campaignId);
    const idxp = archiveIndexPath(campaignId);

    // Trim .archive.md
    let sceneExisted = false;
    if (archiveMdExists(campaignId)) {
        const raw = readArchiveMd(campaignId);
        const sceneBlocks = raw.split(/^(?=## SCENE )/m);
        const kept = sceneBlocks.filter(block => {
            const match = block.match(/^## SCENE (\d+)/);
            if (!match) return true;
            const n = parseInt(match[1], 10);
            if (n === targetNum) { sceneExisted = true; return false; }
            return true;
        });
        writeArchiveMd(campaignId, kept.join(''));
    }

    // Trim index
    if (fs.existsSync(idxp)) {
        const entries = readIndexAt(idxp, []);
        const before = entries.length;
        const kept = entries.filter(e => !idEq(e.sceneId));
        if (kept.length !== before) sceneExisted = true;
        writeIndexAt(idxp, kept);
    }

    // Trim facts
    const factsFp = factsPath(campaignId);
    if (fs.existsSync(factsFp)) {
        const facts = readFacts(campaignId, []);
        const kept = (facts || []).filter(f => !idEq(f.sceneId));
        writeFacts(campaignId, kept);
    }

    // Trim timeline
    const tlp = timelinePath(campaignId);
    if (fs.existsSync(tlp)) {
        const timeline = readTimeline(campaignId, []);
        const kept = (timeline || []).filter(e => !idEq(e.sceneId));
        writeTimeline(campaignId, kept);
    }

    // Drop the embedding (non-fatal)
    try { deleteArchiveEmbedding(campaignId, targetId); } catch (e) { /* non-fatal */ }

    // Repair the chapter that contained this scene
    const cp = chaptersPath(campaignId);
    let chapterRepaired = false;
    if (fs.existsSync(cp)) {
        const chapters = readChapters(campaignId, []);
        let touched = false;
        for (const ch of chapters) {
            const had = (ch.sceneIds ?? []).some(idEq);
            if (!had) continue;
            ch.sceneIds = (ch.sceneIds ?? []).filter(id => !idEq(id));
            ch.sceneCount = Math.max(0, (ch.sceneCount ?? 0) - 1);
            if (ch.sealedAt) { ch.invalidated = true; delete ch.sealedAt; }
            touched = true;
            chapterRepaired = true;
        }
        if (touched) writeChapters(campaignId, chapters);
    }

    return { ok: true, removedSceneId: targetId, sceneExisted, chapterRepaired };
}

// ═══════════════════════════════════════════════════════════════════════════
// 9. Edit-sync: rewrite a scene's GM text + rebuild index entry + re-embed
// ═══════════════════════════════════════════════════════════════════════════

export async function updateSceneAssistant(campaignId, sceneIdParam, assistantContent) {
    validateCampaignId(campaignId);
    ensureDirs();
    const targetId = sceneIdParam.padStart(3, '0');
    const targetNum = parseInt(targetId, 10);
    if (Number.isNaN(targetNum)) {
        const err = new Error('Invalid sceneId');
        err.statusCode = 400;
        throw err;
    }
    if (typeof assistantContent !== 'string' || !assistantContent.trim()) {
        const err = new Error('assistantContent is required');
        err.statusCode = 400;
        throw err;
    }

    const fp = archivePath(campaignId);
    if (!fs.existsSync(fp)) {
        const err = new Error('Scene not found');
        err.statusCode = 404;
        throw err;
    }

    // Rewrite this scene's GM block. Parse the scene block, extract the existing
    // userContent, and rebuild the block with the new assistant content.
    const raw = readArchiveMd(campaignId);
    const sceneBlocks = raw.split(/^(?=## SCENE )/m);
    let found = false;
    let userContent = '';
    const nextBlocks = sceneBlocks.map(block => {
        const match = block.match(/^## SCENE (\d+)/);
        if (!match) return block;
        if (parseInt(match[1], 10) !== targetNum) return block;
        found = true;
        const userMatch = block.match(/\*\*\[USER\]\*\*\n([\s\S]*?)\n\n\*\*\[GM\]\*\*/);
        userContent = (userMatch ? userMatch[1] : '').trim();
        const lines = block.split('\n');
        const headerLines = [];
        let i = 0;
        while (i < lines.length && headerLines.length < 2) {
            if (lines[i].trim()) headerLines.push(lines[i]);
            i++;
        }
        const timestampLine = headerLines[1] || '';
        return [
            `## SCENE ${targetId}`,
            timestampLine,
            '',
            `**[USER]**`,
            userContent,
            '',
            `**[GM]**`,
            assistantContent,
            '',
            '---',
            '',
        ].join('\n');
    });
    if (!found) {
        const err = new Error('Scene not found');
        err.statusCode = 404;
        throw err;
    }
    writeArchiveMd(campaignId, nextBlocks.join(''));

    // Rebuild the index entry (mirrors appendScene's index construction) and re-embed.
    const idxp = archiveIndexPath(campaignId);
    const combinedText = `${userContent}\n${assistantContent}`;
    const keywords = extractIndexKeywords(combinedText);
    const npcNames = extractNPCNames(assistantContent);
    const { witnesses, mentioned: npcOnlyMentioned } = extractWitnessesHeuristic(npcNames, userContent, assistantContent);
    const entries = readIndexAt(idxp, []);
    const existing = entries.find(e => parseInt(e.sceneId, 10) === targetNum);
    const timestamp = existing?.timestamp ?? Date.now();
    const clientImportance = existing?.importance;
    const newIndexEntry = {
        sceneId: targetId,
        timestamp,
        keywords,
        keywordStrengths: extractKeywordStrengths(combinedText, keywords),
        npcsMentioned: npcOnlyMentioned,
        witnesses,
        npcStrengths: extractNPCStrengths(assistantContent, [...npcOnlyMentioned, ...witnesses]),
        importance: (typeof clientImportance === 'number' && clientImportance >= 1 && clientImportance <= 10)
            ? clientImportance
            : estimateImportance(combinedText),
        userSnippet: userContent.slice(0, 120),
    };
    writeIndexAt(idxp, entries.map(e => parseInt(e.sceneId, 10) === targetNum ? newIndexEntry : e));

    // Re-embed removed; the frontend WebGPU worker will handle stale scenes.

    return { ok: true, sceneId: targetId, userContent };
}

// ═══════════════════════════════════════════════════════════════════════════
// 10. Open archive in OS default app
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Open the archive markdown in the OS default editor.
 *
 * @param {string} campaignId
 * @param {(err: Error|null) => void} callback — receives null on success, Error on failure.
 *   Mirrors the original route's res.json/error flow; the controller adapts this.
 *   The callback is invoked exactly once.
 */
export function openArchive(campaignId, callback) {
    if (!/^[a-zA-Z0-9_-]+$/.test(campaignId)) {
        const err = new Error('Invalid campaign ID');
        err.statusCode = 400;
        return void callback(err);
    }
    const fp = archivePath(campaignId);
    if (!fs.existsSync(fp)) {
        const err = new Error('No archive yet');
        err.statusCode = 404;
        return void callback(err);
    }

    if (shell) {
        shell.openPath(fp).then(errorMsg => {
            if (errorMsg) {
                console.warn('[Archive] shell.openPath returned error:', errorMsg);
                const err = new Error(`Failed to open archive: ${errorMsg}`);
                err.statusCode = 500;
                callback(err);
            } else {
                callback(null);
            }
        }).catch(err => callback(err));
        return;
    }

    const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '""', fp] : [fp];

    import('child_process').then(({ execFile }) => {
        execFile(cmd, args, (err) => {
            callback(err || null);
        });
    }).catch(err => callback(err));
}

// ═══════════════════════════════════════════════════════════════════════════
// 11. Semantic candidates (archive + lore) — non-blocking hot path
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Archive semantic candidates. Short-circuits to { sceneIds: [], pending: true }
 * if the model is cold-loading or a bulk archive embed is in flight — exactly
 * as the original route did. The client falls back to lexical retrieval.
 *
 * `body.scopeSceneIds` (WO-10): optional array of scene IDs to restrict recall
 * to. Forwarded to `searchArchiveCandidates` → `searchArchive` as `opts.scopeIds`.
 * Absent / null / empty / non-array → unscoped (existing callers unaffected).
 */
export async function archiveSemanticCandidates(campaignId, body) {
    if (!isModelReady() || isJobRunning(campaignId, 'archive')) {
        return { sceneIds: [], pending: true };
    }
    const { query, queries, queryEmbedding, queryEmbeddings, limit, diversity = true, scopeSceneIds } = body;
    const sceneIds = await searchArchiveCandidates(campaignId, { query, queries, queryEmbedding, queryEmbeddings, limit, diversity, scopeSceneIds });
    return { sceneIds };
}

/**
 * Lore semantic candidates. Mirrors `archiveSemanticCandidates` but returns
 * loreIds. Short-circuits while the model warms up or a lore bulk embed runs.
 */
export async function loreSemanticCandidates(campaignId, body) {
    if (!isModelReady() || isJobRunning(campaignId, 'lore')) {
        return { loreIds: [], pending: true };
    }
    const { query, queries, queryEmbedding, queryEmbeddings, limit, diversity = true } = body;
    const loreIds = await searchLoreCandidates(campaignId, { query, queries, queryEmbedding, queryEmbeddings, limit, diversity });
    return { loreIds };
}

// ═══════════════════════════════════════════════════════════════════════════
// 12. Embedding status / info / reindex
// ═══════════════════════════════════════════════════════════════════════════

export function getEmbeddingsStatus(campaignId) {
    return getEmbeddingStatus(campaignId);
}

export function getEmbeddingsInfo() {
    return {
        modelId: getActiveModelId(),
        dims: getActiveDims(),
        embeddingVersion: EMBEDDING_VERSION,
    };
}

/**
 * Re-index stale + unversioned embeddings for a campaign.
 *
 * `type` is 'scene' | 'lore' | 'all'. Reads stale item_ids from the embedding
 * meta table via the DB handle, then re-embeds each chunk in batches and stores.
 *
 * This is the heaviest operation in the archive subsystem. It uses the DB
 * handle directly (read-only) to find stale/unversioned rows — that read is
 * already inside the red-zone `vectorStore.js`, but the meta table query
 * itself is a stable, public schema (added in the same `initDb()` block that
 * creates the vss tables), so this is safe to keep here.
 */
export async function getStaleTexts(campaignId) {
    const db = getDb();
    if (!db) return { scenes: [], lore: [] };

    const { stale: staleScenes, unversioned: unversionedScenes } = await getStaleAndUnversionedIds(campaignId, 'scene');
    const { stale: staleLore, unversioned: unversionedLore } = await getStaleAndUnversionedIds(campaignId, 'lore');

    // Also check for missing scene embeddings (in index but not in vss)
    const idxPath = archiveIndexPath(campaignId);
    const indexEntries = readIndexAt(idxPath, []);
    let missingScenes = [];
    if (indexEntries.length > 0) {
        const vssScenes = await getVssIds(campaignId, 'scene');
        const vssSet = new Set(vssScenes);
        missingScenes = indexEntries.map(e => e.sceneId).filter(id => !vssSet.has(id));
    }

    const allScenesSet = new Set([...staleScenes, ...unversionedScenes, ...missingScenes]);
    const allLoreSet = new Set([...staleLore, ...unversionedLore]);

    const scenes = [];
    if (allScenesSet.size > 0 && indexEntries.length > 0) {
        const indexMap = new Map(indexEntries.map(e => [e.sceneId, e]));
        for (const id of allScenesSet) {
            if (indexMap.has(id)) scenes.push({ id, text: buildArchiveText(indexMap.get(id)).slice(0, 500) });
        }
    }

    const lore = [];
    if (allLoreSet.size > 0) {
        const lorePath = path.join(CAMPAIGNS_DIR, `${campaignId}.lore.json`);
        const loreChunks = readJsonSafe(lorePath, []);
        const loreMap = new Map(loreChunks.map(c => [c.id, c]));
        for (const id of allLoreSet) {
            if (loreMap.has(id)) lore.push({ id, text: buildLoreText(loreMap.get(id)).slice(0, 500) });
        }
    }

    return { scenes, lore };
}

export async function syncEmbeddings(campaignId, type, items) {
    let synced = 0;
    if (type === 'scene') {
        for (const item of items) {
            if (item.id && item.embedding) {
                await storeArchiveEmbedding(campaignId, item.id, item.embedding);
                synced++;
            }
        }
    } else if (type === 'lore') {
        for (const item of items) {
            if (item.id && item.embedding) {
                await storeLoreEmbedding(campaignId, item.id, item.embedding);
                synced++;
            }
        }
    }
    return { synced, status: await getEmbeddingStatus(campaignId) };
}

// Local helper — readJson with the same fallback semantics the original used,
// but doesn't need to be exported from the repository (lore.json isn't an
// archive file, so it stays here as a private util).
function readJsonSafe(filePath, fallback) {
    return readJson(filePath, fallback);
}