import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { angelFunds, angelHoldings, angelLogin, angelLtp, angelPositions, angelSymbolToken, type Exchange } from "./brokers/angel";
import { growwFunds, growwHoldings, growwLogin, growwPositions } from "./brokers/groww";
import { kiteFunds, kiteHoldings, kiteLogin, kiteLoginUrl, kiteLtp, kitePositions } from "./brokers/kite";
import { isAllowedUser, isDisabled, type Env } from "./env";
import { applyQuotes, baseSymbol, mergePortfolio, quoteKeys } from "./portfolio";
import { BrokerError, LoginNeeded, type Broker, type Holding, type TokenStoreLike } from "./types";

type Config = Pick<
  Env,
  | "ANGEL_API_KEY"
  | "ANGEL_CLIENT_CODE"
  | "ANGEL_MPIN"
  | "GROWW_API_KEY"
  | "GROWW_API_SECRET"
  | "KITE_API_KEY"
  | "KITE_API_SECRET"
  | "DISABLED"
  | "ALLOWED_GITHUB_USER_ID"
  | "PUBLIC_URL"
>;

export interface ToolDeps {
  env: Config;
  store: TokenStoreLike;
  githubId: string | undefined;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  /** Pause between rate-limited calls (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

/** Angel allows about one symbol search per second. */
export const ANGEL_SEARCH_GAP_MS = 1100;

/** Every tool name this server exposes. The no-orders test checks this list. */
export const TOOL_NAMES = [
  "auth_status",
  "angel_login",
  "angel_holdings",
  "angel_positions",
  "angel_funds",
  "groww_login",
  "groww_holdings",
  "groww_positions",
  "groww_funds",
  "kite_login",
  "kite_holdings",
  "kite_positions",
  "kite_funds",
  "get_portfolio",
] as const;

const NAMES: Record<Broker, string> = { angel: "Angel One", groww: "Groww", kite: "Zerodha" };
const BROKERS: Broker[] = ["angel", "groww", "kite"];
/** How long a kite_login link stays valid. */
export const KITE_STATE_TTL_MS = 10 * 60 * 1000;
const LOGIN_HINT: Record<Broker, string> = {
  angel: "Angel One login needed. Call angel_login with your 6-digit TOTP code.",
  groww: "Groww login needed. Approve your API key in Groww, then call groww_login.",
  kite: "Zerodha login needed. Call kite_login and open the link it gives you.",
};

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (t: string, isError = false): Result => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });
const json = (v: unknown): Result => text(JSON.stringify(v, null, 2));

