/**
 * Browser wallet: the PAI earned by teaching DSI, kept in this browser and shown in real time.
 * It is not an on-chain wallet. Each taught item is recorded with the exact amount the Learning
 * Fabric computes for it (the same formula and inputs as the payment) and its status:
 *
 *   pending   awaiting independent validators; the amount is what approval guarantees
 *   approved  verified; the payment is on its way
 *   paid      credited to the account's PAI balance (deferred: waiting for the next epoch's budget)
 *
 * Pending items are refreshed from the router while any remain, so approvals show up live.
 */
import { api, currentAccount } from "./api";

export type WalletStatus = "pending" | "approved" | "paid" | "deferred" | "rejected";

export interface WalletItem {
  id: string;
  /** What the user taught, as DSI noted it. */
  statement: string;
  pai: number;
  status: WalletStatus;
  at: number;
}

export interface WalletTotals {
  pending: number;
  approved: number;
  paid: number;
  items: WalletItem[];
}

const key = () => `dsi_browser_wallet_${currentAccount() ?? "me"}`;

function load(): WalletItem[] {
  try {
    return JSON.parse(localStorage.getItem(key()) ?? "[]") as WalletItem[];
  } catch {
    return [];
  }
}
function save(items: WalletItem[]) {
  try {
    localStorage.setItem(key(), JSON.stringify(items.slice(-500)));
  } catch {
    /* private mode: kept for this page only */
  }
}

let mem: WalletItem[] | undefined;
const listeners = new Set<(t: WalletTotals) => void>();
const round = (x: number) => Math.round(x * 1e6) / 1e6;

export function walletTotals(items = mem ?? (mem = load())): WalletTotals {
  const sum = (s: WalletStatus[]) => round(items.filter((i) => s.includes(i.status)).reduce((a, i) => a + i.pai, 0));
  return { pending: sum(["pending"]), approved: sum(["approved", "deferred"]), paid: sum(["paid"]), items };
}

function emit() {
  const t = walletTotals();
  for (const l of listeners) l(t);
}

/** Subscribe to the wallet; called at once and on every change. */
export function onWallet(fn: (t: WalletTotals) => void): () => void {
  listeners.add(fn);
  fn(walletTotals());
  ensurePolling();
  return () => {
    listeners.delete(fn);
  };
}

/** Record (or update) a taught item from the router's estimate. */
export function recordTaught(item: Omit<WalletItem, "at"> & { at?: number }) {
  const items = mem ?? (mem = load());
  const i = items.findIndex((x) => x.id === item.id);
  const next: WalletItem = { ...items[i], ...item, at: item.at ?? items[i]?.at ?? Date.now(), pai: round(item.pai) };
  if (i >= 0) items[i] = next;
  else items.push(next);
  save(items);
  emit();
  ensurePolling();
}

/** Ask the router for the current status and amount of every item not yet paid. */
export async function refreshWallet(): Promise<void> {
  const items = mem ?? (mem = load());
  const open = items.filter((i) => i.status === "pending" || i.status === "approved" || i.status === "deferred");
  if (!open.length) return;
  const r = await api<{ estimates: Array<{ id: string; status: WalletStatus; pai: number }> }>("/learning/estimates", { body: { ids: open.map((i) => i.id) } });
  let changed = false;
  for (const e of r.estimates) {
    const it = items.find((x) => x.id === e.id);
    if (it && (it.status !== e.status || it.pai !== round(e.pai))) {
      it.status = e.status;
      it.pai = round(e.pai);
      changed = true;
    }
  }
  if (changed) {
    save(items);
    emit();
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
function ensurePolling() {
  const anyOpen = () => (mem ?? []).some((i) => i.status === "pending" || i.status === "approved" || i.status === "deferred");
  if (timer || !listeners.size || !anyOpen()) return;
  timer = setInterval(() => {
    if (!listeners.size || !anyOpen()) {
      clearInterval(timer);
      timer = undefined;
      return;
    }
    void refreshWallet().catch(() => {});
  }, 30_000);
}

/** Forget the cached copy (e.g. after switching accounts). */
export function resetWalletCache() {
  mem = undefined;
}
