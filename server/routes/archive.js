import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
let shell = null;
if (process.versions.electron) {
    try {
        const electron = require('electron');
        shell = electron.shell;
    } catch (e) {
        console.warn('[Archive] Could not load Electron shell:', e.message);
    }
}
import {
    readJson, writeJson, ensureDirs,
    archivePath, archiveIndexPath, chaptersPath, entitiesPath, timelinePath, factsPath,
    getNextSceneNumber, createDefaultChapter, DATA_DIR, CAMPAIGNS_DIR, validateCampaignId,
} from '../lib/fileStore.js';
import {
    extractIndexKeywords, extractNPCNames, estimateImportance,
    extractKeywordStrengths, extractNPCStrengths, extractWitnessesHeuristic,
    extractTimelineEventsRegex,
} from '../lib/nlp.js';
import { extractWitnessesLLM, extractTimelineEventsLLM } from '../services/llmProxy.js';
import { normalizeEntityName } from '../lib/entityResolution.js';
import { embedText, buildArchiveText, buildLoreText, warmup, embedBatch, getActiveDims, getActiveModelId, isModelReady } from '../lib/embedder.js';
import { storeArchiveEmbedding, storeLoreEmbedding, searchArchive, searchLore, getEmbeddingStatus, EMBEDDING_VERSION, getDb, deleteArchiveEmbedding } from '../lib/vectorStore.js';
import { isJobRunning } from '../lib/embedJobs.js';
import { withCampaignLock } from '../lib/writeLock.js';
import { wrapAsync } from '../lib/asyncHandler.js';
import { serverError } from '../lib/serverError.js';

