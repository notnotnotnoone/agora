import type { DebateState } from "./arena";
import type { Model, Phase, Vote } from "./types";

// Finished runs, kept in this browser's IndexedDB.

export interface SavedRun {
  id: string;
  at: number;
  question: string;
  choices: string[];
  models: Model[];
  votes: Vote[];
  summary: { model: string | null; text: string };
  /** Request id → what it was for. The requests themselves are read back from flexrouter. */
  phases?: Record<string, Phase>;
  debate?: Pick<DebateState, "mode" | "pairs" | "exchanges">;
}

const DB_NAME = "agora";
const STORE = "runs";
const LIMIT = 100;

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      opening = null;
      reject(req.error);
    };
  });
  return opening;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Runs saved by earlier builds of this branch have another shape; skip them
// rather than render them wrong.
const isCurrent = (run: SavedRun) =>
  run.votes.every((v) => Array.isArray(v.retries)) && (!run.debate || Array.isArray(run.debate.exchanges));

export async function listRuns(): Promise<SavedRun[]> {
  const db = await open();
  const runs = await done(db.transaction(STORE).objectStore(STORE).getAll() as IDBRequest<SavedRun[]>);
  return runs.filter(isCurrent).sort((a, b) => b.at - a.at);
}

/** Saves (or replaces) a run, keeping only the newest LIMIT. */
export async function saveRun(run: SavedRun): Promise<void> {
  const db = await open();
  await done(db.transaction(STORE, "readwrite").objectStore(STORE).put(run));
  const stale = (await listRuns()).slice(LIMIT);
  if (stale.length) {
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    await Promise.all(stale.map((r) => done(store.delete(r.id))));
  }
}

export async function deleteRun(id: string): Promise<void> {
  const db = await open();
  await done(db.transaction(STORE, "readwrite").objectStore(STORE).delete(id));
}
