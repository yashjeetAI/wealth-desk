import type { Broker, Holding } from "./types";
import { round } from "./util";

export interface MergedHolding extends Holding {
  weight_pct: number;
}

export interface Portfolio {
  as_of: string;
  totals: { invested: number; value: number; pnl: number; pnl_pct: number | null };
  by_broker: Record<string, { invested: number; value: number; count: number }>;
  holdings: MergedHolding[];
  unpriced: string[];
  login_needed: Broker[];
  errors: string[];
}

/**
 * Merge holdings from all brokers. Holdings with no live price are valued at cost
 * and listed in `unpriced`, so totals still add up.
 */
export function mergePortfolio(
  holdings: Holding[],
  loginNeeded: Broker[] = [],
  errors: string[] = [],
  now = new Date(),
): Portfolio {
  const valued = holdings.map((h) => ({ h, v: h.value ?? h.invested }));
  const total = valued.reduce((s, x) => s + x.v, 0);
  const invested = holdings.reduce((s, h) => s + h.invested, 0);
  const byBroker: Portfolio["by_broker"] = {};
  for (const { h, v } of valued) {
    const b = (byBroker[h.broker] ??= { invested: 0, value: 0, count: 0 });
    b.invested = round(b.invested + h.invested)!;
    b.value = round(b.value + v)!;
    b.count++;
  }
  const merged = valued
    .map(({ h, v }) => ({ ...h, weight_pct: total ? round((v / total) * 100)! : 0 }))
    .sort((a, b) => b.weight_pct - a.weight_pct);
  const pnl = total - invested;
  return {
    as_of: now.toISOString(),
    totals: {
      invested: round(invested)!,
      value: round(total)!,
      pnl: round(pnl)!,
      pnl_pct: invested ? round((pnl / invested) * 100) : null,
    },
    by_broker: byBroker,
    holdings: merged,
    unpriced: holdings.filter((h) => h.value === null).map((h) => `${h.broker}:${h.symbol}`),
    login_needed: loginNeeded,
    errors,
  };
}

/** Exchange symbol without broker suffixes like Angel's "-EQ". */
export function baseSymbol(symbol: string): string {
  return symbol.replace(/-(EQ|BE|BZ|SM|ST)$/i, "");
}

/** Quote keys to ask for each unpriced holding: NSE first, BSE as fallback. */
export function quoteKeys(holdings: Holding[]): string[] {
  const syms = new Set(holdings.filter((h) => h.ltp === null && h.symbol).map((h) => baseSymbol(h.symbol)));
  return [...syms].flatMap((s) => [`NSE:${s}`, `BSE:${s}`]);
}

/** Fill in holdings that have no price, using quotes keyed "NSE:SYM" / "BSE:SYM". */
export function applyQuotes(holdings: Holding[], quotes: Record<string, number>, source: Broker): Holding[] {
  return holdings.map((h) => {
    if (h.ltp !== null) return h;
    const s = baseSymbol(h.symbol);
    const exchange = quotes[`NSE:${s}`] !== undefined ? "NSE" : quotes[`BSE:${s}`] !== undefined ? "BSE" : null;
    if (!exchange) return h;
    const ltp = quotes[`${exchange}:${s}`];
    const value = h.qty * ltp;
    const pnl = value - h.invested;
    return {
      ...h,
      exchange: h.exchange ?? exchange,
      ltp,
      value: round(value),
      pnl: round(pnl),
      pnl_pct: h.invested === 0 ? null : round((pnl / h.invested) * 100),
      price_source: source,
    };
  });
}
