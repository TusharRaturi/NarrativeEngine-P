/**
 * Per-campaign write serializer. Serializes all read-modify-write sequences
 * for a campaign's files so concurrent appends (and deferred LLM extraction
 * writes) don't clobber each other via lost updates.
 *
 * The lock is in-memory and per-process. Server restart drops it — acceptable
 * since each `writeJson` is atomic (tmp+rename), so a crash mid-write doesn't
 * corrupt files, it just means a deferred LLM write doesn't happen (same risk
 * profile as the existing fire-and-forget embedding pattern).
 *
 * Usage:
 *   await withCampaignLock(campaignId, () => {
 *       const data = readJson(path, []);
 *       data.push(newEntry);
 *       writeJson(path, data);
 *   });
 */

/** @type {Map<string, Promise<unknown>>} */
const locks = new Map();

/**
 * Run `fn` while holding the per-campaign lock. Serializes with any prior
 * `withCampaignLock` call for the same campaignId. The lock auto-cleans once
 * the chain settles so there's no memory leak.
 *
 * @param {string} campaignId
 * @param {() => Promise<T> | T} fn
 * @returns {Promise<T>}
 * @template T
 */
export function withCampaignLock(campaignId, fn) {
    const prev = locks.get(campaignId) || Promise.resolve();
    const next = prev.then(() => fn()).catch(err => {
        console.error(`[WriteLock] Error for campaign ${campaignId}:`, err);
        throw err;
    });
    locks.set(campaignId, next);
    next.finally(() => {
        if (locks.get(campaignId) === next) locks.delete(campaignId);
    });
    return next;
}