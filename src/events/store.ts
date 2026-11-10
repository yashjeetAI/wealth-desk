import { NSE_RSS_URL, parseNseRss } from "./nse-rss";
import type { EventSource, FilingEvent } from "./types";

/** How long filings are kept. portfolio_events looks back at most 30 days. */
export const KEEP_DAYS = 31;
const KEEP_S = KEEP_DAYS * 86400;

type KV = Pick<KVNamespace, "get" | "put">;

/**
 * Filings for the owner's stocks, kept in KV:
 *   watchlist        -> ["RELIANCE", "INFY", ...]   (symbols only)
 *   events:<SYMBOL>  -> FilingEvent[]               (last 31 days)
 *   seen             -> ISO date of the newest feed item already handled
 */
export class EventStore {
  constructor(private kv: KV) {}

  async watchlist(): Promise<string[]> {
    return JSON.parse((await this.kv.get("watchlist")) ?? "[]");
  }

  /** Save only when it changed, to keep KV writes low. */
  async setWatchlist(symbols: string[]): Promise<void> {
    const next = [...new Set(symbols)].sort();
    if (JSON.stringify(next) === JSON.stringify(await this.watchlist())) return;
    await this.kv.put("watchlist", JSON.stringify(next));
  }

  async events(symbol: string): Promise<FilingEvent[]> {
    return JSON.parse((await this.kv.get(`events:${symbol}`)) ?? "[]");
  }

  /** Add new filings (deduped by link + date), drop ones older than KEEP_DAYS. */
  async add(symbol: string, add: FilingEvent[], now: Date): Promise<void> {
    const cutoff = now.getTime() - KEEP_S * 1000;
    const key = (e: FilingEvent) => `${e.url}|${e.date}`;
    const all = new Map((await this.events(symbol)).map((e) => [key(e), e]));
    for (const e of add) all.set(key(e), e);
    const kept = [...all.values()].filter((e) => Date.parse(e.date) >= cutoff).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    await this.kv.put(`events:${symbol}`, JSON.stringify(kept), { expirationTtl: KEEP_S });
  }

  async seen(): Promise<string | null> {
    return this.kv.get("seen");
  }

  async setSeen(iso: string): Promise<void> {
    await this.kv.put("seen", iso);
  }

  /** portfolio_events reads from here: no exchange call while you wait. */
  source(): EventSource {
    return { name: "nse-rss", events: async (stock) => this.events(stock.symbol) };
  }
}

export interface PollResult {
  items: number;
  new_items: number;
  matched: number;
  watching: number;
}

/** Scheduled job: read NSE's feed once, keep only new items for watched symbols. */
export async function pollNse(store: EventStore, fetchFn: typeof fetch = fetch, now = new Date()): Promise<PollResult> {
  const r = await fetchFn(NSE_RSS_URL, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`NSE feed HTTP ${r.status}`);
  const items = parseNseRss(await r.text());
  const watch = new Set(await store.watchlist());
  const seen = await store.seen();
  const seenMs = seen ? Date.parse(seen) : 0;
  const fresh = items.filter((i) => Date.parse(i.date) > seenMs);

  const bySymbol = new Map<string, FilingEvent[]>();
  for (const i of fresh) {
    if (!i.symbol || !watch.has(i.symbol)) continue;
    const { title, category, date, url } = i;
    (bySymbol.get(i.symbol) ?? bySymbol.set(i.symbol, []).get(i.symbol)!).push({ title, category, date, url });
  }
  for (const [sym, evs] of bySymbol) await store.add(sym, evs, now);

  if (fresh.length) {
    const newest = fresh.reduce((a, b) => (Date.parse(b.date) > Date.parse(a.date) ? b : a));
    await store.setSeen(newest.date);
  }
  let matched = 0;
  for (const v of bySymbol.values()) matched += v.length;
  return { items: items.length, new_items: fresh.length, matched, watching: watch.size };
}
