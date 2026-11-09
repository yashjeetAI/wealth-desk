import { describe, expect, it } from "vitest";
import { ANGEL_PATHS, ANGEL_ROOT } from "../src/brokers/angel";
import { GROWW_PATHS, GROWW_ROOT } from "../src/brokers/groww";
import { mergePortfolio } from "../src/portfolio";
import { sha256Hex } from "../src/util";
import { MemStore, connect, jsonRes, mockFetch } from "./helpers";

const later = () => Date.now() + 3600_000;

const angelHoldingsBody = {
  status: true,
  data: { holdings: [{ tradingsymbol: "INFY-EQ", exchange: "NSE", isin: "INE009A01021", quantity: 10, averageprice: 1400, ltp: 1500 }] },
};
const growwHoldingsBody = { status: "SUCCESS", payload: { holdings: [{ isin: "INE002A01018", trading_symbol: "RELIANCE", quantity: 5, average_price: 2000 }] } };

describe("angel", () => {
  it("login stores a token; TOTP is never stored", async () => {
    const { f, calls } = mockFetch({ [ANGEL_ROOT + ANGEL_PATHS.login]: () => jsonRes({ status: true, data: { jwtToken: "jwt-abc" } }) });
    const { call, store } = await connect({ fetch: f });
    const r = await call("angel_login", { totp: "123456" });
    expect(r.text).toMatch(/logged in until/);
    expect((await store.get("angel"))?.token).toBe("jwt-abc");
    expect(JSON.stringify([...store.m.values()])).not.toContain("123456");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toEqual({ clientcode: "C1", password: "1111", totp: "123456" });
    expect((calls[0].init.headers as any)["X-PrivateKey"]).toBe("ak");
  });

  it("rejects a non 6-digit TOTP", async () => {
    const { call } = await connect({});
    const r = await call("angel_login", { totp: "12ab" });
    expect(r.isError).toBe(true);
  });

  it("holdings come back in the common shape", async () => {
    const store = new MemStore();
    await store.put("angel", { token: "jwt", expiresAt: later() });
    const { f, calls } = mockFetch({ [ANGEL_ROOT + ANGEL_PATHS.holdings]: () => jsonRes(angelHoldingsBody) });
    const { call } = await connect({ fetch: f, store });
    const h = JSON.parse((await call("angel_holdings")).text);
    expect(h[0]).toMatchObject({ broker: "angel", symbol: "INFY-EQ", qty: 10, avg_price: 1400, ltp: 1500, value: 15000, pnl: 1000, pnl_pct: 7.14 });
    expect((calls[0].init.headers as any).Authorization).toBe("Bearer jwt");
    expect(calls[0].init.method).toBe("GET");
  });

  it("no token → login needed, no API call", async () => {
    const { f, calls } = mockFetch({});
    const { call } = await connect({ fetch: f });
    const r = await call("angel_holdings");
    expect(r.text).toMatch(/login needed/i);
    expect(r.isError).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("expired token → login needed", async () => {
    const store = new MemStore();
    await store.put("angel", { token: "old", expiresAt: Date.now() - 1 });
    const { call } = await connect({ store });
    expect((await call("angel_positions")).text).toMatch(/login needed/i);
  });

  it("broker rejects token → login needed and token cleared", async () => {
    const store = new MemStore();
    await store.put("angel", { token: "jwt", expiresAt: later() });
    const { f } = mockFetch({ [ANGEL_ROOT]: () => jsonRes({ status: false, message: "Invalid Token", errorcode: "AG8001" }) });
    const { call } = await connect({ fetch: f, store });
    expect((await call("angel_funds")).text).toMatch(/login needed/i);
    expect(await store.get("angel")).toBeNull();
  });

  it("funds and positions normalize", async () => {
    const store = new MemStore();
    await store.put("angel", { token: "jwt", expiresAt: later() });
    const { f } = mockFetch({
      [ANGEL_ROOT + ANGEL_PATHS.funds]: () => jsonRes({ status: true, data: { net: "5000.5", availablecash: "5000.5", utiliseddebits: "100" } }),
      [ANGEL_ROOT + ANGEL_PATHS.positions]: () => jsonRes({ status: true, data: [{ tradingsymbol: "SBIN-EQ", exchange: "NSE", producttype: "INTRADAY", netqty: "2", avgnetprice: "800", ltp: "810", pnl: "20" }] }),
    });
    const { call } = await connect({ fetch: f, store });
    expect(JSON.parse((await call("angel_funds")).text)).toMatchObject({ broker: "angel", available_cash: 5000.5, used_margin: 100 });
    expect(JSON.parse((await call("angel_positions")).text)[0]).toMatchObject({ symbol: "SBIN-EQ", qty: 2, avg_price: 800, ltp: 810, pnl: 20 });
  });
});

describe("groww", () => {
  it("approval login sends sha256(secret + timestamp)", async () => {
    const { f, calls } = mockFetch({ [GROWW_ROOT + GROWW_PATHS.login]: () => jsonRes({ token: "gtok" }) });
    const { call, store } = await connect({ fetch: f });
    expect((await call("groww_login")).text).toMatch(/logged in until/);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.key_type).toBe("approval");
    expect(body.checksum).toBe(await sha256Hex("gs" + String(body.timestamp)));
    expect((calls[0].init.headers as any).Authorization).toBe("Bearer gk");
    expect((await store.get("groww"))?.token).toBe("gtok");
  });

  it("TOTP login", async () => {
    const { f, calls } = mockFetch({ [GROWW_ROOT + GROWW_PATHS.login]: () => jsonRes({ token: "gtok" }) });
    const { call } = await connect({ fetch: f });
    await call("groww_login", { totp: "654321" });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ key_type: "totp", totp: "654321" });
  });

  it("holdings without live data → ltp null, value null", async () => {
    const store = new MemStore();
    await store.put("groww", { token: "gtok", expiresAt: later() });
    const { f } = mockFetch({
      [GROWW_ROOT + GROWW_PATHS.holdings]: () => jsonRes(growwHoldingsBody),
      [GROWW_ROOT + GROWW_PATHS.ltp]: () => jsonRes({ status: "FAILURE", error: { code: "GA005", message: "plan" } }, 403),
    });
    const { call } = await connect({ fetch: f, store });
    const h = JSON.parse((await call("groww_holdings")).text);
    expect(h[0]).toMatchObject({ broker: "groww", symbol: "RELIANCE", qty: 5, avg_price: 2000, ltp: null, value: null, invested: 10000 });
  });

  it("holdings with live data → priced", async () => {
    const store = new MemStore();
    await store.put("groww", { token: "gtok", expiresAt: later() });
    const { f, calls } = mockFetch({
      [GROWW_ROOT + GROWW_PATHS.holdings]: () => jsonRes(growwHoldingsBody),
      [GROWW_ROOT + GROWW_PATHS.ltp]: () => jsonRes({ status: "SUCCESS", payload: { NSE_RELIANCE: 2200 } }),
    });
    const { call } = await connect({ fetch: f, store });
    const h = JSON.parse((await call("groww_holdings")).text);
    expect(h[0]).toMatchObject({ ltp: 2200, value: 11000, pnl: 1000, pnl_pct: 10 });
    expect(calls[1].url).toContain("exchange_symbols=NSE_RELIANCE");
  });
});

