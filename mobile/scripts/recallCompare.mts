/**
 * recallCompare.mts
 *
 * Before/after comparison of archive recall on the live campaign.
 * Exercises the keyword/IDF change; embedding fusion validated by unit tests.
 *
 * Run: npx tsx scripts/recallCompare.mts
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { computeArchiveIdf, clearIdfCache, retrieveArchiveMemory, fuseRecall } from '../src/services/archive/archiveMemory';
import type { ArchiveIndexEntry } from '../src/types';

const CAMPAIGN_PATH = join(process.cwd(), 'data', 'campaigns', 'mlz1swdmzkgy0.json');

interface CampaignData {
    archiveIndex?: ArchiveIndexEntry[];
    [k: string]: unknown;
}

function loadCampaign(): ArchiveIndexEntry[] | null {
    try {
        const raw = readFileSync(CAMPAIGN_PATH, 'utf-8');
        const data: CampaignData = JSON.parse(raw);
        return data.archiveIndex ?? null;
    } catch {
        return null;
    }
}

function runOldScoring(
    index: ArchiveIndexEntry[],
    contextText: string,
    contextActivations: Record<string, number>,
): { sceneId: string; score: number }[] {
    const totalScenes = index.length;
    const scores: { sceneId: string; score: number }[] = [];

    for (const entry of index) {
        let activation = 0;
        const kwStrengths = entry.keywordStrengths ?? {};
        for (const [keyword, strength] of Object.entries(kwStrengths)) {
            if (contextActivations[keyword]) {
                activation += contextActivations[keyword] * strength;
            }
        }
        const npcStrengths = entry.npcStrengths ?? {};
        for (const [npc, strength] of Object.entries(npcStrengths)) {
            if (contextActivations[npc]) {
                activation += contextActivations[npc] * strength * 1.5;
            }
        }

        if (entry.events && entry.events.length > 0) {
            let eventActivation = 0;
            for (const event of entry.events) {
                const eventImportanceScale = (event.importance ?? 5) / 10;
                let perEvent = 0;
                for (const name of (event.characters ?? [])) {
                    const key = name.toLowerCase();
                    if (contextActivations[key]) perEvent += contextActivations[key] * 1.5;
                }
                for (const fieldNames of [event.locations ?? [], event.items ?? [], event.concepts ?? []]) {
                    for (const name of fieldNames) {
                        const key = name.toLowerCase();
                        if (contextActivations[key]) perEvent += contextActivations[key] * 1.0;
                    }
                }
                eventActivation += perEvent * eventImportanceScale;
            }
            activation += Math.min(15, eventActivation);
        }

        if (Object.keys(kwStrengths).length === 0 && Object.keys(npcStrengths).length === 0 && !(entry.events && entry.events.length > 0)) {
            for (const kw of entry.keywords) {
                if (contextText.includes(kw)) {
                    activation += 2;
                }
            }
            for (const npc of entry.npcsMentioned) {
                if (contextText.includes(npc.toLowerCase())) activation += 3;
            }
        }

        const sceneNum = parseInt(entry.sceneId, 10) || 0;
        const turnsSince = totalScenes - sceneNum;
        const halfLife = Math.max(40, 0.2 * totalScenes);
        const recencyBonus = Math.pow(0.5, Math.max(0, turnsSince) / halfLife);
        const importance = entry.importance ?? 5;
        const score = (0.5 * recencyBonus) + (1.0 * importance) + (2.0 * activation);

        scores.push({ sceneId: entry.sceneId, score });
    }

    return scores
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score);
}

function extractActivations(text: string): Record<string, number> {
    const activations: Record<string, number> = {};
    const words = text.toLowerCase().match(/[a-z]{2,}/g) || [];
    for (const word of words) activations[word] = 1.0;
    const properNouns = text.match(/[A-Z][A-Za-z]{1,}(?:\s[A-Z][A-Za-z]{1,})*/g) || [];
    for (const noun of properNouns) activations[noun.toLowerCase()] = 1.0;
    return activations;
}

const QUERIES = [
    'I want to find the obelisk we discovered near the ruins',
    'What happened when we fought the dragon?',
    'Tell me about the old merchant we met',
    'Remember when we made the promise to the king',
    'What do we know about the shadow cult?',
];

function main() {
    const index = loadCampaign();
    if (!index) {
        console.error('Could not load campaign archive index from', CAMPAIGN_PATH);
        process.exit(1);
    }

    console.log(`Loaded ${index.length} archive entries.\n`);

    clearIdfCache();
    const idf = computeArchiveIdf(index);
    const topIdfTerms = Object.entries(idf)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20);
    console.log('Top 20 highest-IDF terms:');
    for (const [term, val] of topIdfTerms) {
        console.log(`  ${term}: ${val.toFixed(3)}`);
    }
    console.log();

    const botIdfTerms = Object.entries(idf)
        .sort((a, b) => a[1] - b[1])
        .slice(0, 10);
    console.log('Bottom 10 lowest-IDF terms (most common):');
    for (const [term, val] of botIdfTerms) {
        console.log(`  ${term}: ${val.toFixed(3)}`);
    }
    console.log();

    for (const query of QUERIES) {
        console.log('='.repeat(60));
        console.log(`Query: "${query}"`);
        console.log('-'.repeat(60));

        const contextText = query.toLowerCase();
        const contextActivations = extractActivations(query);

        const oldScores = runOldScoring(index, contextText, contextActivations);
        const oldTop = oldScores.slice(0, 5).map(s => `${s.sceneId}(${s.score.toFixed(1)})`);

        clearIdfCache();
        const newIds = retrieveArchiveMemory(index, query, [], undefined, 5);
        const newTop = newIds.map(id => {
            const entry = index.find(e => e.sceneId === id);
            return `${id}`;
        });

        console.log(`  OLD: ${oldTop.join(', ')}`);
        console.log(`  NEW: ${newTop.join(', ')}`);

        const oldSet = new Set(oldScores.slice(0, 5).map(s => s.sceneId));
        const newSet = new Set(newIds);
        const added = [...newSet].filter(id => !oldSet.has(id));
        const removed = [...oldSet].filter(id => !newSet.has(id));
        if (added.length) console.log(`  ADDED: ${added.join(', ')}`);
        if (removed.length) console.log(`  REMOVED: ${removed.join(', ')}`);
        console.log();
    }
}

main();