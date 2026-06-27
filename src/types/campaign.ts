// ─── Campaign / Chat Types ────────────────────────────────────────────────

export type ChatMessage = {
    id: string;
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    displayContent?: string;
    timestamp: number;
    debugPayload?: unknown;
    name?: string;
    tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
    }[];
    tool_call_id?: string;
    reasoning_content?: string;
    ephemeral?: boolean;
    divergenceIds?: string[];
    /** WO-F (2be3ad5) — the archive scene id this message's GM reply was archived under.
     *  Set by the post-turn pipeline after archive append. Used by the surgical-delete + edit-sync
     *  UI hooks to map an on-screen message back to its long-term-memory scene. Undefined for
     *  user messages, pre-WO-F saves, and turns that were never archived. */
    sceneId?: string;
};

export type Campaign = {
    id: string;
    name: string;
    coverImage: string; // base64 data URL
    createdAt: number;
    lastPlayedAt: number;
};

export type PinnedExcerpt = {
    id: string;
    sourceMessageId: string;
    text: string;
    createdAt: number;
    isFullMessage: boolean;
};
