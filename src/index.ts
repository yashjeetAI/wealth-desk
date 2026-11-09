import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import type { Env, Props } from "./env";
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
    });
  }
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
} satisfies ExportedHandler<Env>;
