// ─── LLM / AI Configuration ───────────────────────────────────────────────

export type ApiFormat = 'openai' | 'ollama' | 'claude' | 'gemini';

export type AiTier = 'lite' | 'pro' | 'max';

export type ThinkingEffort = 'off' | 'low' | 'medium' | 'high' | 'max';

export type EndpointConfig = {
    endpoint: string;
    apiKey: string;
    modelName: string;
    apiFormat?: ApiFormat;
    thinkingEffort?: ThinkingEffort;
};

export type SamplingConfig = {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    min_p?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    repetition_penalty?: number;
    dry_multiplier?: number;
    dry_base?: number;
    dry_allowed_length?: number;
    max_tokens?: number;
};

export type AIPreset = {
    id: string;
    name: string;
    storyAI: EndpointConfig;
    imageAI: EndpointConfig;
    summarizerAI: EndpointConfig;
    utilityAI?: EndpointConfig;
    auxiliaryAI?: EndpointConfig;
    sampling?: SamplingConfig;
};

export type ProviderConfig = {
    id: string;
    label: string;
    endpoint: string;
    apiKey: string;
    modelName: string;
};

export type AppSettings = {
    presets: AIPreset[];
    activePresetId: string;
    contextLimit: number;
    debugMode?: boolean;
    theme?: 'light' | 'dark';
    showReasoning?: boolean;
    deepContextSearch?: boolean;
    autoExtractDivergences?: boolean;
    divergenceTokenBudget?: number;
    divergenceScanBudget?: number;
    autoCondenseEnabled?: boolean;
    condenseAggressiveness?: 'tight' | 'smart' | 'deep';
    autoArchiveStaleNPCsTurns?: number;
    rulesBudgetPct?: number;               // fraction of context limit for rules RAG, default 0.10
    autoGenerateRuleKeywords?: boolean;    // default true; false = header+bold extraction only
    utilityTimeoutSeconds?: number;        // soft deadline for utility AI calls (default 45)
    verboseUtilityLogging?: boolean;
    enableArchivePlanner?: boolean;
    retrievalAlgorithm?: 'classic' | 'idf-rrf';
    archiveRecallDepth?: 'lean' | 'standard' | 'deep';  // archive recall ceiling; default 'standard' (desktop). 'lean' = mobile parity (3/4/5)
    matureMode?: boolean;            // default false; gates mature-tier NPC traits/wants (NPC Agency Phase 2)
    aiTier?: AiTier;                 // 'lite' | 'pro' | 'max' — gates which turn stages run (Phase 4)

    // Legacy fields kept for migration only
    providers?: ProviderConfig[];
    activeProviderId?: string;
    endpoint?: string;
    apiKey?: string;
    modelName?: string;
    imageApiEndpoint?: string;
    imageApiKey?: string;
    imageApiModel?: string;
};
