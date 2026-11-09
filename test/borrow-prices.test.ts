import { describe, expect, it } from "vitest";
import { GROWW_PATHS, GROWW_ROOT } from "../src/brokers/groww";
import { KITE_PATHS, KITE_ROOT } from "../src/brokers/kite";
import { applyQuotes, quoteKeys } from "../src/portfolio";
import type { Holding } from "../src/types";
import { MemStore, connect, jsonRes, mockFetch } from "./helpers";

const later = () => Date.now() + 3600_000;
const growwBody = {
  status: "SUCCESS",
  payload: {
    holdings: [
      { isin: "INE040A01034", trading_symbol: "HDFCBANK", quantity: 400, average_price: 1000 },
      { isin: "X", trading_symbol: "BSEONLY", quantity: 10, average_price: 50 },
    ],
  },
};
const noGrowwLtp = () => jsonRes({ status: "FAILURE", error: { code: "GA005", message: "plan" } }, 403);

async function loggedIn(...brokers: ("groww" | "kite")[]) {
  const store = new MemStore();
  for (const b of brokers) await store.put(b, { token: b + "tok", expiresAt: later() });
  return store;
}

describe("Groww prices from Kite", () => {
  it("fills missing Groww prices, NSE first then BSE", async () => {
    const store = await loggedIn("groww", "kite");
    const { f, calls } = mockFetch({
      [GROWW_ROOT + GROWW_PATHS.holdings]: () => jsonRes(growwBody),
      [GROWW_ROOT + GROWW_PATHS.ltp]: noGrowwLtp,
      [KITE_ROOT + KITE_PATHS.ltp]: () =>
        jsonRes({ status: "success", data: { "NSE:HDFCBANK": { last_price: 1100 }, "BSE:HDFCBANK": { last_price: 1099 }, "BSE:BSEONLY": { last_price: 60 } } }),
    });
    const { call } = await connect({ fetch: f, store });
    const h = JSON.parse((await call("groww_holdings")).text);
    expect(h[0]).toMatchObject({ symbol: "HDFCBANK", exchange: "NSE", ltp: 1100, value: 440000, pnl: 40000, pnl_pct: 10, price_source: "kite" });
    expect(h[1]).toMatchObject({ symbol: "BSEONLY", exchange: "BSE", ltp: 60, value: 600, price_source: "kite" });
    const q = calls.find((c) => c.url.includes(KITE_PATHS.ltp))!;
    expect(new URL(q.url).searchParams.getAll("i")).toEqual(["NSE:HDFCBANK", "BSE:HDFCBANK", "NSE:BSEONLY", "BSE:BSEONLY"]);
    expect(q.init.method).toBe("GET");
  });

  it("get_portfolio has no unpriced holdings once Kite prices them", async () => {
    const store = await loggedIn("groww", "kite");
    const { f } = mockFetch({
      [GROWW_ROOT + GROWW_PATHS.holdings]: () => jsonRes(growwBody),
      [GROWW_ROOT + GROWW_PATHS.ltp]: noGrowwLtp,
      [KITE_ROOT + KITE_PATHS.holdings]: () => jsonRes({ status: "success", data: [] }),
      [KITE_ROOT + KITE_PATHS.ltp]: () => jsonRes({ status: "success", data: { "NSE:HDFCBANK": { last_price: 1100 }, "BSE:BSEONLY": { last_price: 60 } } }),
    });
    const { call } = await connect({ fetch: f, store, env: { ANGEL_API_KEY: "" } as any });
    const p = JSON.parse((await call("get_portfolio")).text);
    expect(p.unpriced).toEqual([]);
    expect(p.totals).toEqual({ invested: 400500, value: 440600, pnl: 40100, pnl_pct: 10.01 });
  });

  it("Kite plan without quotes → still valued at cost, Kite stays logged in", async () => {
    const store = await loggedIn("groww", "kite");
    const { f } = mockFetch({
      [GROWW_ROOT + GROWW_PATHS.holdings]: () => jsonRes(growwBody),
      [GROWW_ROOT + GROWW_PATHS.ltp]: noGrowwLtp,
      [KITE_ROOT + KITE_PATHS.ltp]: () => jsonRes({ status: "error", error_type: "PermissionException", message: "Insufficient permission" }, 403),
    });
    const { call } = await connect({ fetch: f, store });
    const h = JSON.parse((await call("groww_holdings")).text);
    expect(h[0]).toMatchObject({ ltp: null, value: null });
    expect(h[0].price_source).toBeUndefined();
    expect(await store.get("kite")).not.toBeNull();
  });

  it("Kite logged out → no quote call, and get_portfolio says how to fix it", async () => {
    const store = await loggedIn("groww");
    const { f, calls } = mockFetch({
      [GROWW_ROOT + GROWW_PATHS.holdings]: () => jsonRes(growwBody),
      [GROWW_ROOT + GROWW_PATHS.ltp]: noGrowwLtp,
    });
    const { call } = await connect({ fetch: f, store, env: { ANGEL_API_KEY: "" } as any });
    const p = JSON.parse((await call("get_portfolio")).text);
    expect(p.unpriced).toHaveLength(2);
    expect(p.notes.join(" ")).toMatch(/Log in to Zerodha to price them/);
    expect(calls.some((c) => c.url.startsWith(KITE_ROOT))).toBe(false);
  });

  it("strips Angel's -EQ suffix and leaves priced holdings alone", () => {
    const base = { broker: "angel", exchange: null, isin: null, qty: 2, avg_price: 10, invested: 20, pnl: null, pnl_pct: null } as const;
    const hs: Holding[] = [
      { ...base, symbol: "SBIN-EQ", ltp: null, value: null },
      { ...base, symbol: "INFY-EQ", ltp: 15, value: 30 },
    ];
    expect(quoteKeys(hs)).toEqual(["NSE:SBIN", "BSE:SBIN"]);
    const out = applyQuotes(hs, { "NSE:SBIN": 12, "NSE:INFY": 99 }, "kite");
    expect(out[0]).toMatchObject({ ltp: 12, value: 24, pnl: 4, pnl_pct: 20 });
    expect(out[1]).toBe(hs[1]);
  });
});
