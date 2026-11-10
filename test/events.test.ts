import { describe, expect, it } from "vitest";
import { GROWW_PATHS, GROWW_ROOT } from "../src/brokers/groww";
import { ANGEL_PATHS, ANGEL_ROOT } from "../src/brokers/angel";
import {
  buildEvents,
  classify,
  cleanSymbol,
  kvEventCache,
  uniqueStocks,
  type EventCache,
  type EventSource,
  type FilingEvent,
  type StockRef,
} from "../src/events";
import { MemStore, connect, jsonRes, mockFetch } from "./helpers";

const NOW = new Date("2026-11-10T06:00:00Z");

class MemCache implements EventCache {
  m = new Map<string, string>();
  ttl = new Map<string, number>();
  async get(k: string) { return this.m.get(k) ?? null; }
  async put(k: string, v: string, t: number) { this.m.set(k, v); this.ttl.set(k, t); }
}

function fakeSource(by: Record<string, FilingEvent[] | "fail" | "hang">) {
  const seen: StockRef[] = [];
  const src: EventSource = {
    name: "fake",
    async events(stock, _from, _to, signal) {
      seen.push(stock);
      const r = by[stock.isin ?? stock.symbol];
      if (r === "fail") throw new Error("boom");
      if (r === "hang") return new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted"))));
      return r ?? [];
    },
  };
  return { src, seen };
}

describe("classifier", () => {
  it.each([
    ["Disclosure under Reg 31 - Creation of pledge on promoter shares", "review"],
    ["Resignation of Statutory Auditor", "review"],
    ["Intimation of delay in payment of interest on NCDs", "review"],
    ["Receipt of order from SEBI under Section 11", "review"],
    ["Admission of application under Insolvency and Bankruptcy Code", "review"],
    ["Outcome of Board Meeting - Unaudited Financial Results for Q2", "watch"],
    ["Credit Rating reaffirmed by CRISIL", "watch"],
    ["Bulk deal disclosure", "watch"],
    ["Company bags order worth Rs 500 crore", "watch"],
    ["Acquisition of 51% stake in XYZ Ltd", "watch"],
    ["Interim dividend - record date fixed", "info"],
    ["Bonus issue in ratio 1:1", "info"],
    ["Intimation of Board Meeting", "info"],
    ["Copy of newspaper publication", "other"],
  ])("%s -> %s", (title, flag) => {
    expect(classify(title)).toBe(flag);
  });

  it("uses the category too", () => {
    expect(classify("Disclosure", "Credit Rating")).toBe("watch");
  });

  it("flags analyst and earnings calls as WATCH", () => {
    expect(classify("Schedule of meet", "Analysts/Institutional Investor Meet/Con. Call Updates")).toBe("watch");
    expect(classify("Transcript of earnings call for Q2")).toBe("watch");
    expect(classify("Intimation of conference call with investors")).toBe("watch");
  });

  it("REVIEW wins over WATCH", () => {
    expect(classify("Results delayed; auditor resigns citing resignation of auditor")).toBe("review");
  });
});

describe("ISIN mapping", () => {
  it("merges the same stock across brokers by ISIN and adds weights", () => {
    const s = uniqueStocks([
      { symbol: "INFY-EQ", isin: "INE009A01021", weight_pct: 10 },
      { symbol: "INFY", isin: "ine009a01021", weight_pct: 5.5 },
      { symbol: "RELIANCE", isin: "INE002A01018", weight_pct: 20 },
      { symbol: "XYZ-BE", isin: null, weight_pct: 1 },
    ]);
    expect(s).toEqual([
      { symbol: "RELIANCE", isin: "INE002A01018", weight_pct: 20 },
      { symbol: "INFY", isin: "INE009A01021", weight_pct: 15.5 },
      { symbol: "XYZ", isin: null, weight_pct: 1 },
    ]);
  });

  it("strips series suffixes", () => {
    expect(cleanSymbol(" tcs-eq ")).toBe("TCS");
    expect(cleanSymbol("BAJAJ-AUTO")).toBe("BAJAJ-AUTO");
  });
});

