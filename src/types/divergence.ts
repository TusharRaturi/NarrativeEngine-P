// ─── Divergence / Continuity Tracking Types ──────────────────────────────

export type DivergenceCategory =
    | 'locations'
    | 'npc_events'
    | 'promises_debts'
    | 'world_state'
    | 'party_facts'
    | 'rules_lore'
    | 'misc';

export type DivergenceEntry = {
    id: string;
    chapterId: string;
    category: DivergenceCategory;
    text: string;
    sceneRef: string;
    npcIds: string[];
    knownBy?: string[];
    pinned: boolean;
    enabled?: boolean;
    source: 'auto' | 'manual';
    reviewFlag?: boolean;
    unrecognizedNpcNames?: string[];
};

export type TopicCluster = {
    id: string;
    name: string;
    factIds: string[];
};

export type TopicClusters = {
    groups: TopicCluster[];
    generatedAt: string;
    generatedFromFactCount: number;
};

export type DivergenceRegister = {
    entries: DivergenceEntry[];
    chapterToggles: Record<string, boolean>;
    categoryToggles: Record<string, Record<DivergenceCategory, boolean>>;
    prunedLog?: DivergenceEntry[];
    lastUpdatedSceneId: string;
    lastUpdatedAt: number;
    version: 2;
    topicClusters?: TopicClusters;
};
