// 브라우저 내부 저장소(IndexedDB)
// sessions: 연습 기록, chunks: 녹화 영상 조각(1초 단위)

const DB_NAME = 'bridge-rehearsal';
const VERSION = 1;
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: ['sessionId', 'seq'] });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const range = (id) => IDBKeyRange.bound([id, -Infinity], [id, Infinity]);

export const available = () => typeof indexedDB !== 'undefined';

export function addChunk(sessionId, seq, blob) {
  return run('chunks', 'readwrite', (s) => s.put({ sessionId, seq, blob }));
}

export async function getVideo(sessionId, type) {
  const rows = (await run('chunks', 'readonly', (s) => s.getAll(range(sessionId)))) || [];
  if (!rows.length) return null;
  rows.sort((a, b) => a.seq - b.seq);
  return new Blob(rows.map((r) => r.blob), { type: type || rows[0].blob.type || 'video/webm' });
}

export function saveSession(rec) {
  return run('sessions', 'readwrite', (s) => s.put(rec));
}

export function getSession(id) {
  return run('sessions', 'readonly', (s) => s.get(id));
}

export async function listSessions() {
  const all = (await run('sessions', 'readonly', (s) => s.getAll())) || [];
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteSession(id) {
  await run('chunks', 'readwrite', (s) => s.delete(range(id)));
  await run('sessions', 'readwrite', (s) => s.delete(id));
}

export async function estimate() {
  try {
    const e = await navigator.storage?.estimate?.();
    return e ? { usage: e.usage || 0, quota: e.quota || 0 } : null;
  } catch {
    return null;
  }
}

export async function persist() {
  try {
    return await navigator.storage?.persist?.();
  } catch {
    return false;
  }
}
