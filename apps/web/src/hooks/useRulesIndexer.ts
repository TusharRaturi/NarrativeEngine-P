import { useEffect, useRef, useCallback } from 'react';
import { useAppStore } from '../store/useAppStore';
import { indexRules } from '../services/rules/rulesIndexer';
import { countTokens } from '../services/infrastructure/tokenizer';
import type { RuleChunkMeta } from '../types';

function fnv1a(str: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

export function useRulesIndexer() {
    const rulesRaw = useAppStore((s) => s.context.rulesRaw);
    const rulesChunkMeta = useAppStore((s) => s.context.rulesChunkMeta);
    const rulesRawHash = useAppStore((s) => s.context.rulesRawHash);
    const updateContext = useAppStore((s) => s.updateContext);
    const activeCampaignId = useAppStore((s) => s.activeCampaignId);
    const settings = useAppStore((s) => s.settings);
    const autoGenerate = settings.autoGenerateRuleKeywords ?? true;
    const getUtilityEndpoint = useAppStore((s) => s.getActiveUtilityEndpoint);
    const setIsIndexingRules = useAppStore((s) => s.setIsIndexingRules);
    const setIndexingRulesProgress = useAppStore((s) => s.setIndexingRulesProgress);

    const lastIndexedHash = useRef<string>('');
    const indexingRef = useRef(false);
    const rulesChunkMetaRef = useRef(rulesChunkMeta);
    useEffect(() => {
        rulesChunkMetaRef.current = rulesChunkMeta;
    }, [rulesChunkMeta]);

    useEffect(() => {
        lastIndexedHash.current = rulesRawHash || '';
    }, [rulesRawHash]);

    const runIndex = useCallback(async () => {
        if (!activeCampaignId || !rulesRaw || indexingRef.current) return;

        // threshold value removed as it was unused
        const tokenCount = countTokens(rulesRaw);

        const hash = `${rulesRaw.length}_${tokenCount}_${fnv1a(rulesRaw)}`;
        if (hash === lastIndexedHash.current) return;

        indexingRef.current = true;
        lastIndexedHash.current = hash;
        setIsIndexingRules(true);
        setIndexingRulesProgress(null);

        try {
            const utilityEndpoint = getUtilityEndpoint();
            const result = await indexRules(
                activeCampaignId,
                rulesRaw,
                rulesChunkMetaRef.current || {},
                utilityEndpoint?.endpoint ? utilityEndpoint : undefined,
                autoGenerate,
                setIndexingRulesProgress
            );
            updateContext({ 
                rulesChunkMeta: { ...(rulesChunkMetaRef.current as Record<string, RuleChunkMeta> || {}), ...result.chunkMeta },
                rulesChunks: result.chunks,
                rulesRawHash: hash
            });
            console.log(`[RulesIndexer] Auto-indexed ${result.chunks.length} rule chunk(s)`);
        } catch (e) {
            console.warn('[RulesIndexer] Auto-indexing failed:', e);
        } finally {
            indexingRef.current = false;
            setIsIndexingRules(false);
            setIndexingRulesProgress(null);
        }
    }, [activeCampaignId, rulesRaw, autoGenerate, getUtilityEndpoint, updateContext, setIsIndexingRules, setIndexingRulesProgress]);

    useEffect(() => {
        const timer = setTimeout(() => {
            runIndex();
        }, 3000);
        return () => clearTimeout(timer);
    }, [runIndex]);
}
