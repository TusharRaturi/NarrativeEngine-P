import { useState } from 'react';
import { saveCampaign } from '../../store/campaignStore';
import { initializeCampaignState } from '../../services/campaignInit';
import { uid } from '../../utils/uid';
import type { Campaign } from '../../types';

export function useCampaignForm(params: {
    editingCampaign: Campaign | null;
    setEditingCampaign: (c: Campaign | null) => void;
    onDone: () => void;
}) {
    const { editingCampaign, setEditingCampaign, onDone } = params;

    const [name, setName] = useState('');
    const [coverFile, setCoverFile] = useState<File | null>(null);
    const [coverPreview, setCoverPreview] = useState('');
    const [loreFile, setLoreFile] = useState<File | null>(null);
    const [loreName, setLoreName] = useState('');
    const [rulesFile, setRulesFile] = useState<File | null>(null);
    const [rulesName, setRulesName] = useState('');
    const [lootFile, setLootFile] = useState<File | null>(null);
    const [lootName, setLootName] = useState('');

    const resetForm = () => {
        setName(''); setCoverFile(null); setCoverPreview('');
        setLoreFile(null); setLoreName('');
        setRulesFile(null); setRulesName('');
        setLootFile(null); setLootName('');
        setEditingCampaign(null);
    };

    const openCreate = () => { resetForm(); };

    const openEdit = (campaign: Campaign) => {
        setEditingCampaign(campaign);
        setName(campaign.name);
        setCoverPreview(campaign.coverImage || '');
        setLoreName(''); setRulesName(''); setLootName('');
        setLoreFile(null); setRulesFile(null); setLootFile(null); setCoverFile(null);
    };

    const handleCoverChange = (file: File) => {
        setCoverFile(file);
        const reader = new FileReader();
        reader.onload = (e) => setCoverPreview(e.target?.result as string);
        reader.readAsDataURL(file);
    };

    const handleSave = async () => {
        if (!name.trim()) return;
        const isEdit = !!editingCampaign;
        const campaign: Campaign = isEdit
            ? { ...editingCampaign!, name: name.trim(), lastPlayedAt: Date.now() }
            : {
                id: uid(),
                name: name.trim(), coverImage: '',
                createdAt: Date.now(), lastPlayedAt: Date.now(),
            };

        if (coverFile) campaign.coverImage = coverPreview;
        else if (isEdit) campaign.coverImage = coverPreview;

        await saveCampaign(campaign);
        await initializeCampaignState({ campaignId: campaign.id, loreFile, rulesFile, lootFile });

        resetForm();
        onDone();
    };

    const clearCover = () => { setCoverFile(null); setCoverPreview(''); };

    return {
        name, setName,
        coverFile, coverPreview, handleCoverChange, clearCover,
        loreFile, setLoreFile, loreName, setLoreName,
        rulesFile, setRulesFile, rulesName, setRulesName,
        lootFile, setLootFile, lootName, setLootName,
        resetForm, openCreate, openEdit, handleSave,
        editingCampaign,
    };
}