describe("buildEvents", () => {
  const stocks = [
    { symbol: "RELIANCE", isin: "INE002A01018", weight_pct: 20 },
    { symbol: "INFY", isin: "INE009A01021", weight_pct: 10 },
  ];

  it("sorts REVIEW first, drops events outside the window, links each filing", async () => {
    const { src } = fakeSource({
      INE002A01018: [
        { title: "Interim dividend", date: "2026-11-08", url: "https://x/1" },
        { title: "Old results", date: "2026-09-01", url: "https://x/old" },
      ],
      INE009A01021: [{ title: "Creation of pledge", date: "2026-11-09", url: "https://x/2" }],
    });
    const r = await buildEvents(stocks, src, { days: 7, now: NOW });
    expect(r.events.map((e) => [e.symbol, e.flag, e.url])).toEqual([
      ["INFY", "review", "https://x/2"],
      ["RELIANCE", "info", "https://x/1"],
    ]);
    expect(r.counts).toEqual({ review: 1, watch: 0, info: 1, other: 0 });
    expect(r.source_unavailable).toEqual([]);
  });

  it("returns partial results when a source fails or times out", async () => {
    const { src } = fakeSource({
      INE002A01018: "fail",
      INE009A01021: "hang",
      INE467B01029: [{ title: "Bulk deal", date: "2026-11-09", url: null }],
    });
    const r = await buildEvents([...stocks, { symbol: "TCS", isin: "INE467B01029", weight_pct: 5 }], src, { days: 7, now: NOW, timeoutMs: 20 });
    expect(r.source_unavailable).toEqual(["INFY", "RELIANCE"]);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].flag).toBe("watch");
  });

  it("caches per stock for 30 minutes and serves from cache", async () => {
    const cache = new MemCache();
    const { src, seen } = fakeSource({ INE002A01018: [{ title: "Bonus issue", date: "2026-11-09", url: null }] });
    await buildEvents(stocks, src, { days: 7, now: NOW, cache });
    await buildEvents(stocks, src, { days: 7, now: NOW, cache });
    expect(seen).toHaveLength(2);
    expect([...cache.ttl.values()]).toEqual([1800, 1800]);
  });

  it("limits parallel calls", async () => {
    let live = 0, peak = 0;
    const src: EventSource = {
      name: "slow",
      async events() {
        live++; peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 5));
        live--;
        return [];
      },
    };
    const many = Array.from({ length: 12 }, (_, i) => ({ symbol: `S${i}`, isin: null, weight_pct: 1 }));
    await buildEvents(many, src, { days: 7, now: NOW, concurrency: 5 });
    expect(peak).toBe(5);
  });

  it("KV adapter keeps TTL at KV's 60s minimum or more", async () => {
    const puts: any[] = [];
    const c = kvEventCache({ get: async () => null, put: async (...a: any[]) => { puts.push(a); } } as any);
    await c.put("k", "v", 1800);
    await c.put("k", "v", 10);
    expect(puts.map((p) => p[2].expirationTtl)).toEqual([1800, 60]);
  });
});

describe("portfolio_events tool", () => {
  const angelBody = {
    status: true,
    data: { holdings: [{ tradingsymbol: "INFY-EQ", exchange: "NSE", isin: "INE009A01021", quantity: 10, averageprice: 1400, ltp: 1500 }] },
  };
  const growwBody = { status: "SUCCESS", payload: { holdings: [{ isin: "INE009A01021", trading_symbol: "INFY", quantity: 5, average_price: 1300 }] } };

  async function setup(source?: EventSource) {
    const store = new MemStore();
    const later = Date.now() + 3600_000;
    await store.put("angel", { token: "jwt", expiresAt: later });
    await store.put("groww", { token: "gt", expiresAt: later });
    const { f } = mockFetch({
      [ANGEL_ROOT + ANGEL_PATHS.holdings]: () => jsonRes(angelBody),
      [GROWW_ROOT + GROWW_PATHS.holdings]: () => jsonRes(growwBody),
    });
    return connect({ fetch: f, store, env: { KITE_API_KEY: "" } as any, ...(source ? { events: { source } } : {}) });
  }

  it("says plainly when no source is set up", async () => {
    const { call, logs } = await setup();
    const r = await call("portfolio_events");
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/No filings source/);
    expect(logs).toEqual([JSON.stringify({ tool: "portfolio_events", status: "ok" })]);
  });

  it("sends only symbol + ISIN to the source, once per stock", async () => {
    const { src, seen } = fakeSource({ INE009A01021: [{ title: "Financial results", date: new Date().toISOString(), url: "https://x" }] });
    const { call } = await setup(src);
    const out = JSON.parse((await call("portfolio_events", { days: 3 })).text);
    expect(seen).toEqual([{ symbol: "INFY", isin: "INE009A01021" }]);
    expect(out.days).toBe(3);
    expect(out.events[0]).toMatchObject({ symbol: "INFY", flag: "watch", weight_pct: 100 });
  });

  it("rejects days over 30", async () => {
    const { src } = fakeSource({});
    const { call } = await setup(src);
    expect((await call("portfolio_events", { days: 31 })).isError).toBe(true);
  });
});
