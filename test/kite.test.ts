import { describe, expect, it } from "vitest";
import { KITE_PATHS, KITE_ROOT } from "../src/brokers/kite";
import { handleKiteCallback } from "../src/kite-callback";
import { sha256Hex } from "../src/util";
import { MemStore, baseEnv, connect, jsonRes, mockFetch } from "./helpers";

const later = () => Date.now() + 3600_000;
const sessionOk = () => jsonRes({ status: "success", data: { access_token: "acc123" } });
const holdingsBody = {
  status: "success",
  data: [{ tradingsymbol: "TCS", exchange: "NSE", isin: "INE467B01029", quantity: 3, t1_quantity: 1, average_price: 3000, last_price: 3500 }],
};

describe("kite", () => {
  it("kite_login with no args gives a login link and saves a one-time state", async () => {
    const { call, store } = await connect({});
    const r = await call("kite_login");
    const link = new URL(r.text.match(/https:\/\/kite\.zerodha\.com\S+/)![0]);
    expect(link.searchParams.get("api_key")).toBe("kk");
    const state = new URLSearchParams(link.searchParams.get("redirect_params")!).get("state")!;
    expect(store.states.has(state)).toBe(true);
    expect(r.text).toContain("https://pm.example.workers.dev/kite/callback");
  });

  it("kite_login with request_token stores the token; checksum is correct", async () => {
    const { f, calls } = mockFetch({ [KITE_ROOT + KITE_PATHS.session]: sessionOk });
    const { call, store } = await connect({ fetch: f });
    const r = await call("kite_login", { request_token: "reqTok123" });
    expect(r.text).toMatch(/logged in until/);
    expect((await store.get("kite"))?.token).toBe("acc123");
    const body = new URLSearchParams(String(calls[0].init.body));
    expect(body.get("checksum")).toBe(await sha256Hex("kk" + "reqTok123" + "ks"));
    expect(JSON.stringify([...store.m.values()])).not.toContain("ks");
  });

  it("holdings come back in the common shape (T1 included)", async () => {
    const store = new MemStore();
    await store.put("kite", { token: "acc", expiresAt: later() });
    const { f, calls } = mockFetch({ [KITE_ROOT + KITE_PATHS.holdings]: () => jsonRes(holdingsBody) });
    const { call } = await connect({ fetch: f, store });
    const h = JSON.parse((await call("kite_holdings")).text);
    expect(h[0]).toMatchObject({ broker: "kite", symbol: "TCS", qty: 4, avg_price: 3000, ltp: 3500, value: 14000, pnl: 2000, pnl_pct: 16.67 });
    expect((calls[0].init.headers as any).Authorization).toBe("token kk:acc");
    expect(calls[0].init.method).toBe("GET");
  });

  it("TokenException → login needed and token cleared", async () => {
    const store = new MemStore();
    await store.put("kite", { token: "acc", expiresAt: later() });
    const { f } = mockFetch({ [KITE_ROOT]: () => jsonRes({ status: "error", error_type: "TokenException", message: "expired" }, 403) });
    const { call } = await connect({ fetch: f, store });
    expect((await call("kite_funds")).text).toMatch(/Zerodha login needed/);
    expect(await store.get("kite")).toBeNull();
  });

  it("positions and funds", async () => {
    const store = new MemStore();
    await store.put("kite", { token: "acc", expiresAt: later() });
    const { f } = mockFetch({
      [KITE_ROOT + KITE_PATHS.positions]: () =>
        jsonRes({ status: "success", data: { net: [{ tradingsymbol: "NIFTY", exchange: "NFO", product: "NRML", quantity: 50, average_price: 100, last_price: 110, pnl: 500 }] } }),
      [KITE_ROOT + KITE_PATHS.funds]: () =>
        jsonRes({ status: "success", data: { equity: { net: 900, available: { cash: 1000, live_balance: 950 }, utilised: { debits: 50 } } } }),
    });
    const { call } = await connect({ fetch: f, store });
    expect(JSON.parse((await call("kite_positions")).text)[0]).toMatchObject({ symbol: "NIFTY", qty: 50, pnl: 500 });
    expect(JSON.parse((await call("kite_funds")).text)).toMatchObject({ available_cash: 950, used_margin: 50 });
  });

  it("get_portfolio skips brokers that are not set up", async () => {
    const store = new MemStore();
    await store.put("kite", { token: "acc", expiresAt: later() });
    const { f } = mockFetch({ [KITE_ROOT + KITE_PATHS.holdings]: () => jsonRes(holdingsBody) });
    const { call } = await connect({ fetch: f, store, env: { ANGEL_API_KEY: "", GROWW_API_KEY: "" } as any });
    const p = JSON.parse((await call("get_portfolio")).text);
    expect(p.holdings).toHaveLength(1);
    expect(p.errors).toEqual([]);
    expect(p.login_needed).toEqual([]);
    expect(JSON.parse((await call("auth_status")).text).angel).toEqual({ configured: false });
  });
});

describe("kite callback", () => {
  const env = { KITE_API_KEY: "kk", KITE_API_SECRET: "ks", DISABLED: "false" };
  const url = (q: string) => new URL(`https://pm.example.workers.dev/kite/callback?${q}`);

  it("valid state + success logs in, and the state works only once", async () => {
    const store = new MemStore();
    await store.putState("s1", 60_000);
    const { f } = mockFetch({ [KITE_ROOT + KITE_PATHS.session]: sessionOk });
    const r = await handleKiteCallback(url("status=success&request_token=reqTok123&state=s1"), env, store, f);
    expect(r.status).toBe(200);
    expect((await store.get("kite"))?.token).toBe("acc123");
    const again = await handleKiteCallback(url("status=success&request_token=reqTok123&state=s1"), env, store, f);
    expect(again.status).toBe(400);
  });

  it("unknown or missing state is refused without calling Zerodha", async () => {
    const { f, calls } = mockFetch({});
    const store = new MemStore();
    expect((await handleKiteCallback(url("status=success&request_token=reqTok123&state=nope"), env, store, f)).status).toBe(400);
    expect((await handleKiteCallback(url("status=success&request_token=reqTok123"), env, store, f)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("expired state is refused", async () => {
    const store = new MemStore();
    await store.putState("old", -1);
    const r = await handleKiteCallback(url("status=success&request_token=reqTok123&state=old"), env, store);
    expect(r.status).toBe(400);
  });

  it("kill switch blocks the callback", async () => {
    const r = await handleKiteCallback(url("state=s"), { ...env, DISABLED: "true" }, new MemStore());
    expect(r.status).toBe(403);
  });
});
