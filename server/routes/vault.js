import { Router } from 'express';
import { KeyVault } from '../vault.js';

export function createVaultRouter(vault) {
    const router = Router();

    router.get('/api/vault/status', (_req, res) => {
        res.json({
            exists: vault.exists(),
            unlocked: vault.isUnlocked(),
            hasRemember: vault.hasRememberedKey()
        });
    });

    router.post('/api/vault/setup', (req, res) => {
        try {
            const { password, presets } = req.body;

            if (vault.exists()) {
                return res.status(400).json({ error: 'Vault already exists' });
            }

            // Create vault with initial data
            const initialData = { presets: presets || [] };
            vault.create(initialData, password);

            res.json({ ok: true, unlocked: true });
        } catch (err) {
            console.error('[Vault Setup] Error:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    router.post('/api/vault/unlock', (req, res) => {
        try {
            const { password, remember } = req.body;

            if (!vault.exists()) {
                return res.status(404).json({ error: 'Vault does not exist' });
            }

            vault.unlock(password);

            if (remember && password) {
                vault.saveRememberedKey();
            }

            res.json({ ok: true, unlocked: true });
        } catch (err) {
            console.error('[Vault Unlock] Error:', err);
            res.status(401).json({ error: 'Invalid password' });
        }
    });

    router.post('/api/vault/unlock-remembered', (_req, res) => {
        try {
            if (!vault.hasRememberedKey()) {
                return res.status(400).json({ error: 'No remembered key' });
            }

            const success = vault.unlockWithRemembered();
            res.json({ ok: true, unlocked: success });
        } catch (err) {
            console.error('[Vault Unlock Remembered] Error:', err);
            res.status(401).json({ error: 'Remembered key failed' });
        }
    });

    router.post('/api/vault/lock', (_req, res) => {
        vault.lock();
        res.json({ ok: true, unlocked: false });
    });

    router.get('/api/vault/keys', (_req, res) => {
        try {
            const data = vault.getData();
            res.json(data);
        } catch (err) {
            res.status(403).json({ error: 'Vault is locked' });
        }
    });

    router.put('/api/vault/keys', (req, res) => {
        try {
            const data = req.body;
            if (!data || !Array.isArray(data.presets)) {
                return res.status(400).json({ error: 'Invalid payload: presets must be an array' });
            }

            // Strict Schema Validation (Hard-Reject on extra keys or malformed structures)
            const allowedRootKeys = new Set(['presets']);
            for (const key of Object.keys(data)) {
                if (!allowedRootKeys.has(key)) {
                    return res.status(400).json({ error: `Invalid payload: unexpected property "${key}"` });
                }
            }

            const allowedPresetKeys = new Set(['id', 'name', 'storyAI', 'imageAI', 'summarizerAI', 'utilityAI', 'auxiliaryAI', 'sampling']);
            const allowedAIKeys = new Set(['endpoint', 'apiKey', 'modelName']);

            for (const preset of data.presets) {
                if (typeof preset !== 'object' || preset === null) {
                    return res.status(400).json({ error: 'Invalid preset structure: must be an object' });
                }
                
                // Check preset properties
                for (const key of Object.keys(preset)) {
                    if (!allowedPresetKeys.has(key)) {
                        return res.status(400).json({ error: `Invalid preset: unexpected property "${key}"` });
                    }
                }

                if (typeof preset.id !== 'string' || !preset.id) {
                    return res.status(400).json({ error: 'Invalid preset: id is a required non-empty string' });
                }
                if (typeof preset.name !== 'string' || !preset.name) {
                    return res.status(400).json({ error: 'Invalid preset: name is a required non-empty string' });
                }

                // Validate AI configs
                const aiSections = ['storyAI', 'imageAI', 'summarizerAI', 'utilityAI', 'auxiliaryAI'];
                for (const section of aiSections) {
                    if (preset[section]) {
                        const conf = preset[section];
                        if (typeof conf !== 'object' || conf === null) {
                            return res.status(400).json({ error: `Invalid preset: ${section} must be an object` });
                        }
                        for (const key of Object.keys(conf)) {
                            if (!allowedAIKeys.has(key)) {
                                return res.status(400).json({ error: `Invalid preset AI config in ${section}: unexpected property "${key}"` });
                            }
                        }
                        if (conf.endpoint !== undefined && typeof conf.endpoint !== 'string') {
                            return res.status(400).json({ error: `Invalid preset: ${section} endpoint must be a string` });
                        }
                        if (conf.apiKey !== undefined && typeof conf.apiKey !== 'string') {
                            return res.status(400).json({ error: `Invalid preset: ${section} apiKey must be a string` });
                        }
                        if (conf.modelName !== undefined && typeof conf.modelName !== 'string') {
                            return res.status(400).json({ error: `Invalid preset: ${section} modelName must be a string` });
                        }
                    }
                }

                // Validate sampling config if present
                if (preset.sampling) {
                    if (typeof preset.sampling !== 'object') {
                        return res.status(400).json({ error: 'Invalid preset: sampling must be an object' });
                    }
                }
            }

            vault.saveData(data);
            res.json({ ok: true });
        } catch (err) {
            console.error('[Vault Save] Error:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    router.post('/api/vault/export', (req, res) => {
        try {
            const { password } = req.body;
            const buffer = vault.exportWithPassword(password);

            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Disposition', 'attachment; filename="narrative-engine-keys.nevault"');
            res.send(buffer);
        } catch (err) {
            console.error('[Vault Export] Error:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    router.post('/api/vault/import', (req, res) => {
        try {
            // req.body.file should be base64 encoded buffer
            const { file, password, merge = true } = req.body;

            if (!file || !password) {
                return res.status(400).json({ error: 'Missing file or password' });
            }

            const buffer = Buffer.from(file, 'base64');
            const importedData = KeyVault.importFromBuffer(buffer, password);

            if (merge && vault.isUnlocked()) {
                const existing = vault.getData();
                // Merge presets by name
                const existingPresets = existing.presets || [];
                const importedPresets = importedData.presets || [];
                const mergedPresets = [...existingPresets];

                for (const importedPreset of importedPresets) {
                    const existingIndex = mergedPresets.findIndex(p => p.name === importedPreset.name);
                    if (existingIndex >= 0) {
                        mergedPresets[existingIndex] = importedPreset;
                    } else {
                        mergedPresets.push(importedPreset);
                    }
                }

                vault.saveData({ presets: mergedPresets });
            } else {
                vault.saveData(importedData);
            }

            res.json({ ok: true, unlocked: true });
        } catch (err) {
            console.error('[Vault Import] Error:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    router.delete('/api/vault/remember', (_req, res) => {
        vault.clearRememberedKey();
        res.json({ ok: true });
    });

    router.delete('/api/vault', (_req, res) => {
        try {
            vault.delete();
            res.json({ ok: true });
        } catch (err) {
            console.error('[Vault Delete] Error:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    return router;
}
