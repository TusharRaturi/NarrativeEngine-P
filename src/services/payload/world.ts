import type { ChatMessage, GameContext, LoreChunk, NPCEntry, ArchiveScene, ArchiveIndexEntry, TimelineEvent, DivergenceRegister, ArchiveChapter } from '../../types';
import { countTokens } from '../tokenizer';
import { buildBehaviorDirective, buildDriftAlert, buildKnowledgeBoundary } from '../npcBehaviorDirective';
import { minifyLoreChunk, minifyNPC } from '../contextMinifier';
import { resolveTimeline, formatResolvedForContext } from '../timelineResolver';
import { renderRegisterForPayload } from '../divergenceRegister';
import type { TraceCollector } from './traceCollector';

function computeNPCSalience(npc: NPCEntry, scanText: string): number {
    let score = 0;
    const lower = scanText.toLowerCase();
    const name = npc.name.toLowerCase();
    const aliases = (npc.aliases || '').split(',').map(a => a.trim().toLowerCase()).filter(Boolean);
    const patterns = [name, ...aliases];

    for (const p of patterns) {
        const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped, 'g');
        const matches = lower.match(regex);
        if (matches) score += matches.length * 2;
    }

    if (npc.drives?.sceneWant) score += 1;
    if (npc.pressure?.engaged) score += npc.pressure.engaged * 1.5;
    if (npc.pressure?.ignored) score += npc.pressure.ignored * 2;

    if (npc.behavioralTriggers) {
        for (const trigger of npc.behavioralTriggers) {
            if (lower.includes(trigger.keyword.toLowerCase())) score += 4;
        }
    }

    return score;
}

