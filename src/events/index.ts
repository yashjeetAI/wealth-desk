import type { MergedHolding } from "../portfolio";
import { round } from "../util";
import { FLAG_ORDER, classify } from "./classify";
import type { EventCache, EventSource, FilingEvent, Flag, StockRef } from "./types";

export * from "./types";
export { classify } from "./classify";

export const EVENTS_CONCURRENCY = 5;
export const EVENTS_TIMEOUT_MS = 5000;
export const EVENTS_CACHE_TTL_S = 30 * 60;

export interface Stock extends StockRef {
  weight_pct: number;
}

export interface EventRow {
  symbol: string;
  isin: string | null;
  weight_pct: number;
  flag: Flag;
  title: string;
  date: string;
  url: string | null;
}

export interface EventsReport {
  as_of: string;
  days: number;
  source: string;
  stocks_checked: number;
  counts: Record<Flag, number>;
  events: EventRow[];
  /** Stocks whose filings could not be fetched. */
  source_unavailable: string[];
}

/** Broker symbols carry series suffixes (Angel: "INFY-EQ"). Exchanges want the bare symbol. */
export function cleanSymbol(s: string): string {
  return s.trim().toUpperCase().replace(/-(EQ|BE|BZ|SM|ST)$/, "");
}

/** One entry per stock across all brokers, keyed by ISIN (symbol if no ISIN). Weights add up. */
export function uniqueStocks(holdings: Pick<MergedHolding, "symbol" | "isin" | "weight_pct">[]): Stock[] {
  const by = new Map<string, Stock>();
  for (const h of holdings) {
    const isin = h.isin?.trim().toUpperCase() || null;
    const symbol = cleanSymbol(h.symbol);
    const key = isin ?? `SYM:${symbol}`;
    const s = by.get(key);
    if (s) s.weight_pct = round(s.weight_pct + h.weight_pct)!;
    else by.set(key, { symbol, isin, weight_pct: h.weight_pct });
  }
  return [...by.values()].sort((a, b) => b.weight_pct - a.weight_pct);
}

async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new Error("timeout"));
    }, ms);
  });
  return Promise.race([run(ac.signal), timeout]).finally(() => clearTimeout(timer));
}

export interface BuildOptions {
  days: number;
  now?: Date;
  cache?: EventCache;
  concurrency?: number;
  timeoutMs?: number;
}

/** Fetch, classify and sort filings for every held stock. A failing stock never fails the whole report. */
export async function buildEvents(stocks: Stock[], source: EventSource, opts: BuildOptions): Promise<EventsReport> {
  const now = opts.now ?? new Date();
  const from = new Date(now.getTime() - opts.days * 86400_000);
  const unavailable: string[] = [];

  const fetchOne = async (s: Stock): Promise<FilingEvent[]> => {
    // Only symbol + ISIN go to the source.
    const ref: StockRef = { symbol: s.symbol, isin: s.isin };
    const key = `events:v1:${source.name}:${s.isin ?? s.symbol}:${opts.days}`;
    const hit = await opts.cache?.get(key).catch(() => null);
    if (hit) return JSON.parse(hit) as FilingEvent[];
    const evs = await withTimeout(opts.timeoutMs ?? EVENTS_TIMEOUT_MS, (signal) => source.events(ref, from, now, signal));
    await opts.cache?.put(key, JSON.stringify(evs), EVENTS_CACHE_TTL_S).catch(() => {});
    return evs;
  };

  const results = await pool(stocks, opts.concurrency ?? EVENTS_CONCURRENCY, async (s) => {
    try {
      return { s, evs: await fetchOne(s) };
    } catch {
      unavailable.push(s.symbol);
      return { s, evs: [] as FilingEvent[] };
    }
  });

  const rows: EventRow[] = [];
  for (const { s, evs } of results) {
    for (const e of evs) {
      const t = Date.parse(e.date);
      if (Number.isFinite(t) && (t < from.getTime() || t > now.getTime() + 86400_000)) continue;
      rows.push({ symbol: s.symbol, isin: s.isin, weight_pct: s.weight_pct, flag: classify(e.title, e.category), title: e.title, date: e.date, url: e.url });
    }
  }
  rows.sort((a, b) => FLAG_ORDER[a.flag] - FLAG_ORDER[b.flag] || b.weight_pct - a.weight_pct || b.date.localeCompare(a.date));

  const counts: Record<Flag, number> = { review: 0, watch: 0, info: 0, other: 0 };
  for (const r of rows) counts[r.flag]++;
  return {
    as_of: now.toISOString(),
    days: opts.days,
    source: source.name,
    stocks_checked: stocks.length,
    counts,
    events: rows,
    source_unavailable: unavailable.sort(),
  };
}

/** KV adapter for EventCache. */
export function kvEventCache(kv: Pick<KVNamespace, "get" | "put">): EventCache {
  return {
    get: (k) => kv.get(k),
    put: (k, v, ttl) => kv.put(k, v, { expirationTtl: Math.max(60, ttl) }),
  };
}
