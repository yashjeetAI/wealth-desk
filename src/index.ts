import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { isDisabled, type Env, type Props } from "./env";
import { EventStore, pollNse } from "./events/store";
import GitHubHandler from "./github-handler";
import { tokenStore } from "./token-store";
import { registerTools } from "./tools";

export { TokenStore } from "./token-store";

export class PortfolioMCP extends McpAgent<Env, unknown, Props> {
  server = new McpServer({ name: "wealth-desk", version: "0.1.0" });

  async init() {
    registerTools(this.server, {
      env: this.env,
      store: tokenStore(this.env.TOKEN_STORE),
      githubId: this.props?.githubId,
      events: eventsDeps(this.env),
    });
  }
}

function eventsDeps(env: Env) {
  if (!env.EVENTS_KV) return undefined;
  const store = new EventStore(env.EVENTS_KV);
  return { source: store.source(), watch: (s: string[]) => store.setWatchlist(s) };
}

// The OAuth library needs this server's public URL, so build it on the first request.
let provider: OAuthProvider<Env> | undefined;

function getProvider(env: Env, req: Request): OAuthProvider<Env> {
  if (provider) return provider;
  const origin = (env.PUBLIC_URL || new URL(req.url).origin).replace(/\/+$/, "").toLowerCase();
  provider = new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: PortfolioMCP.serve("/mcp") as any,
    defaultHandler: GitHubHandler as any,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
  });
  return provider;
}

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    return getProvider(env, req).fetch(req, env, ctx);
  },
  /** Every 15 min: read NSE's announcements feed and keep filings for your stocks. */
  async scheduled(_event: ScheduledController, env: Env) {
    if (!env.EVENTS_KV || isDisabled(env)) return;
    const t = Date.now();
    try {
      const r = await pollNse(new EventStore(env.EVENTS_KV));
      console.log(JSON.stringify({ job: "nse_poll", status: "ok", ms: Date.now() - t, ...r }));
    } catch {
      console.log(JSON.stringify({ job: "nse_poll", status: "error", ms: Date.now() - t }));
    }
  },
} satisfies ExportedHandler<Env>;