export function buildWorld(opts: {
    history: ChatMessage[];
    userMessage: string;
    condensedUpToIndex?: number;
    relevantLore?: LoreChunk[];
    npcLedger?: NPCEntry[];
    archiveRecall?: ArchiveScene[];
    recommendedNPCNames?: string[];
    semanticFactText?: string;
    archiveIndex?: ArchiveIndexEntry[];
    timelineEvents?: TimelineEvent[];
    deepContextSummary?: string;
    divergenceRegister?: DivergenceRegister;
    chapters?: ArchiveChapter[];
    onStageNpcIds?: string[];
    loreRaw?: string;
    budgetWorld: number;
    isDebug: boolean;
    collector: TraceCollector;
}): { worldContent: string; currentWorldTokens: number } {
    const {
        history,
        userMessage,
        condensedUpToIndex,
        relevantLore,
        npcLedger,
        archiveRecall,
        recommendedNPCNames,
        semanticFactText,
        archiveIndex,
        timelineEvents,
        deepContextSummary,
        divergenceRegister,
        chapters,
        onStageNpcIds,
        loreRaw,
        budgetWorld,
        isDebug,
        collector,
    } = opts;

    // --- 3. Gather trimmable World Context (Medium Priority) ---
    const worldBlocks: { source: string; content: string; tokens: number; reason: string }[] = [];

    // Archive Recall
    if (archiveRecall && archiveRecall.length > 0) {
        // Simple dedupe against active history
        const activeAssistantContents = history
            .slice((condensedUpToIndex ?? -1) + 1)
            .filter(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.length > 20)
            .map(m => m.content as string);

        let filteredRecall = archiveRecall.filter(scene => {
            if (activeAssistantContents.some(asst => scene.content.includes(asst))) return false;
            return true;
        });

        // Perceptual archive filtering: only include scenes witnessed by active NPCs
        if (archiveIndex && npcLedger && archiveIndex.some(e => e.witnesses && e.witnesses.length > 0)) {
            const activeNpcIds = new Set(
                npcLedger.filter(n => !n.archived).map(n => n.id)
            );
            if (onStageNpcIds) {
                for (const id of onStageNpcIds) activeNpcIds.add(id);
            }
            const sceneWitnessMap = new Map(archiveIndex.map(e => [e.sceneId, e.witnesses]));
            filteredRecall = filteredRecall.filter(scene => {
                const witnesses = sceneWitnessMap.get(scene.sceneId);
                if (!witnesses || witnesses.length === 0) return true; // broadcast — no witness data
                return witnesses.some(w => activeNpcIds.has(w));
            });
            if (isDebug) {
                const filtered = archiveRecall.length - filteredRecall.length;
                if (filtered > 0) collector.addTrace({ source: 'Archive Recall', classification: 'world_context', tokens: 0, reason: `Perceptual filter removed ${filtered} scenes (not witnessed by active NPCs)`, included: false });
            }
        }

        if (filteredRecall.length > 0) {
            const text = `[ARCHIVE RECALL — VERBATIM PAST SCENES]\n${filteredRecall.map(s => `[SCENE #${s.sceneId}]\n${s.content}`).join('\n\n')}\n[END ARCHIVE RECALL]`;
            worldBlocks.push({ source: 'Archive Recall', content: text, tokens: countTokens(text), reason: `Verbatim history (${filteredRecall.length} scenes)` });
        }
    }

    // Deep Archive Context
    if (deepContextSummary) {
        const text = `[DEEP ARCHIVE CONTEXT — AI-synthesized from full campaign history]\n${deepContextSummary}\n[END DEEP ARCHIVE CONTEXT]`;
        worldBlocks.push({ source: 'Deep Archive Context', content: text, tokens: countTokens(text), reason: 'Deep archive scan result' });
    }

    // RAG Lore — minified and grouped by category
    if (relevantLore && relevantLore.length > 0) {
        const grouped = new Map<string, string[]>();
        for (const chunk of relevantLore) {
            const cat = chunk.category || 'misc';
            const catTitle = cat === 'faction' ? 'FACTIONS'
                           : cat === 'character' ? 'CHARACTERS'
                           : cat === 'location' ? 'LOCATIONS'
                           : cat === 'power_system' || cat === 'rules' ? 'POWER SYSTEM & RULES'
                           : cat === 'economy' ? 'ECONOMY'
                           : cat === 'event' ? 'EVENTS'
                           : cat === 'world_overview' ? 'OVERVIEW'
                           : 'MISCELLANEOUS';

            if (!grouped.has(catTitle)) grouped.set(catTitle, []);
            grouped.get(catTitle)!.push(minifyLoreChunk(chunk));
        }

        const sections: string[] = [];
        for (const [title, chunks] of grouped.entries()) {
            sections.push(`[${title}]\n` + chunks.join('\n'));
        }

        const text = `[WORLD LORE — RELEVANT SECTIONS]\n${sections.join('\n\n')}\n[END WORLD LORE]`;
        worldBlocks.push({ source: 'RAG Lore', content: text, tokens: countTokens(text), reason: `RAG injected (${relevantLore.length} chunks, minified)` });
    } else if (loreRaw) {
        worldBlocks.push({ source: 'Raw Lore (Legacy)', content: loreRaw, tokens: countTokens(loreRaw), reason: 'Legacy fallback' });
    }

    // Resolved World State (Timeline)
    if (timelineEvents && timelineEvents.length > 0) {
        const resolved = resolveTimeline(timelineEvents);
        if (resolved.length > 0) {
            const resolvedText = formatResolvedForContext(resolved);
            worldBlocks.push({
                source: 'Resolved World State',
                content: resolvedText,
                tokens: countTokens(resolvedText),
                reason: `Timeline resolution: ${resolved.length} active truths from ${timelineEvents.length} events`
            });
        }
    }

    // Active NPCs
    if (npcLedger && npcLedger.length > 0) {
        const loreHeadersSet = new Set((relevantLore ?? []).filter(l => l.header).map(l => l.header!.toLowerCase()));

        let activeNPCs: NPCEntry[];

        if (recommendedNPCNames && recommendedNPCNames.length > 0) {
            // ── Utility AI Recommender mode ──
            // Use the pre-computed list from contextRecommender.ts
            const recommendedSet = new Set(recommendedNPCNames.map(n => n.toLowerCase()));
            activeNPCs = npcLedger.filter(npc => {
                if (npc.archived) return false;
                if (!npc.name || loreHeadersSet.has(npc.name.toLowerCase())) return false;
                const aliases = (npc.aliases || '').split(',').map(a => a.trim().toLowerCase()).filter(Boolean);
                const allNames = [npc.name.toLowerCase(), ...aliases];
                return allNames.some(n => recommendedSet.has(n));
            });
            console.log(`[PayloadBuilder] NPC selection via UtilityAI recommender: ${activeNPCs.length} active.`);
        } else {
            // ── Legacy substring scan mode ──
            const scanHistory = history.slice(-10).map(m => m.content || '').join(' ') + ' ' + userMessage;
            activeNPCs = npcLedger.filter(npc => {
                if (npc.archived) return false;
                if (!npc.name || loreHeadersSet.has(npc.name.toLowerCase())) return false;
                const aliases = (npc.aliases || '').split(',').map(a => a.trim().toLowerCase()).filter(Boolean);
                const patterns = [npc.name.toLowerCase(), ...aliases];
                return patterns.some(p => scanHistory.toLowerCase().includes(p));
            });
        }

        if (activeNPCs.length > 0) {
            const scanText = history.slice(-10).map(m => m.content || '').join(' ') + ' ' + userMessage;
            const scored = activeNPCs.map(npc => ({ npc, score: computeNPCSalience(npc, scanText) }));
            scored.sort((a, b) => b.score - a.score);
            const spotlitNpc = scored[0].npc;

            const npcLines = activeNPCs.map(npc => {
                const isSpotlit = npc.id === spotlitNpc.id;
                let line = minifyNPC(npc);
                const directive = buildBehaviorDirective(npc);
                if (directive) line += ` | ${directive}`;

                if (isSpotlit && npc.drives) {
                    const driveParts: string[] = [];
                    if (npc.drives.coreWant) driveParts.push(`CoreWant: ${npc.drives.coreWant}`);
                    if (npc.drives.sessionWant) driveParts.push(`SessionWant: ${npc.drives.sessionWant}`);
                    if (npc.drives.sceneWant) driveParts.push(`SceneWant: ${npc.drives.sceneWant}`);
                    if (driveParts.length) line += `\n  DRIVES: ${driveParts.join(' | ')}`;
                }

                if (isSpotlit && npc.behavioralTriggers && npc.behavioralTriggers.length > 0) {
                    const triggerTexts = npc.behavioralTriggers.map(t => `if "${t.keyword}" → ${t.shift}`);
                    line += `\n  TRIGGERS: ${triggerTexts.join('; ')}`;
                }

                if (isSpotlit && npc.hardBoundaries && npc.hardBoundaries.length > 0) {
                    line += `\n  HARD LIMITS: ${npc.hardBoundaries.join('; ')}`;
                }
                if (isSpotlit && npc.softBoundaries && npc.softBoundaries.length > 0) {
                    line += `\n  SOFT LIMITS: ${npc.softBoundaries.join('; ')}`;
                }

                const drift = buildDriftAlert(npc);
                if (drift) line += ` | ${drift}`;
                if (archiveIndex) {
                    const boundary = buildKnowledgeBoundary(npc, archiveIndex);
                    if (boundary) line += `\n  ${boundary}`;
                }
                return line;
            });

            const npcText = `[ACTIVE NPC CONTEXT]\n${npcLines.join('\n')}\n[END NPC CONTEXT]`;
            worldBlocks.push({ source: 'Active NPCs', content: npcText, tokens: countTokens(npcText), reason: `NPCs detected in context (${activeNPCs.length}, spotlit: ${spotlitNpc.name})` });
        }
    }

    // Divergence Register
    if (divergenceRegister && divergenceRegister.entries.length > 0) {
        const regText = renderRegisterForPayload(divergenceRegister, chapters, onStageNpcIds, npcLedger);
        if (regText) {
            worldBlocks.push({ source: 'Established Facts', content: regText, tokens: countTokens(regText), reason: `Campaign facts (${divergenceRegister.entries.length} entries)` });
        }
    }

    if (semanticFactText) {
        worldBlocks.push({ source: 'Semantic Facts', content: semanticFactText, tokens: countTokens(semanticFactText), reason: 'Injected verified facts' });
    }

    // --- 4. Budget & Trim World Context ---
    let worldContent = '';
    let currentWorldTokens = 0;
    for (const block of worldBlocks) {
        if (currentWorldTokens + block.tokens <= budgetWorld) {
            worldContent += (worldContent ? '\n\n' : '') + block.content;
            currentWorldTokens += block.tokens;
            collector.addTrace({ source: block.source, classification: 'world_context', tokens: block.tokens, reason: block.reason, included: true, position: 'system_dynamic' });
            collector.addSection({ label: block.source, role: 'system', tokens: block.tokens, content: block.content, classification: 'world_context' });
        } else {
            collector.addTrace({ source: block.source, classification: 'world_context', tokens: block.tokens, reason: `Dropped: Exceeds World budget (${budgetWorld} t)`, included: false, position: 'system_dynamic' });
        }
    }

    return { worldContent, currentWorldTokens };
}
