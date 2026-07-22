/* eslint-disable @typescript-eslint/no-explicit-any */
import { pipeline, env } from '@huggingface/transformers';

// Suppress local file warnings in browser
env.allowLocalModels = false;

let extractor: any = null;
let isReady = false;

const ACTIVE_DIMS = 1024;
const MODEL_ID = 'mixedbread-ai/mxbai-embed-large-v1';

async function loadModel() {
    if (extractor) return extractor;
    
    // WebGPU support in v4
    extractor = await pipeline('feature-extraction', MODEL_ID, {
        dtype: 'q8',
        device: 'webgpu',
    });
    
    isReady = true;
    return extractor;
}

// Ensure the model is loaded immediately
loadModel().catch(console.error);

self.onmessage = async (e) => {
    const { id, type, payload } = e.data;
    
    try {
        const model = await loadModel();
        
        if (type === 'embed') {
            const { text } = payload;
            if (!text || !text.trim()) {
                self.postMessage({ id, type: 'success', data: Array.from(new Float32Array(ACTIVE_DIMS)) });
                return;
            }
            
            const output = await model(text, { pooling: 'mean', normalize: true });
            const data = output.data;
            const vec = data.buffer ? new Float32Array(data.buffer, data.byteOffset, data.length) : Float32Array.from(data);
            
            self.postMessage({ id, type: 'success', data: Array.from(vec) });
        } else if (type === 'embedBatch') {
            const { texts } = payload;
            if (!texts || texts.length === 0) {
                self.postMessage({ id, type: 'success', data: [] });
                return;
            }
            
            // Clean empty texts
            const validTexts = texts.map((t: string) => (t && t.trim() ? t : ' '));
            
            const output = await model(validTexts, { pooling: 'mean', normalize: true });
            const data = output.data;
            const src = data.buffer ? new Float32Array(data.buffer, data.byteOffset, data.length) : Float32Array.from(data);
            
            const batch = validTexts.length;
            const dims = src.length / batch;
            const out = [];
            
            for (let i = 0; i < batch; i++) {
                if (!texts[i] || !texts[i].trim()) {
                    out.push(Array.from(new Float32Array(ACTIVE_DIMS)));
                } else {
                    out.push(Array.from(src.slice(i * dims, (i + 1) * dims)));
                }
            }
            
            self.postMessage({ id, type: 'success', data: out });
        } else if (type === 'status') {
            self.postMessage({ id, type: 'success', data: { isReady } });
        }
    } catch (err: any) {
        console.error('[EmbedWorker] Error:', err);
        self.postMessage({ id, type: 'error', error: err.message });
    }
};