export function registerTools(server: McpServer, deps: ToolDeps): void {
  const f = deps.fetch ?? fetch;
  const log = deps.log ?? ((l: string) => console.log(l));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const { env, store } = deps;
  const ro = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };

  async function token(broker: Broker): Promise<string> {
    const t = await store.get(broker);
    if (!t || t.expiresAt <= Date.now()) throw new LoginNeeded(broker);
    return t.token;
  }

  /** A broker counts as set up once its API key is on the server. */
  const configured = (b: Broker) =>
    !!{ angel: env.ANGEL_API_KEY, groww: env.GROWW_API_KEY, kite: env.KITE_API_KEY }[b];

  function need(v: string | undefined, name: string, broker: Broker): string {
    if (!v) throw new BrokerError(broker, `${name} is not set on the server.`);
    return v;
  }

  /** Wrap a tool: kill switch, owner check, logging (name + status only), friendly errors. */
  function wrap<A>(name: string, fn: (args: A) => Promise<Result>) {
    return async (args: A): Promise<Result> => {
      let status = "ok";
      try {
        if (isDisabled(env)) {
          status = "disabled";
          return text("Portfolio MCP is turned off (DISABLED is set).", true);
        }
        if (!isAllowedUser(env, deps.githubId)) {
          status = "forbidden";
          return text("Not allowed.", true);
        }
        return await fn(args);
      } catch (e) {
        if (e instanceof LoginNeeded) {
          status = "login_needed";
          await store.clear(e.broker).catch(() => {});
          return text(LOGIN_HINT[e.broker]);
        }
        status = "error";
        if (e instanceof BrokerError) return text(e.message, true);
        return text("Something went wrong. Try again.", true);
      } finally {
        log(JSON.stringify({ tool: name, status }));
      }
    };
  }

  server.registerTool(
    "auth_status",
    { description: "Show which brokers are logged in today and when each login expires.", annotations: { ...ro, openWorldHint: false } },
    wrap("auth_status", async () => {
      const out: Record<string, unknown> = {};
      for (const b of BROKERS) {
        if (!configured(b)) {
          out[b] = { configured: false };
          continue;
        }
        const t = await store.get(b);
        const live = !!t && t.expiresAt > Date.now();
        out[b] = live ? { logged_in: true, expires_at: new Date(t!.expiresAt).toISOString() } : { logged_in: false, hint: LOGIN_HINT[b] };
      }
      return json(out);
    }),
  );

  server.registerTool(
    "angel_login",
    {
      description: "Log in to Angel One for today with the 6-digit code from your authenticator app. Read-only session.",
      inputSchema: { totp: z.string().regex(/^\d{6}$/, "6 digits").describe("6-digit TOTP code") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    wrap("angel_login", async ({ totp }: { totp: string }) => {
      const t = await angelLogin(
        {
          apiKey: need(env.ANGEL_API_KEY, "ANGEL_API_KEY", "angel"),
          clientCode: need(env.ANGEL_CLIENT_CODE, "ANGEL_CLIENT_CODE", "angel"),
          mpin: need(env.ANGEL_MPIN, "ANGEL_MPIN", "angel"),
        },
        totp,
        f,
      );
      await store.put("angel", t);
      return text(`Angel One logged in until ${new Date(t.expiresAt).toISOString()}.`);
    }),
  );

  server.registerTool(
    "groww_login",
    {
      description:
        "Log in to Groww for today. With an approval-type key, approve it in Groww first and call with no arguments. With a TOTP-type key, pass the 6-digit code.",
      inputSchema: { totp: z.string().regex(/^\d{6}$/, "6 digits").optional().describe("6-digit TOTP code, only for TOTP-type keys") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    wrap("groww_login", async ({ totp }: { totp?: string }) => {
      const t = await growwLogin({ apiKey: need(env.GROWW_API_KEY, "GROWW_API_KEY", "groww"), apiSecret: env.GROWW_API_SECRET }, totp, f);
      await store.put("groww", t);
      return text(`Groww logged in until ${new Date(t.expiresAt).toISOString()}.`);
    }),
  );

  server.registerTool(
    "kite_login",
    {
      description:
        "Log in to Zerodha (Kite) for today. Call with no arguments to get a login link; after logging in you are sent back and logged in automatically. If your Kite app redirects elsewhere, pass the request_token from the address bar.",
      inputSchema: {
        request_token: z.string().regex(/^[A-Za-z0-9]{8,64}$/, "letters and digits").optional().describe("request_token from the Kite redirect URL"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    wrap("kite_login", async ({ request_token }: { request_token?: string }) => {
      const apiKey = need(env.KITE_API_KEY, "KITE_API_KEY", "kite");
      if (!request_token) {
        const state = crypto.randomUUID();
        await store.putState(state, KITE_STATE_TTL_MS);
        const back = env.PUBLIC_URL ? ` You will be sent back to ${env.PUBLIC_URL.replace(/\/+$/, "")}/kite/callback.` : "";
        return text(`Open this link and log in to Zerodha (valid 10 minutes):\n${kiteLoginUrl(apiKey, state)}\n${back}`.trim());
      }
      const t = await kiteLogin({ apiKey, apiSecret: need(env.KITE_API_SECRET, "KITE_API_SECRET", "kite") }, request_token, f);
      await store.put("kite", t);
      return text(`Zerodha logged in until ${new Date(t.expiresAt).toISOString()}.`);
    }),
  );

  const angelKey = () => need(env.ANGEL_API_KEY, "ANGEL_API_KEY", "angel");
  const kiteKey = () => need(env.KITE_API_KEY, "KITE_API_KEY", "kite");

  /** Today's token for a broker, or null if logged out. Never throws. */
  async function liveToken(b: Broker): Promise<string | null> {
    if (!configured(b)) return null;
    const t = await store.get(b).catch(() => null);
    return t && t.expiresAt > Date.now() ? t.token : null;
  }

  /** Angel quotes for unpriced holdings. Symbol tokens are looked up once and cached. */
  async function angelQuotes(jwt: string, hs: Holding[]): Promise<Record<string, number>> {
    const syms = [...new Set(hs.filter((h) => h.ltp === null && h.symbol).map((h) => baseSymbol(h.symbol)))];
    const tokens: Record<string, string> = {};
    let searched = false;
    /** Cached token, else one paced lookup. undefined = lookup failed (don't guess another exchange). */
    const lookup = async (ex: Exchange, sym: string): Promise<string | null | undefined> => {
      const cached = await store.getCache(`angel:${ex}:${sym}`).catch(() => null);
      if (cached) return cached;
      if (searched) await sleep(ANGEL_SEARCH_GAP_MS);
      searched = true;
      let tok: string | null;
      try {
        tok = await angelSymbolToken(angelKey(), jwt, ex, sym, f);
      } catch {
        return undefined;
      }
      if (tok) await store.putCache(`angel:${ex}:${sym}`, tok).catch(() => {});
      return tok;
    };
    for (const sym of syms) {
      for (const ex of ["NSE", "BSE"] as Exchange[]) {
        const tok = await lookup(ex, sym);
        if (tok === undefined) break;
        if (tok) {
          tokens[`${ex}:${sym}`] = tok;
          break;
        }
      }
    }
    return angelLtp(angelKey(), jwt, tokens, f);
  }

  /**
   * Price holdings that have none (Groww's free plan): Kite quotes first, then Angel's free quotes.
   * Best effort: a logged-out broker or a failed lookup just leaves holdings unpriced.
   */
  async function borrowPrices(hs: Holding[]): Promise<Holding[]> {
    const sources: [Broker, (tok: string, hs: Holding[]) => Promise<Record<string, number>>][] = [
      ["kite", (tok, hs) => kiteLtp(kiteKey(), tok, quoteKeys(hs), f)],
      ["angel", angelQuotes],
    ];
    for (const [broker, quotes] of sources) {
      if (!quoteKeys(hs).length) break;
      const tok = await liveToken(broker);
      if (!tok) continue;
      try {
        hs = applyQuotes(hs, await quotes(tok, hs), broker);
      } catch {
        // Try the next source.
      }
    }
    return hs;
  }

  server.registerTool(
    "angel_holdings",
    { description: "Angel One long-term holdings with qty, average price, LTP, value and P&L.", annotations: ro },
    wrap("angel_holdings", async () => json(await angelHoldings(angelKey(), await token("angel"), f))),
  );
  server.registerTool(
    "angel_positions",
    { description: "Angel One open positions for today.", annotations: ro },
    wrap("angel_positions", async () => json(await angelPositions(angelKey(), await token("angel"), f))),
  );
  server.registerTool(
    "angel_funds",
    { description: "Angel One available cash and margin used.", annotations: ro },
    wrap("angel_funds", async () => json(await angelFunds(angelKey(), await token("angel"), f))),
  );
  server.registerTool(
    "groww_holdings",
    {
      description:
        "Groww stock holdings with qty, average price, LTP, value and P&L. If Groww has no live prices, they are taken from Zerodha or Angel One when logged in (see price_source).",
      annotations: ro,
    },
    wrap("groww_holdings", async () => json(await borrowPrices(await growwHoldings(await token("groww"), f)))),
  );
  server.registerTool(
    "groww_positions",
    { description: "Groww open positions.", annotations: ro },
    wrap("groww_positions", async () => json(await growwPositions(await token("groww"), f))),
  );
  server.registerTool(
    "groww_funds",
    { description: "Groww available cash and margin used.", annotations: ro },
    wrap("groww_funds", async () => json(await growwFunds(await token("groww"), f))),
  );

  server.registerTool(
    "kite_holdings",
    { description: "Zerodha long-term holdings with qty, average price, LTP, value and P&L.", annotations: ro },
    wrap("kite_holdings", async () => json(await kiteHoldings(kiteKey(), await token("kite"), f))),
  );
  server.registerTool(
    "kite_positions",
    { description: "Zerodha open positions for today.", annotations: ro },
    wrap("kite_positions", async () => json(await kitePositions(kiteKey(), await token("kite"), f))),
  );
  server.registerTool(
    "kite_funds",
    { description: "Zerodha available cash and margin used (equity segment).", annotations: ro },
    wrap("kite_funds", async () => json(await kiteFunds(kiteKey(), await token("kite"), f))),
  );

  server.registerTool(
    "get_portfolio",
    {
      description:
        "One merged view of Angel One, Groww and Zerodha holdings: totals, per-broker split, and each holding's weight. Missing prices are taken from Zerodha or Angel One when logged in; any still missing are valued at cost and listed under 'unpriced'.",
      annotations: ro,
    },
    wrap("get_portfolio", async () => {
      const loginNeeded: Broker[] = [];
      const errors: string[] = [];
      const fetchers: Record<Broker, () => Promise<Holding[]>> = {
        angel: async () => angelHoldings(angelKey(), await token("angel"), f),
        groww: async () => growwHoldings(await token("groww"), f),
        kite: async () => kiteHoldings(kiteKey(), await token("kite"), f),
      };
      const results = await Promise.all(
        BROKERS.filter(configured).map(async (b) => {
          try {
            return await fetchers[b]();
          } catch (e) {
            if (e instanceof LoginNeeded) {
              loginNeeded.push(b);
              await store.clear(b).catch(() => {});
            } else errors.push(e instanceof BrokerError ? e.message : `${NAMES[b]}: unexpected error`);
            return [];
          }
        }),
      );
      const p = mergePortfolio(await borrowPrices(results.flat()), loginNeeded, errors);
      const notes = loginNeeded.map((b) => LOGIN_HINT[b]);
      if (p.unpriced.length && (loginNeeded.includes("kite") || loginNeeded.includes("angel"))) {
        notes.push(`${p.unpriced.length} holdings have no live price and are valued at cost. Log in to Zerodha or Angel One to price them.`);
      }
      return json(notes.length ? { ...p, notes } : p);
    }),
  );
}
