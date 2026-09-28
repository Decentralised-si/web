/**
 * Conversations live in this browser (IndexedDB), never on the server:
 * the network only sees the turn being answered.
 */
export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  mode: string;
  affinity?: string;
  messages: Array<{ role: "user" | "assistant"; content: string; files?: string[]; meta?: { provider?: string; model?: string; market?: string } ; error?: string }>;
}

const DB = "dsi-chat";
const STORE = "conversations";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const r = fn(db.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

// Each signed-in user gets their own namespace in this browser.
let ns = "anon";
export function setNamespace(userId: string) {
  ns = userId;
}

export async function listConversations(): Promise<Conversation[]> {
  const all = (await tx("readonly", (s) => s.getAll())) as Array<Conversation & { ns: string }>;
  return all.filter((c) => c.ns === ns).sort((a, b) => b.updatedAt - a.updatedAt);
}
export async function saveConversation(c: Conversation) {
  await tx("readwrite", (s) => s.put({ ...c, ns }));
}
export async function deleteConversation(id: string) {
  await tx("readwrite", (s) => s.delete(id));
}
