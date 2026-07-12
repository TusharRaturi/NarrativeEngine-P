import { get as idbGet, set as idbSet } from 'idb-keyval';
import type { AIPreset, LLMProvider } from '../../types';

const IDB_DEVICE_KEY = 'nn_device_key';
const ENC_PREFIX = 'enc:';

async function getDeviceCryptoKey(): Promise<CryptoKey> {
    let rawKey: ArrayBuffer | undefined = await idbGet(IDB_DEVICE_KEY);

    if (!rawKey) {
        const generated = await crypto.subtle.generateKey(
            { name: 'AES-GCM', length: 256 },
            true,
            ['encrypt', 'decrypt']
        );
        rawKey = await crypto.subtle.exportKey('raw', generated);
        await idbSet(IDB_DEVICE_KEY, rawKey);
    }

    return crypto.subtle.importKey(
        'raw',
        rawKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

async function encryptString(plaintext: string, key: CryptoKey): Promise<string> {
    if (!plaintext) return plaintext;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);

    const ivB64 = btoa(String.fromCharCode(...iv));
    const ctB64 = btoa(String.fromCharCode(...new Uint8Array(cipherBuf)));
    return `${ENC_PREFIX}${ivB64}:${ctB64}`;
}

async function decryptString(ciphertext: string, key: CryptoKey): Promise<string> {
    if (!ciphertext || !ciphertext.startsWith(ENC_PREFIX)) return ciphertext;
    try {
        const payload = ciphertext.slice(ENC_PREFIX.length);
        const [ivB64, ctB64] = payload.split(':');
        const iv = Uint8Array.from(atob(ivB64), c => c.charCodeAt(0));
        const ct = Uint8Array.from(atob(ctB64), c => c.charCodeAt(0));
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
        return new TextDecoder().decode(plain);
    } catch {
        console.warn('[settingsCrypto] Failed to decrypt apiKey. Was the browser storage cleared?');
        return '';
    }
}

export async function encryptProvider(provider: LLMProvider): Promise<LLMProvider> {
    const key = await getDeviceCryptoKey();
    const encryptedApiKey = await encryptString(provider.apiKey, key);
    return { ...provider, apiKey: encryptedApiKey };
}

export async function decryptProvider(provider: LLMProvider): Promise<LLMProvider> {
    const key = await getDeviceCryptoKey();
    const decryptedApiKey = await decryptString(provider.apiKey, key);
    return { ...provider, apiKey: decryptedApiKey };
}

export async function encryptSettingsProviders(providers: LLMProvider[]): Promise<LLMProvider[]> {
    return Promise.all(providers.map(encryptProvider));
}

export async function decryptSettingsProviders(providers: LLMProvider[]): Promise<LLMProvider[]> {
    return Promise.all(providers.map(decryptProvider));
}

export async function encryptPreset(preset: AIPreset): Promise<AIPreset> {
    const key = await getDeviceCryptoKey();
    const [storyKey, summKey, utilKey, auxKey, imageKey] = await Promise.all([
        preset.storyAI ? encryptString(preset.storyAI.apiKey, key) : Promise.resolve(''),
        preset.summarizerAI ? encryptString(preset.summarizerAI.apiKey, key) : Promise.resolve(''),
        preset.utilityAI ? encryptString(preset.utilityAI.apiKey, key) : Promise.resolve(''),
        preset.auxiliaryAI ? encryptString(preset.auxiliaryAI.apiKey, key) : Promise.resolve(''),
        preset.imageAI ? encryptString(preset.imageAI.apiKey, key) : Promise.resolve(''),
    ]);
    return {
        ...preset,
        ...(preset.storyAI ? { storyAI: { ...preset.storyAI, apiKey: storyKey } } : {}),
        ...(preset.summarizerAI ? { summarizerAI: { ...preset.summarizerAI, apiKey: summKey } } : {}),
        ...(preset.utilityAI ? { utilityAI: { ...preset.utilityAI, apiKey: utilKey } } : {}),
        ...(preset.auxiliaryAI ? { auxiliaryAI: { ...preset.auxiliaryAI, apiKey: auxKey } } : {}),
        ...(preset.imageAI ? { imageAI: { ...preset.imageAI, apiKey: imageKey } } : {}),
    };
}

export async function decryptPreset(preset: AIPreset): Promise<AIPreset> {
    const key = await getDeviceCryptoKey();
    const [storyKey, summKey, utilKey, auxKey, imageKey] = await Promise.all([
        preset.storyAI ? decryptString(preset.storyAI.apiKey, key) : Promise.resolve(''),
        preset.summarizerAI ? decryptString(preset.summarizerAI.apiKey, key) : Promise.resolve(''),
        preset.utilityAI ? decryptString(preset.utilityAI.apiKey, key) : Promise.resolve(''),
        preset.auxiliaryAI ? decryptString(preset.auxiliaryAI.apiKey, key) : Promise.resolve(''),
        preset.imageAI ? decryptString(preset.imageAI.apiKey, key) : Promise.resolve(''),
    ]);
    return {
        ...preset,
        ...(preset.storyAI ? { storyAI: { ...preset.storyAI, apiKey: storyKey } } : {}),
        ...(preset.summarizerAI ? { summarizerAI: { ...preset.summarizerAI, apiKey: summKey } } : {}),
        ...(preset.utilityAI ? { utilityAI: { ...preset.utilityAI, apiKey: utilKey } } : {}),
        ...(preset.auxiliaryAI ? { auxiliaryAI: { ...preset.auxiliaryAI, apiKey: auxKey } } : {}),
        ...(preset.imageAI ? { imageAI: { ...preset.imageAI, apiKey: imageKey } } : {}),
    };
}

export async function encryptSettingsPresets(presets: AIPreset[]): Promise<AIPreset[]> {
    return Promise.all(presets.map(encryptPreset));
}

export async function decryptSettingsPresets(presets: AIPreset[]): Promise<AIPreset[]> {
    return Promise.all(presets.map(decryptPreset));
}