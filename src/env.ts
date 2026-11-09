import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  // Secrets (wrangler secret put ...)
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ANGEL_API_KEY?: string;
  ANGEL_CLIENT_CODE?: string;
  ANGEL_MPIN?: string;
  GROWW_API_KEY?: string;
  GROWW_API_SECRET?: string;
  // Vars (wrangler.jsonc)
  ALLOWED_GITHUB_USER_ID: string;
  DISABLED?: string;
  PUBLIC_URL?: string;
  // Bindings
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  MCP_OBJECT: DurableObjectNamespace;
  TOKEN_STORE: DurableObjectNamespace<import("./token-store").TokenStore>;
}

/** Set by the GitHub login, encrypted in the OAuth grant. */
export type Props = { githubId: string; login: string };

export function isDisabled(env: Pick<Env, "DISABLED">): boolean {
  return ["1", "true", "yes", "on"].includes(String(env.DISABLED ?? "").trim().toLowerCase());
}

export function isAllowedUser(env: Pick<Env, "ALLOWED_GITHUB_USER_ID">, githubId: string | undefined): boolean {
  const allowed = String(env.ALLOWED_GITHUB_USER_ID ?? "").trim();
  return allowed !== "" && githubId !== undefined && String(githubId) === allowed;
}
