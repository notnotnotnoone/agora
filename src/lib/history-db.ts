// src/lib/history-db.ts
import type { HistoryRun } from "./history-types";

const DB_NAME = "agora-history";
const STORE_NAME = "runs";
const DB_VERSION = 1;

let db: IDBDatabase | null = null;

async function initDb(): Promise<IDBDatabase> {
  if (db) return db;

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      db = req.result;
      resolve(db);
    };

    req.onupgradeneeded = (event) => {
      const database = (event.target as IDBOpenDBRequest).result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
  });
}

export async function saveRun(run: HistoryRun): Promise<void> {
  const database = await initDb();
  return new Promise((resolve, reject) => {
    const tx = database.transaction([STORE_NAME], "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.add(run);

    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve();
  });
}

export async function getAllRuns(): Promise<HistoryRun[]> {
  const database = await initDb();
  return new Promise((resolve, reject) => {
    const tx = database.transaction([STORE_NAME], "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();

    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const runs = (req.result as HistoryRun[]).sort(
        (a, b) => b.timestamp - a.timestamp
      );
      resolve(runs);
    };
  });
}

export async function getRun(id: string): Promise<HistoryRun | undefined> {
  const database = await initDb();
  return new Promise((resolve, reject) => {
    const tx = database.transaction([STORE_NAME], "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(id);

    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}
