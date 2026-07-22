let worker: Worker | null = null;
let msgId = 0;
const pending = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();

function getWorker() {
    if (!worker) {
        worker = new Worker(new URL('../../workers/embedWorker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (e) => {
            const { id, type, data, error } = e.data;
            if (pending.has(id)) {
                const { resolve, reject } = pending.get(id)!;
                pending.delete(id);
                if (type === 'error') reject(new Error(error));
                else resolve(data);
            }
        };
    }
    return worker;
}

export const embedClient = {
    async embedText(text: string): Promise<number[]> {
        return new Promise((resolve, reject) => {
            const id = msgId++;
            pending.set(id, { resolve, reject });
            getWorker().postMessage({ id, type: 'embed', payload: { text } });
        });
    },

    async embedBatch(texts: string[]): Promise<number[][]> {
        return new Promise((resolve, reject) => {
            const id = msgId++;
            pending.set(id, { resolve, reject });
            getWorker().postMessage({ id, type: 'embedBatch', payload: { texts } });
        });
    },

    async getStatus(): Promise<{ isReady: boolean }> {
        return new Promise((resolve, reject) => {
            const id = msgId++;
            pending.set(id, { resolve, reject });
            getWorker().postMessage({ id, type: 'status' });
        });
    }
};
