import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classify } from "../src/events";
import { NSE_RSS_URL, nseDate, parseNseRss, symbolFromLink } from "../src/events/nse-rss";
import { EventStore, pollNse } from "../src/events/store";
import { ANGEL_PATHS, ANGEL_ROOT } from "../src/brokers/angel";
import { MemStore, connect, jsonRes, mockFetch } from "./helpers";

const XML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/nse-rss.xml"), "utf8");
const NOW = new Date("2026-11-10T07:30:00Z"); // 13:00 IST

class MemKV {
  m = new Map<string, string>();
  puts = 0;
  async get(k: string) { return this.m.get(k) ?? null; }
  async put(k: string, v: string) { this.puts++; this.m.set(k, v); }
}
const feed = (xml = XML) => mockFetch({ [NSE_RSS_URL]: () => new Response(xml) }).f;

describe("NSE feed parsing", () => {
  it("reads items, symbols, subjects and IST dates", () => {
    const items = parseNseRss(XML);
    expect(items).toHaveLength(4); // the undated item is skipped
    expect(items[0]).toMatchObject({
      company: "Radico Khaitan Limited",
      symbol: "RADICO",
      category: "Action(s) initiated or orders passed",
      title: "Intimation under Regulation 30 of SEBI Listing Regulations",
      date: "2026-11-10T12:37:13+05:30",
    });
    expect(items[1].symbol).toBe("M&M");
    expect(items[1].company).toBe("Mahindra & Mahindra Limited");
    expect(items[2].symbol).toBeNull(); // XBRL link has no symbol
  });

  it("flags feed items by subject", () => {
    const flags = parseNseRss(XML).map((i) => classify(i.title, i.category));
    expect(flags).toEqual(["review", "watch", "info", "info"]);
  });

  it("parses dates and links", () => {
    expect(nseDate("1-Jan-2027 09:05:00")).toBe("2027-01-01T09:05:00+05:30");
    expect(nseDate("bad")).toBeNull();
    expect(symbolFromLink("https://nsearchives.nseindia.com/corporate/BAJAJ-AUTO_10112026120000_x.pdf")).toBe("BAJAJ-AUTO");
  });

  it("parses a full-size feed (280 items) quickly", () => {
    const one = XML.slice(XML.indexOf("<item>"), XML.indexOf("</item>") + 7);
    const big = `<rss><channel>${one.repeat(280)}</channel></rss>`;
    const t = performance.now();
    for (let i = 0; i < 20; i++) parseNseRss(big);
    const ms = (performance.now() - t) / 20;
    expect(parseNseRss(big)).toHaveLength(280);
    expect(ms).toBeLessThan(10); // Workers free plan: ~10ms CPU per run
  });
});

describe("scheduled poll", () => {
  it("keeps only watched symbols and skips items already seen", async () => {
    const kv = new MemKV();
    const store = new EventStore(kv as any);
    await store.setWatchlist(["INFY", "M&M"]);
    const r1 = await pollNse(store, feed(), NOW);
    expect(r1).toEqual({ items: 4, new_items: 4, matched: 2, watching: 2 });
    expect((await store.events("INFY"))[0].url).toMatch(/INFY_/);
    expect(await store.events("RADICO")).toEqual([]);
    expect(await store.seen()).toBe("2026-11-10T12:37:13+05:30");

    const before = kv.puts;
    const r2 = await pollNse(store, feed(), NOW);
    expect(r2.new_items).toBe(0);
    expect(kv.puts).toBe(before); // nothing new, no writes
  });

  it("drops filings older than 31 days and dedupes", async () => {
    const store = new EventStore(new MemKV() as any);
    const old = { title: "old", date: "2026-09-01T10:00:00+05:30", url: "u1" };
    const cur = { title: "new", date: "2026-11-09T10:00:00+05:30", url: "u2" };
    await store.add("INFY", [old, cur], NOW);
    await store.add("INFY", [cur], NOW);
    expect(await store.events("INFY")).toEqual([cur]);
  });

  it("fails loudly on a bad feed response", async () => {
    const f = mockFetch({ [NSE_RSS_URL]: () => new Response("no", { status: 503 }) }).f;
    await expect(pollNse(new EventStore(new MemKV() as any), f, NOW)).rejects.toThrow(/503/);
  });

  it("only writes the watchlist when it changes", async () => {
    const kv = new MemKV();
    const store = new EventStore(kv as any);
    await store.setWatchlist(["B", "A", "A"]);
    await store.setWatchlist(["A", "B"]);
    expect(kv.puts).toBe(1);
    expect(await store.watchlist()).toEqual(["A", "B"]);
  });
});

describe("tools save the watchlist", () => {
  const body = { status: true, data: { holdings: [{ tradingsymbol: "INFY-EQ", exchange: "NSE", isin: "INE009A01021", quantity: 1, averageprice: 1, ltp: 2 }] } };

  async function run(loggedIn: boolean) {
    const store = new MemStore();
    if (loggedIn) await store.put("angel", { token: "jwt", expiresAt: Date.now() + 3600_000 });
    const es = new EventStore(new MemKV() as any);
    const { f } = mockFetch({ [ANGEL_ROOT + ANGEL_PATHS.holdings]: () => jsonRes(body) });
    const { call } = await connect({
      fetch: f,
      store,
      env: { GROWW_API_KEY: "", KITE_API_KEY: "" } as any,
      events: { source: es.source(), watch: (s) => es.setWatchlist(s) },
    });
    await call("get_portfolio");
    return es.watchlist();
  }

  it("after a complete get_portfolio", async () => {
    expect(await run(true)).toEqual(["INFY"]);
  });

  it("not when a broker needs login (would drop stocks)", async () => {
    expect(await run(false)).toEqual([]);
  });
});
