// GET /kite/callback: Zerodha sends the browser here after login with a one-time request_token.
import { kiteLogin } from "./brokers/kite";
import { isDisabled, type Env } from "./env";
import { BrokerError, type TokenStoreLike } from "./types";

type KiteEnv = Pick<Env, "KITE_API_KEY" | "KITE_API_SECRET" | "DISABLED">;

/** Returns a short message for the page and an HTTP status. */
export async function handleKiteCallback(
  url: URL,
  env: KiteEnv,
  store: TokenStoreLike,
  fetchFn: typeof fetch = fetch,
): Promise<{ status: number; message: string }> {
  if (isDisabled(env)) return { status: 403, message: "This server is turned off." };
  const state = url.searchParams.get("state") ?? "";
  // Only links made by kite_login are accepted, once, within 10 minutes.
  if (!state || !(await store.takeState(state))) {
    return { status: 400, message: "This login link has expired or was already used. Ask Claude to run kite_login again." };
  }
  const requestToken = url.searchParams.get("request_token");
  if (url.searchParams.get("status") !== "success" || !requestToken) {
    return { status: 400, message: "Zerodha login was cancelled or failed. Ask Claude to run kite_login again." };
  }
  if (!env.KITE_API_KEY || !env.KITE_API_SECRET) return { status: 500, message: "Zerodha keys are not set on the server." };
  try {
    const t = await kiteLogin({ apiKey: env.KITE_API_KEY, apiSecret: env.KITE_API_SECRET }, requestToken, fetchFn);
    await store.put("kite", t);
    console.log(JSON.stringify({ event: "kite_login", status: "ok" }));
    return { status: 200, message: `Zerodha is logged in until ${new Date(t.expiresAt).toISOString()}. You can close this tab and go back to Claude.` };
  } catch (e) {
    console.log(JSON.stringify({ event: "kite_login", status: "error" }));
    return { status: 502, message: e instanceof BrokerError ? e.message : "Zerodha login failed. Try again." };
  }
}
