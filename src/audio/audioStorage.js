/**
 * audioStorage — Persist and retrieve the last uploaded audio file in IndexedDB.
 *
 * Allows the browser to remember and automatically play the last track upon reload.
 */

const DB_NAME = 'SoundStage3D_AudioDB';
const DB_VERSION = 1;
const STORE_NAME = 'tracks';
const KEY_LAST_TRACK = 'last_uploaded_track';

function openDB() {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            return reject(new Error('IndexedDB is not supported in this environment'));
        }
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Save an uploaded audio File into IndexedDB.
 * @param {File} file
 * @returns {Promise<boolean>}
 */
export async function saveLastAudio(file) {
    if (!file) return false;
    try {
        const buffer = await file.arrayBuffer();
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const record = {
                data: buffer,
                name: file.name,
                type: file.type || 'audio/mpeg',
                lastModified: file.lastModified || Date.now(),
                savedAt: Date.now(),
            };
            const req = store.put(record, KEY_LAST_TRACK);
            req.onsuccess = () => resolve(true);
            req.onerror = () => reject(req.error);
            tx.oncomplete = () => resolve(true);
        });
    } catch (err) {
        console.warn('Failed to save audio file in IndexedDB:', err);
        return false;
    }
}

/**
 * Retrieve the last uploaded audio file from IndexedDB.
 * @returns {Promise<File|null>}
 */
export async function loadLastAudio() {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const req = store.get(KEY_LAST_TRACK);
            req.onsuccess = () => {
                const record = req.result;
                if (!record || !record.data) {
                    return resolve(null);
                }
                const file = new File([record.data], record.name || 'track.mp3', {
                    type: record.type || 'audio/mpeg',
                    lastModified: record.lastModified || Date.now(),
                });
                resolve(file);
            };
            req.onerror = () => reject(req.error);
        });
    } catch (err) {
        console.warn('Failed to load audio file from IndexedDB:', err);
        return null;
    }
}