describe("get_portfolio", () => {
  it("merges both brokers with weights", async () => {
    const store = new MemStore();
    await store.put("angel", { token: "jwt", expiresAt: later() });
    await store.put("groww", { token: "gtok", expiresAt: later() });
    const { f } = mockFetch({
      [ANGEL_ROOT + ANGEL_PATHS.holdings]: () => jsonRes(angelHoldingsBody),
      [GROWW_ROOT + GROWW_PATHS.holdings]: () => jsonRes(growwHoldingsBody),
      [GROWW_ROOT + GROWW_PATHS.ltp]: () => jsonRes({ status: "SUCCESS", payload: { NSE_RELIANCE: 2200 } }),
    });
    const { call } = await connect({ fetch: f, store });
    const p = JSON.parse((await call("get_portfolio")).text);
    expect(p.totals).toEqual({ invested: 24000, value: 26000, pnl: 2000, pnl_pct: 8.33 });
    expect(p.holdings.map((h: any) => [h.symbol, h.weight_pct])).toEqual([["INFY-EQ", 57.69], ["RELIANCE", 42.31]]);
    expect(p.by_broker.angel).toEqual({ invested: 14000, value: 15000, count: 1 });
  });

  it("one broker logged out → partial result plus login hint", async () => {
    const store = new MemStore();
    await store.put("angel", { token: "jwt", expiresAt: later() });
    const { f } = mockFetch({ [ANGEL_ROOT + ANGEL_PATHS.holdings]: () => jsonRes(angelHoldingsBody) });
    const { call } = await connect({ fetch: f, store });
    const p = JSON.parse((await call("get_portfolio")).text);
    expect([...p.login_needed].sort()).toEqual(["groww", "kite"]);
    expect(p.notes[0]).toMatch(/Groww login needed/);
    expect(p.holdings).toHaveLength(1);
  });

  it("unpriced holdings are valued at cost", () => {
    const p = mergePortfolio([
      { broker: "groww", symbol: "X", exchange: null, isin: null, qty: 1, avg_price: 100, ltp: null, invested: 100, value: null, pnl: null, pnl_pct: null },
    ]);
    expect(p.totals.value).toBe(100);
    expect(p.unpriced).toEqual(["groww:X"]);
  });
});

describe("guards", () => {
  it("kill switch turns every tool off", async () => {
    const { client, call } = await connect({ env: { DISABLED: "true" } as any });
    const { tools } = await client.listTools();
    for (const t of tools) {
      const r = await call(t.name, t.name.endsWith("login") && t.name.startsWith("angel") ? { totp: "123456" } : {});
      expect(r.text).toMatch(/turned off/);
    }
  });

  it("other GitHub users are refused", async () => {
    const { call } = await connect({ githubId: "999" });
    expect((await call("auth_status")).text).toBe("Not allowed.");
  });

  it("empty allowlist refuses everyone", async () => {
    const { call } = await connect({ env: { ALLOWED_GITHUB_USER_ID: "" } as any });
    expect((await call("auth_status")).text).toBe("Not allowed.");
  });

  it("logs only tool name and status", async () => {
    const { f } = mockFetch({ [ANGEL_ROOT + ANGEL_PATHS.login]: () => jsonRes({ status: true, data: { jwtToken: "secret-jwt" } }) });
    const { call, logs } = await connect({ fetch: f });
    await call("angel_login", { totp: "123456" });
    await call("auth_status");
    expect(logs.map((l) => JSON.parse(l))).toEqual([
      { tool: "angel_login", status: "ok" },
      { tool: "auth_status", status: "ok" },
    ]);
    expect(logs.join()).not.toMatch(/secret-jwt|123456/);
  });
});
