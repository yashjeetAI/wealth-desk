import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { angelFunds, angelHoldings, angelLogin, angelPositions } from "./brokers/angel";
import { growwFunds, growwHoldings, growwLogin, growwPositions } from "./brokers/groww";
import { isAllowedUser, isDisabled, type Env } from "./env";
import { mergePortfolio } from "./portfolio";
import { BrokerError, LoginNeeded, type Broker, type Holding, type TokenStoreLike } from "./types";

type Config = Pick<
  Env,
  "ANGEL_API_KEY" | "ANGEL_CLIENT_CODE" | "ANGEL_MPIN" | "GROWW_API_KEY" | "GROWW_API_SECRET" | "DISABLED" | "ALLOWED_GITHUB_USER_ID"
>;

export interface ToolDeps {
  env: Config;
  store: TokenStoreLike;
  githubId: string | undefined;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

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
  "get_portfolio",
] as const;

const NAMES: Record<Broker, string> = { angel: "Angel One", groww: "Groww" };
const LOGIN_HINT: Record<Broker, string> = {
  angel: "Angel One login needed. Call angel_login with your 6-digit TOTP code.",
  groww: "Groww login needed. Approve your API key in Groww, then call groww_login.",
};

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (t: string, isError = false): Result => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });
const json = (v: unknown): Result => text(JSON.stringify(v, null, 2));

export function registerTools(server: McpServer, deps: ToolDeps): void {
  const f = deps.fetch ?? fetch;
  const log = deps.log ?? ((l: string) => console.log(l));
  const { env, store } = deps;
  const ro = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };

  async function token(broker: Broker): Promise<string> {
    const t = await store.get(broker);
    if (!t || t.expiresAt <= Date.now()) throw new LoginNeeded(broker);
    return t.token;
  }

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
      for (const b of ["angel", "groww"] as Broker[]) {
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

  const angelKey = () => need(env.ANGEL_API_KEY, "ANGEL_API_KEY", "angel");

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
    { description: "Groww stock holdings with qty and average price. LTP and P&L appear only if your Groww plan includes live data.", annotations: ro },
    wrap("groww_holdings", async () => json(await growwHoldings(await token("groww"), f))),
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
    "get_portfolio",
    {
      description:
        "One merged view of Angel One and Groww holdings: totals, per-broker split, and each holding's weight. Holdings without a live price are valued at cost and listed under 'unpriced'.",
      annotations: ro,
    },
    wrap("get_portfolio", async () => {
      const loginNeeded: Broker[] = [];
      const errors: string[] = [];
      const fetchers: Record<Broker, () => Promise<Holding[]>> = {
        angel: async () => angelHoldings(angelKey(), await token("angel"), f),
        groww: async () => growwHoldings(await token("groww"), f),
      };
      const results = await Promise.all(
        (Object.keys(fetchers) as Broker[]).map(async (b) => {
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
      const p = mergePortfolio(results.flat(), loginNeeded, errors);
      const notes = loginNeeded.map((b) => LOGIN_HINT[b]);
      return json(notes.length ? { ...p, notes } : p);
    }),
  );
}
