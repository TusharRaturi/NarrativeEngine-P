import { useMemo } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';
import { countTokens } from '../services/tokenizer';
import { DEFAULT_RULES } from '../services/rules/defaultRules';
import {
    minifyBookkeepingStub,
} from '../services/contextMinifier';
import { countRegisterTokens } from '../services/divergenceRegister';

export function TokenGauge() {
    const { context, settings, condenser, inventoryItems, characterProfileData, divergenceRegister } = useAppStore(
        useShallow(s => ({
            context: s.context,
            settings: s.settings,
            condenser: s.condenser,
            inventoryItems: s.inventoryItems ?? s.context.inventoryItems ?? [],
            characterProfileData: s.characterProfileData ?? s.context.characterProfileData ?? null,
            divergenceRegister: s.divergenceRegister,
        }))
    );
    const messages = useAppStore(s => s.messages);

    const legacyProfile = context.characterProfileActive && context.characterProfile ? context.characterProfile : '';
    const legacyInventory = context.inventoryActive && context.inventory ? context.inventory : '';

    const systemText = useMemo(() => {
        const parts: string[] = [];
        if (context.loreRaw) parts.push(context.loreRaw);
        if (context.rulesRaw || DEFAULT_RULES) parts.push(context.rulesRaw || DEFAULT_RULES);
        if (context.canonStateActive && context.canonState) parts.push(context.canonState);
        if (context.headerIndexActive && context.headerIndex) parts.push(context.headerIndex);
        if (context.starterActive && context.starter) parts.push(context.starter);
        if (context.continuePromptActive && context.continuePrompt) parts.push(context.continuePrompt);

        if (context.smartBookkeepingActive && characterProfileData) {
            const stub = minifyBookkeepingStub(characterProfileData, inventoryItems || []);
            if (stub) parts.push(`[CHARACTER]\n${stub}`);
        } else if (legacyProfile) {
            parts.push(`[CHARACTER PROFILE]\n${legacyProfile}`);
        }

        if (!context.smartBookkeepingActive && legacyInventory) {
            parts.push(`[PLAYER INVENTORY]\n${legacyInventory}`);
        }

        return parts.join('\n\n');
    }, [context, characterProfileData, inventoryItems, legacyProfile, legacyInventory]);

    const systemTokens = useMemo(() => countTokens(systemText), [systemText]);

    const registerTokens = useMemo(() => {
        if (!divergenceRegister || divergenceRegister.entries.length === 0) return 0;
        return countRegisterTokens(divergenceRegister);
    }, [divergenceRegister]);

    const adjustedSystemTokens = systemTokens + registerTokens;

    const historyText = useMemo(() => {
        const activeMessages = (condenser.condensedUpToIndex !== undefined && condenser.condensedUpToIndex >= 0)
            ? messages.slice(condenser.condensedUpToIndex + 1)
            : messages;
        return activeMessages.map((m) => m.content || '').join('');
    }, [messages, condenser.condensedUpToIndex]);

    const historyTokens = useMemo(() => countTokens(historyText), [historyText]);

    const total = settings.contextLimit;
    const remaining = Math.max(0, total - adjustedSystemTokens - historyTokens);

    const pctSystem = Math.min((adjustedSystemTokens / total) * 100, 100);
    const pctHistory = Math.min((historyTokens / total) * 100, 100 - pctSystem);
    const pctFree = 100 - pctSystem - pctHistory;

    return (
        <div className="flex items-center gap-3 flex-1 min-w-0 px-3">
            <span className="text-[10px] text-text-dim uppercase tracking-widest shrink-0">
                CTX
            </span>

            <div className="flex-1 h-3 bg-void-lighter border border-border relative overflow-hidden">
                <div
                    className="absolute inset-y-0 left-0 bg-ember transition-all duration-300"
                    style={{ width: `${pctSystem}%` }}
                />
                <div
                    className="absolute inset-y-0 bg-ice transition-all duration-300"
                    style={{ left: `${pctSystem}%`, width: `${pctHistory}%` }}
                />
                <div
                    className="absolute inset-y-0 bg-void-light transition-all duration-300"
                    style={{ left: `${pctSystem + pctHistory}%`, width: `${pctFree}%` }}
                />
            </div>

            <div className="flex gap-3 text-[10px] shrink-0">
                <span className="text-ember">SYS:{adjustedSystemTokens}{registerTokens > 0 ? <span className="text-amber-400">(+{registerTokens})</span> : ''}</span>
                <span className="text-ice">HIS:{historyTokens}</span>
                <span className="text-text-dim">FREE:{remaining}</span>
            </div>
        </div>
    );
}