export function createArchiveRouter() {
    const router = Router();

    // Pre-assign next scene number — called by client BEFORE sending to AI
    router.get('/api/campaigns/:id/archive/next-scene', wrapAsync((req, res) => {
        const next = getNextSceneNumber(req.params.id);
        const padded = String(next).padStart(3, '0');
        res.json({ sceneNumber: next, sceneId: padded });
    }));

    // Append a scene (user + assistant exchange) — also writes index entry.
    //
    // Phase split (race-condition fix): the route responds immediately after the
    // deterministic file writes (prose, index with heuristic witnesses, entities,
    // chapters). LLM-driven witness + timeline extraction is deferred to a
    // background `setImmediate` task that patches the index/timeline under the
    // per-campaign write lock. This prevents the 12-20s UI freeze that would
    // occur if the route awaited the LLM calls before responding, and the lock
    // prevents lost updates between concurrent appends and deferred writes.
    router.post('/api/campaigns/:id/archive', wrapAsync(async (req, res) => {
        ensureDirs();
        const campaignId = req.params.id;
        const { userContent, assistantContent, importance: clientImportance, utilityConfig } = req.body;
        if (typeof userContent !== 'string' || !userContent.trim() || typeof assistantContent !== 'string' || !assistantContent.trim()) {
            return res.status(400).json({ error: 'userContent and assistantContent are required non-empty strings' });
        }
        const fp = archivePath(campaignId);
        const idxp = archiveIndexPath(campaignId);
        const sceneNum = getNextSceneNumber(campaignId);
        const sceneId = String(sceneNum).padStart(3, '0');
        const timestamp = Date.now();
        const timestampStr = new Date(timestamp).toLocaleString();

        // Write lossless scene to .archive.md
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
        fs.appendFileSync(fp, entry, 'utf-8');

        // Build and append index entry to .archive.index.json
        const combinedText = `${userContent}\n${assistantContent}`;
        const keywords = extractIndexKeywords(combinedText);
        const npcNames = extractNPCNames(assistantContent);

        // Fast phase: use heuristic witnesses immediately (no LLM wait).
        // The deferred LLM extraction (if utilityConfig is provided) patches
        // these later via the PATCH /witnesses flow under the write lock.
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

        // Deterministic writes — serialized per campaign to prevent lost updates
        // between concurrent appends (pre-existing race) and deferred LLM writes.
        await withCampaignLock(campaignId, () => {
            const existing = readJson(idxp, []);
            existing.push(indexEntry);
            writeJson(idxp, existing);
        });

        embedText(buildArchiveText(indexEntry))
            .then(embedding => storeArchiveEmbedding(campaignId, sceneId, embedding))
            .catch(err => console.warn('[Archive] Embedding failed:', err.message));

        // Entity registry + chapter auto-lifecycle — also under the lock.
        const entitiesFile = entitiesPath(campaignId);
        const knownEntities = readJson(entitiesFile, []);
        const allEntityNames = [
            ...npcNames,
            ...knownEntities.map(e => e.name),
            ...knownEntities.flatMap(e => e.aliases)
        ];
        const uniqueEntityNames = [...new Set(allEntityNames.map(n => n.toLowerCase()))]
            .map(lower => allEntityNames.find(n => n.toLowerCase() === lower) || lower);

        // Determine which chapter this scene belongs to
        const chaptersList = readJson(chaptersPath(campaignId), []);
        const openChapterForTimeline = chaptersList.find(c => !c.sealedAt) || chaptersList[chaptersList.length - 1];
        const currentChapterId = openChapterForTimeline?.chapterId || 'CH01';

        await withCampaignLock(campaignId, () => {
            // Update entity registry
            const ents = readJson(entitiesFile, []);
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
            writeJson(entitiesFile, updatedEntities);

            // --- Chapter Auto-Lifecycle ---
            const cp = chaptersPath(campaignId);
            let chapters = readJson(cp, []);
            let openChapter = chapters.find(c => !c.sealedAt);

            if (!openChapter) {
                // Create new open chapter if none exists
                const nextNum = chapters.length + 1;
                openChapter = createDefaultChapter(
                    `CH${String(nextNum).padStart(2, '0')}`,
                    `Chapter ${nextNum}`,
                    sceneId,
                    1,
                );
                chapters.push(openChapter);
            } else {
                // Update existing open chapter
                openChapter.sceneRange[1] = sceneId;
                openChapter.sceneCount++;
            }
            writeJson(cp, chapters);
        });

        // Respond immediately — the client only needs { ok, sceneNumber, sceneId }.
        // It re-fetches index/timeline/chapters after this returns; the deferred
        // LLM results land on a later re-fetch (same UX model as embeddings).
        res.json({ ok: true, sceneNumber: sceneNum, sceneId });

        // ── Deferred phase: LLM witness + timeline extraction ──
        // Runs only when utilityConfig is provided (currently dormant — the
        // client doesn't pass it, so this is forward-looking). Patched under the
        // per-campaign lock so it can't clobber a concurrent append's writes.
        if (utilityConfig?.endpoint && npcNames.length > 0) {
            setImmediate(async () => {
                try {
                    // Witness extraction → patch the index entry's witnesses field
                    const witnessResult = await extractWitnessesLLM(npcNames, userContent, assistantContent, utilityConfig);
                    if (witnessResult && Array.isArray(witnessResult.witnesses)) {
                        await withCampaignLock(campaignId, () => {
                            const entries = readJson(idxp, []);
                            const target = entries.find(e => e.sceneId === sceneId);
                            if (target) {
                                target.witnesses = witnessResult.witnesses;
                                target.witnessSource = 'llm';
                                if (Array.isArray(witnessResult.mentioned)) {
                                    target.npcsMentioned = witnessResult.mentioned;
                                }
                            }
                            writeJson(idxp, entries);
                        });
                        console.log(`[Archive] LLM witnesses patched for scene #${sceneId}`);
                    }

                    // Timeline event extraction → append to timeline store
                    const newEventsRaw = await extractTimelineEventsLLM(uniqueEntityNames, combinedText, sceneId, currentChapterId, utilityConfig);
                    let newEvents = null;
                    if (newEventsRaw === null) {
                        newEvents = extractTimelineEventsRegex(npcNames, combinedText, sceneId, currentChapterId);
                    } else {
                        newEvents = newEventsRaw;
                        for (const ev of newEvents) {
                            ev.subject = normalizeEntityName(ev.subject, knownEntities);
                            ev.object = normalizeEntityName(ev.object, knownEntities);
                        }
                    }

                    if (newEvents && newEvents.length > 0) {
                        await withCampaignLock(campaignId, () => {
                            const tp = timelinePath(campaignId);
                            const existingEvents = readJson(tp, []);
                            const maxId = existingEvents.reduce((max, e) => {
                                const num = parseInt(e.id.replace('tl_', ''), 10);
                                return num > max ? num : max;
                            }, 0);
                            let idCounter = maxId + 1;
                            for (const ev of newEvents) {
                                existingEvents.push({
                                    id: `tl_${String(idCounter++).padStart(4, '0')}`,
                                    ...ev,
                                });
                            }
                            writeJson(tp, existingEvents);
                        });
                        console.log(`[Archive] LLM timeline events appended for scene #${sceneId} (${newEvents.length} events)`);
                    }
                } catch (err) {
                    console.warn(`[Archive] Deferred LLM extraction failed for scene #${sceneId}:`, err.message);
                }
            });
        }
    }));

    // Clear archive (.archive.md and .archive.index.json)
    router.delete('/api/campaigns/:id/archive', wrapAsync((req, res) => {
        const id = req.params.id;
        const files = [
            archivePath(id),
            archiveIndexPath(id),
            chaptersPath(id),
            timelinePath(id),
        ];
        for (const f of files) {
            if (fs.existsSync(f)) fs.unlinkSync(f);
        }
        res.json({ ok: true, chaptersCleared: true });
    }));

    // Get current scene count
    router.get('/api/campaigns/:id/archive', wrapAsync((req, res) => {
        const fp = archivePath(req.params.id);
        if (!fs.existsSync(fp)) return res.json({ exists: false, sceneCount: 0 });
        const nextScene = getNextSceneNumber(req.params.id);
        res.json({ exists: true, sceneCount: nextScene - 1 });
    }));

    // ═══════════════════════════════════════════
    //  Archive Index & Scene Retrieval (Tier 4)
    // ═══════════════════════════════════════════

    // Return the full .archive.index.json for client-side retrieval
    router.get('/api/campaigns/:id/archive/index', wrapAsync((req, res) => {
        const entries = readJson(archiveIndexPath(req.params.id), []);
        res.json(entries);
    }));

    // Patch witness data on specific scenes (applied after seal audit corrections)
    router.patch('/api/campaigns/:id/archive/witnesses', wrapAsync((req, res) => {
        const { patches } = req.body;
        if (!Array.isArray(patches)) {
            return res.status(400).json({ error: 'patches must be an array' });
        }
        const idxp = archiveIndexPath(req.params.id);
        const entries = readJson(idxp, []);
        for (const patch of patches) {
            if (!patch.sceneId || !Array.isArray(patch.witnesses)) continue;
            const entry = entries.find(e => e.sceneId === patch.sceneId);
            if (entry) {
                entry.witnesses = patch.witnesses;
                entry.witnessSource = patch.witnessSource || 'seal_correction';
            }
        }
        writeJson(idxp, entries);
        res.json({ updated: patches.length });
    }));

    // Patch event data on specific scenes
    router.patch('/api/campaigns/:id/archive/events', wrapAsync((req, res) => {
        const { patches } = req.body;
        if (!Array.isArray(patches)) {
            return res.status(400).json({ error: 'patches must be an array' });
        }
        const idxp = archiveIndexPath(req.params.id);
        const entries = readJson(idxp, []);
        for (const patch of patches) {
            if (!patch.sceneId || !Array.isArray(patch.events)) continue;
            const entry = entries.find(e => e.sceneId === patch.sceneId);
            if (entry) {
                entry.events = patch.events;
            }
        }
        writeJson(idxp, entries);
        res.json({ updated: patches.length });
    }));

    // Fetch full verbatim scenes by comma-separated scene IDs
    router.get('/api/campaigns/:id/archive/scenes', wrapAsync((req, res) => {
        const fp = archivePath(req.params.id);
        if (!fs.existsSync(fp)) return res.json([]);
        const idsParam = req.query.ids || '';
        const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean);
        if (ids.length === 0) return res.json([]);

        const raw = fs.readFileSync(fp, 'utf-8');
        // Split on ## SCENE boundaries
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
        res.json(result);
    }));

    // Whole-word, case-insensitive rename across the sealed archive: scene prose
    // (.archive.md) and the index snippet/keywords/NPCs. Used by the manual
    // highlight → rename tool. Returns the number of scenes whose prose changed.
    router.post('/api/campaigns/:id/archive/rename', wrapAsync((req, res) => {
        const { from, to } = req.body || {};
        const fromTrim = typeof from === 'string' ? from.trim() : '';
        const toTrim = typeof to === 'string' ? to.trim() : '';
        if (!fromTrim || !toTrim) {
            return res.status(400).json({ error: 'from and to are required non-empty strings' });
        }
        const pat = `\\b${fromTrim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`;
        const sub = (txt) => String(txt).replace(new RegExp(pat, 'gi'), to);

        const fp = archivePath(req.params.id);
        const idxp = archiveIndexPath(req.params.id);
        let proseChanged = 0;

        if (fs.existsSync(fp)) {
            const raw = fs.readFileSync(fp, 'utf-8');
            const next = sub(raw);
            if (next !== raw) {
                fs.writeFileSync(fp, next, 'utf-8');
                // Count touched scenes by re-splitting on ## SCENE boundaries.
                proseChanged = (next.match(/^## SCENE \d+/gm) || []).length;
            }
        }

        let indexChanged = false;
        if (fs.existsSync(idxp)) {
            const entries = readJson(idxp, []);
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
            if (indexChanged) writeJson(idxp, newIndex);
        }

        res.json({ ok: true, scenesTouched: proseChanged, indexUpdated: indexChanged });
    }));

    // Rollback: remove all scenes >= sceneId from .archive.md and .archive.index.json
    router.delete('/api/campaigns/:id/archive/scenes-from/:sceneId', wrapAsync((req, res) => {
        const fp = archivePath(req.params.id);
        const idxp = archiveIndexPath(req.params.id);
        const fromId = req.params.sceneId.padStart(3, '0');
        const fromNum = parseInt(fromId, 10);

        // Trim .archive.md
        if (fs.existsSync(fp)) {
            const raw = fs.readFileSync(fp, 'utf-8');
            const sceneBlocks = raw.split(/^(?=## SCENE )/m);
            const kept = sceneBlocks.filter(block => {
                const match = block.match(/^## SCENE (\d+)/);
                if (!match) return true; // keep preamble if any
                return parseInt(match[1], 10) < fromNum;
            });
            fs.writeFileSync(fp, kept.join(''), 'utf-8');
        }

        // Trim .archive.index.json
        if (fs.existsSync(idxp)) {
            const entries = readJson(idxp, []);
            const kept = entries.filter(e => parseInt(e.sceneId, 10) < fromNum);
            writeJson(idxp, kept);
        }

        // Trim timeline from this scene onwards
        const tlp = timelinePath(req.params.id);
        if (fs.existsSync(tlp)) {
            const timeline = readJson(tlp, []);
            const keptTimeline = timeline.filter(e => parseInt(e.sceneId, 10) < fromNum);
            writeJson(tlp, keptTimeline);
        }

        // --- NEW: Chapter Rollback Cascade ---
        const cp = chaptersPath(req.params.id);
        let chaptersRepaired = false;
        if (fs.existsSync(cp)) {
            let chapters = readJson(cp, []);
            const originalCount = chapters.length;

            // 1. Filter out chapters fully ahead of rollback point
            chapters = chapters.filter(ch => parseInt(ch.sceneRange[0], 10) < fromNum);

            // 2. Repair chapters spanning the rollback point
            for (const ch of chapters) {
                const endNum = parseInt(ch.sceneRange[1], 10);
                if (endNum >= fromNum) {
                    ch.sceneRange[1] = String(fromNum - 1).padStart(3, '0');
                    ch.invalidated = true;
                    delete ch.sealedAt; // unseal — summary no longer valid
                    ch.sceneCount = fromNum - parseInt(ch.sceneRange[0], 10);
                    chaptersRepaired = true;
                }
            }

            if (chapters.length !== originalCount) chaptersRepaired = true;

            // 3. Ensure an open chapter exists starting at fromNum - 1 (if archive not empty)
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

            writeJson(cp, chapters);
        }

        res.json({
            ok: true,
            removedFrom: fromId,
            chaptersRepaired,
            condenserResetRecommended: true
        });
    }));

    // ── Surgical scene delete + edit-sync (WO-F, 2be3ad5) ──────────────────────
    // Delete a SINGLE archived scene (re-thread chapters, no full rebuild) and rewrite a
    // scene's GM text in long-term memory (so the AI stops recalling deleted/old text).
    // Gap-safe scene numbering (getNextSceneNumber uses max+1) means deletions can leave holes.

    // Delete one scene from scenes/index/embeddings/facts/timeline and repair its chapter.
    router.delete('/api/campaigns/:id/archive/scenes/:sceneId', wrapAsync((req, res) => {
        validateCampaignId(req.params.id);
        ensureDirs();
        const targetId = req.params.sceneId.padStart(3, '0');
        const targetNum = parseInt(targetId, 10);
        if (Number.isNaN(targetNum)) return res.status(400).json({ error: 'Invalid sceneId' });
        const idEq = (id) => parseInt(id, 10) === targetNum;

        const fp = archivePath(req.params.id);
        const idxp = archiveIndexPath(req.params.id);

        // Trim .archive.md (drop just this scene's block)
        let sceneExisted = false;
        if (fs.existsSync(fp)) {
            const raw = fs.readFileSync(fp, 'utf-8');
            const sceneBlocks = raw.split(/^(?=## SCENE )/m);
            const kept = sceneBlocks.filter(block => {
                const match = block.match(/^## SCENE (\d+)/);
                if (!match) return true; // keep preamble
                const n = parseInt(match[1], 10);
                if (n === targetNum) { sceneExisted = true; return false; }
                return true;
            });
            fs.writeFileSync(fp, kept.join(''), 'utf-8');
        }

        // Trim .archive.index.json
        if (fs.existsSync(idxp)) {
            const entries = readJson(idxp, []);
            const before = entries.length;
            const kept = entries.filter(e => !idEq(e.sceneId));
            if (kept.length !== before) sceneExisted = true;
            writeJson(idxp, kept);
        }

        // Trim facts for this scene
        const factsFp = factsPath(req.params.id);
        if (fs.existsSync(factsFp)) {
            const facts = readJson(factsFp, []);
            const kept = (facts || []).filter(f => !idEq(f.sceneId));
            writeJson(factsFp, kept);
        }

        // Trim timeline events for this scene
        const tlp = timelinePath(req.params.id);
        if (fs.existsSync(tlp)) {
            const timeline = readJson(tlp, []);
            const kept = (timeline || []).filter(e => !idEq(e.sceneId));
            writeJson(tlp, kept);
        }

        // Drop the scene's embedding
        try { deleteArchiveEmbedding(req.params.id, targetId); } catch (e) { /* non-fatal */ }

        // Repair the chapter that contained this scene: drop the id from sceneIds (if present),
        // decrement sceneCount, and invalidate its seal (summary is now stale). Leave sceneRange
        // endpoints as-is — gaps inside a range are fine; recall uses sceneIds, not range arithmetic.
        const cp = chaptersPath(req.params.id);
        let chapterRepaired = false;
        if (fs.existsSync(cp)) {
            const chapters = readJson(cp, []);
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
            if (touched) writeJson(cp, chapters);
        }

        res.json({ ok: true, removedSceneId: targetId, sceneExisted, chapterRepaired });
    }));

    // Rewrite a scene's GM (assistant) text in long-term memory + rebuild its index entry + re-embed.
    router.patch('/api/campaigns/:id/archive/scenes/:sceneId/assistant', wrapAsync(async (req, res) => {
        validateCampaignId(req.params.id);
        ensureDirs();
        const targetId = req.params.sceneId.padStart(3, '0');
        const targetNum = parseInt(targetId, 10);
        if (Number.isNaN(targetNum)) return res.status(400).json({ error: 'Invalid sceneId' });
        const { assistantContent } = req.body;
        if (typeof assistantContent !== 'string' || !assistantContent.trim()) {
            return res.status(400).json({ error: 'assistantContent is required' });
        }

        const fp = archivePath(req.params.id);
        if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Scene not found' });

        // Rewrite this scene's GM block in .archive.md. Parse the scene block, extract the existing
        // userContent, and rebuild the block with the new assistant content.
        const raw = fs.readFileSync(fp, 'utf-8');
        const sceneBlocks = raw.split(/^(?=## SCENE )/m);
        let found = false;
        let userContent = '';
        const nextBlocks = sceneBlocks.map(block => {
            const match = block.match(/^## SCENE (\d+)/);
            if (!match) return block;
            if (parseInt(match[1], 10) !== targetNum) return block;
            found = true;
            // Extract the existing USER block text (between **[USER]** and **[GM]**).
            const userMatch = block.match(/\*\*\[USER\]\*\*\n([\s\S]*?)\n\n\*\*\[GM\]\*\*/);
            userContent = (userMatch ? userMatch[1] : '').trim();
            // Preserve the header + timestamp lines (first two non-empty lines after ## SCENE).
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
        if (!found) return res.status(404).json({ error: 'Scene not found' });
        fs.writeFileSync(fp, nextBlocks.join(''), 'utf-8');

        // Rebuild the index entry (mirrors the append route's index construction) and re-embed.
        const idxp = archiveIndexPath(req.params.id);
        const combinedText = `${userContent}\n${assistantContent}`;
        const keywords = extractIndexKeywords(combinedText);
        const npcNames = extractNPCNames(assistantContent);
        const { witnesses, mentioned: npcOnlyMentioned } = extractWitnessesHeuristic(npcNames, userContent, assistantContent);
        const entries = readJson(idxp, []);
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
        writeJson(idxp, entries.map(e => parseInt(e.sceneId, 10) === targetNum ? newIndexEntry : e));

        try {
            const embedding = await embedText(buildArchiveText(newIndexEntry));
            if (embedding) storeArchiveEmbedding(req.params.id, targetId, embedding);
        } catch (err) {
            console.warn('[Archive] Re-embed failed on scene edit:', err.message);
        }

        res.json({ ok: true, sceneId: targetId, userContent });
    }));

    // Open archive in OS default app
    router.get('/api/campaigns/:id/archive/open', wrapAsync((req, res) => {
        // Validate campaign ID to prevent command injection
        if (!/^[a-zA-Z0-9_-]+$/.test(req.params.id)) {
            return res.status(400).json({ error: 'Invalid campaign ID' });
        }
        const fp = archivePath(req.params.id);
        if (!fs.existsSync(fp)) {
            return res.status(404).json({ error: 'No archive yet' });
        }

        if (shell) {
            shell.openPath(fp).then(errorMsg => {
                if (errorMsg) {
                    console.warn('[Archive] shell.openPath returned error:', errorMsg);
                    return res.status(500).json({ error: `Failed to open archive: ${errorMsg}` });
                }
                res.json({ ok: true });
            }).catch(err => {
                serverError(res, err, 'Archive Open');
            });
        } else {
            const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
            const args = process.platform === 'win32' ? ['/c', 'start', '""', fp] : [fp];

            import('child_process').then(({ execFile }) => {
                execFile(cmd, args, (err) => {
                    if (err) {
                        serverError(res, err, 'Archive Open');
                        return;
                    }
                    res.json({ ok: true });
                });
            }).catch(err => {
                serverError(res, err, 'Archive Open');
            });
        }
    }));

    router.post('/api/campaigns/:id/archive/semantic-candidates', wrapAsync(async (req, res) => {
        // Non-blocking hot path: if the model is still cold-loading, or a bulk archive
        // embed is in flight, don't block this turn on it — return empty + pending and
        // let the client fall back to lexical retrieval. Embeddings kick in next turn.
        if (!isModelReady() || isJobRunning(req.params.id, 'archive')) {
            return res.json({ sceneIds: [], pending: true });
        }
        const { query, queries, limit, diversity = true } = req.body;
        if (queries && Array.isArray(queries) && queries.length > 0) {
            const allSceneIds = new Set();
            for (const q of queries) {
                if (!q?.trim()) continue;
                const embedding = await embedText(q);
                const results = searchArchive(req.params.id, embedding, limit || 20, diversity);
                for (const r of results) allSceneIds.add(r.sceneId);
            }
            console.log(`[VectorStore] archive candidates for ${queries.length} queries: [${[...allSceneIds].join(', ')}]`);
            res.json({ sceneIds: [...allSceneIds] });
        } else {
            if (!query?.trim()) return res.json({ sceneIds: [] });
            const embedding = await embedText(query);
            const results = searchArchive(req.params.id, embedding, limit || 20, diversity);
            console.log(`[VectorStore] archive candidates for "${query.slice(0, 50)}": [${results.map(r => r.sceneId).join(', ')}]`);
            res.json({ sceneIds: results.map(r => r.sceneId) });
        }
    }));

    router.post('/api/campaigns/:id/lore/semantic-candidates', wrapAsync(async (req, res) => {
        // Non-blocking hot path: skip semantic while the model warms up or the lore
        // bulk embed (e.g. a fresh world import) is still running. The client degrades
        // to lexical (idf-rrf) retrieval, so turn 1 never stalls on indexing.
        if (!isModelReady() || isJobRunning(req.params.id, 'lore')) {
            return res.json({ loreIds: [], pending: true });
        }
        const { query, queries, limit, diversity = true } = req.body;
        if (queries && Array.isArray(queries) && queries.length > 0) {
            const allLoreIds = new Set();
            for (const q of queries) {
                if (!q?.trim()) continue;
                const embedding = await embedText(q);
                const results = searchLore(req.params.id, embedding, limit || 15, diversity);
                for (const r of results) allLoreIds.add(r.loreId);
            }
            console.log(`[VectorStore] lore candidates for ${queries.length} queries: [${[...allLoreIds].join(', ')}]`);
            res.json({ loreIds: [...allLoreIds] });
        } else {
            if (!query?.trim()) return res.json({ loreIds: [] });
            const embedding = await embedText(query);
            const results = searchLore(req.params.id, embedding, limit || 15, diversity);
            console.log(`[VectorStore] lore candidates for "${query.slice(0, 50)}": [${results.map(r => r.loreId).join(', ')}]`);
            res.json({ loreIds: results.map(r => r.loreId) });
        }
    }));

    // ─── Embedding Version Status ─────────────────────────────────────
    router.get('/api/campaigns/:id/embeddings/status', wrapAsync(async (req, res) => {
        const status = getEmbeddingStatus(req.params.id);
        res.json(status);
    }));

    // ─── Embedder Info (model, dims, version — global, not per-campaign) ──
    router.get('/api/embeddings/info', wrapAsync((_req, res) => {
        res.json({
            modelId: getActiveModelId(),
            dims: getActiveDims(),
            embeddingVersion: EMBEDDING_VERSION,
        });
    }));

    // ─── Re-index Embeddings (Backfill) ───────────────────────────────
    router.post('/api/campaigns/:id/embeddings/reindex', wrapAsync(async (req, res) => {
        const campaignId = req.params.id;
        const { type } = req.body; // 'scene' | 'lore' | 'all'

        console.log(`[Reindex] Starting reindex for campaign ${campaignId}, type=${type || 'all'}`);

        await warmup();

        const status = getEmbeddingStatus(campaignId);
        const db = getDb();
        const currentVersion = EMBEDDING_VERSION;

        let reindexedScenes = 0;
        let reindexedLore = 0;

        // ── Re-index stale scene embeddings ──
        if ((!type || type === 'all' || type === 'scene') && status.scenes.stale > 0) {
            const staleScenes = db.prepare(
                `SELECT item_id FROM embedding_meta WHERE campaign_id = ? AND item_type = 'scene' AND version < ?`
            ).all(campaignId, currentVersion);

            if (staleScenes.length > 0) {
                // Load archive index to get scene data
                const indexPath = archiveIndexPath(campaignId);
                const indexEntries = readJson(indexPath, []);
                const indexMap = new Map(indexEntries.map(e => [e.sceneId, e]));

                const sceneIds = staleScenes.map(r => r.item_id).filter(id => indexMap.has(id));
                const texts = sceneIds.map(id => buildArchiveText(indexMap.get(id)));
                const embeddings = await embedBatch(texts, 10, 100);

                for (let i = 0; i < sceneIds.length; i++) {
                    storeArchiveEmbedding(campaignId, sceneIds[i], embeddings[i]);
                    reindexedScenes++;
                }
                console.log(`[Reindex] Re-indexed ${reindexedScenes} scene embeddings`);
            }
        }

        // ── Re-index stale lore embeddings ──
        if ((!type || type === 'all' || type === 'lore') && status.lore.stale > 0) {
            const staleLore = db.prepare(
                `SELECT item_id FROM embedding_meta WHERE campaign_id = ? AND item_type = 'lore' AND version < ?`
            ).all(campaignId, currentVersion);

            if (staleLore.length > 0) {
                // Load lore chunks
                const lorePath = path.join(CAMPAIGNS_DIR, `${campaignId}.lore.json`);
                const loreChunks = readJson(lorePath, []);
                const loreMap = new Map(loreChunks.map(c => [c.id, c]));

                const loreIds = staleLore.map(r => r.item_id).filter(id => loreMap.has(id));
                const texts = loreIds.map(id => buildLoreText(loreMap.get(id)));
                const embeddings = await embedBatch(texts, 10, 100);

                for (let i = 0; i < loreIds.length; i++) {
                    storeLoreEmbedding(campaignId, loreIds[i], embeddings[i]);
                    reindexedLore++;
                }
                console.log(`[Reindex] Re-indexed ${reindexedLore} lore embeddings`);
            }
        }

        // ── Also find embeddings without meta (unversioned) ──
        const scenesNoMeta = (!type || type === 'all' || type === 'scene')
            ? db.prepare(`SELECT scene_id FROM archive_vss WHERE campaign_id = ? AND scene_id NOT IN (SELECT item_id FROM embedding_meta WHERE campaign_id = ? AND item_type = 'scene')`).all(campaignId, campaignId)
            : [];
        if (scenesNoMeta.length > 0) {
            const idxPath = archiveIndexPath(campaignId);
            const indexEntries = readJson(idxPath, []);
            const indexMap = new Map(indexEntries.map(e => [e.sceneId, e]));
            const ids = scenesNoMeta.map(r => r.scene_id).filter(id => indexMap.has(id));
            const texts = ids.map(id => buildArchiveText(indexMap.get(id)));
            const embeddings = await embedBatch(texts, 10, 100);
            for (let i = 0; i < ids.length; i++) {
                storeArchiveEmbedding(campaignId, ids[i], embeddings[i]);
                reindexedScenes++;
            }
            console.log(`[Reindex] Backfilled ${ids.length} unversioned scene embeddings`);
        }

        const loreNoMeta = (!type || type === 'all' || type === 'lore')
            ? db.prepare(`SELECT lore_id FROM lore_vss WHERE campaign_id = ? AND lore_id NOT IN (SELECT item_id FROM embedding_meta WHERE campaign_id = ? AND item_type = 'lore')`).all(campaignId, campaignId)
            : [];
        if (loreNoMeta.length > 0) {
            const lorePath = path.join(CAMPAIGNS_DIR, `${campaignId}.lore.json`);
            const loreChunks = readJson(lorePath, []);
            const loreMap = new Map(loreChunks.map(c => [c.id, c]));
            const ids = loreNoMeta.map(r => r.lore_id).filter(id => loreMap.has(id));
            const texts = ids.map(id => buildLoreText(loreMap.get(id)));
            const embeddings = await embedBatch(texts, 10, 100);
            for (let i = 0; i < ids.length; i++) {
                storeLoreEmbedding(campaignId, ids[i], embeddings[i]);
                reindexedLore++;
            }
            console.log(`[Reindex] Backfilled ${ids.length} unversioned lore embeddings`);
        }

        const newStatus = getEmbeddingStatus(campaignId);
        console.log(`[Reindex] Complete: ${reindexedScenes} scenes, ${reindexedLore} lore re-indexed`);
        res.json({ reindexedScenes, reindexedLore, status: newStatus });
    }));

    return router;
}
