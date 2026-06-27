import { useState } from 'react';
import type { ChatMessage } from '../../types';
import { api } from '../../services/llm/apiClient';
import type { ArchiveManagerDeps } from '../../services/archive-memory/archiveManager';

interface UseMessageEditorDeps {
    messages: ChatMessage[];
    input: string;
    setInput: (v: string) => void;
    inputRef: React.RefObject<HTMLTextAreaElement | null>;
    resetTextareaHeight: () => void;
    rollbackArchive: (timestamp: number) => Promise<void>;
    deleteMessagesFrom: (id: string) => void;
    updateMessageContent: (id: string, content: string) => void;
    onAfterEdit: (text: string) => void;
    onAfterRegenerate: (text: string) => void;
    // WO-F (2be3ad5) — surgical scene delete + edit-sync deps.
    activeCampaignId: string | null;
    deleteMessage: (id: string) => void;
    archiveDeps: Pick<ArchiveManagerDeps, 'setArchiveIndex' | 'setTimeline' | 'setChapters'>;
}

/**
 * WO-F (2be3ad5) — map an on-screen message to its archived sceneId. Main stamps the sceneId
 * directly onto the assistant message in the post-turn pipeline (see postTurnPipeline.ts), so
 * this is a direct read. Returns null for user messages, pre-WO-F saves, and un-archived turns.
 */
export function findSceneIdForMessage(messages: ChatMessage[], messageId: string): string | null {
    const msg = messages.find(m => m.id === messageId);
    return msg?.sceneId ?? null;
}

export function useMessageEditor(deps: UseMessageEditorDeps) {
    const [editingMessageId, setEditingMessageId] = useState<string | null>(null);

    const startEditing = (msg: ChatMessage) => {
        setEditingMessageId(msg.id);
        deps.setInput(msg.displayContent || msg.content);
        deps.inputRef.current?.focus();
    };

    const cancelEditing = () => {
        setEditingMessageId(null);
        deps.setInput('');
    };

    const handleEditSubmit = () => {
        if (!editingMessageId) return;
        const msg = deps.messages.find(m => m.id === editingMessageId);
        if (!msg) return;

        if (msg.role === 'user') {
            deps.rollbackArchive(msg.timestamp);
            deps.deleteMessagesFrom(msg.id);
            const textToResend = deps.input.trim();
            deps.setInput('');
            deps.resetTextareaHeight();
            setEditingMessageId(null);
            setTimeout(() => {
                deps.onAfterEdit(textToResend);
            }, 50);
        } else {
            deps.updateMessageContent(msg.id, deps.input.trim());
            // WO-F — sync the edited GM text into long-term memory so the AI stops recalling the
            // old version. Fire-and-forget; non-fatal if it fails (the on-screen edit still holds).
            syncEditedSceneText(msg.id, deps.input.trim());
            deps.setInput('');
            deps.resetTextareaHeight();
            setEditingMessageId(null);
        }
    };

    const handleRegenerate = (id: string) => {
        const msgs = deps.messages;
        const idx = msgs.findIndex(m => m.id === id);
        if (idx === -1) return;

        const prevMsgs = msgs.slice(0, idx);
        const lastUser = [...prevMsgs].reverse().find(m => m.role === 'user');

        if (lastUser) {
            deps.rollbackArchive(lastUser.timestamp);
            deps.deleteMessagesFrom(lastUser.id);
            setTimeout(() => {
                deps.onAfterRegenerate(lastUser.displayContent || lastUser.content);
            }, 50);
        }
    };

    // WO-F — surgical scene delete. Removes the GM/user bubble from chat AND deletes the
    // underlying archived scene (re-threading chapters, no full rebuild), so the AI stops
    // recalling deleted text. Falls back to a plain on-screen delete when the message has no
    // sceneId (un-archived turn / pre-WO-F save).
    const handleDeleteOutput = async (id: string) => {
        deps.deleteMessage(id);
        const sceneId = findSceneIdForMessage(deps.messages, id);
        if (!sceneId || !deps.activeCampaignId) return;
        try {
            await api.backups.create(deps.activeCampaignId, { trigger: 'pre-scene-delete', isAuto: true }).catch(() => { });
            await api.archive.deleteScene(deps.activeCampaignId, sceneId);
            const [freshIndex, freshTimeline, freshChapters] = await Promise.all([
                api.archive.getIndex(deps.activeCampaignId),
                api.timeline.get(deps.activeCampaignId),
                api.chapters.list(deps.activeCampaignId).catch(() => []),
            ]);
            deps.archiveDeps.setArchiveIndex(freshIndex);
            deps.archiveDeps.setTimeline(freshTimeline);
            deps.archiveDeps.setChapters(freshChapters);
            console.log(`[Archive] Surgically deleted scene #${sceneId}`);
        } catch (err) {
            console.warn('[Archive] Scene delete failed (on-screen message still removed):', err);
        }
    };

    // WO-F — sync an edited GM reply into the archive (rewrite scene text + rebuild index + re-embed).
    const syncEditedSceneText = async (messageId: string, newAssistant: string) => {
        if (!deps.activeCampaignId) return;
        const sceneId = findSceneIdForMessage(deps.messages, messageId);
        if (!sceneId) return;
        try {
            await api.archive.updateSceneAssistant(deps.activeCampaignId, sceneId, newAssistant);
            const freshIndex = await api.archive.getIndex(deps.activeCampaignId);
            deps.archiveDeps.setArchiveIndex(freshIndex);
        } catch (err) {
            console.warn('[Archive] Scene edit-sync failed (on-screen edit still holds):', err);
        }
    };

    return {
        editingMessageId,
        startEditing,
        cancelEditing,
        handleEditSubmit,
        handleRegenerate,
        handleDeleteOutput,
    };
}