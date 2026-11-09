// Zerodha Kite Connect v3. Read-only: login, holdings, positions, funds.
// Endpoints match the official pykiteconnect client (kiteconnect/connect.py).
import { BrokerError, LoginNeeded, type Funds, type Holding, type Position, type StoredToken } from "../types";
import { TIMEOUT_MS, nextIstHour, num, round, sha256Hex } from "../util";

export const KITE_ROOT = "https://api.kite.trade";
export const KITE_LOGIN_URL = "https://kite.zerodha.com/connect/login";
export const KITE_PATHS = {
  session: "/session/token",
  holdings: "/portfolio/holdings",
  positions: "/portfolio/positions",
  funds: "/user/margins",
  ltp: "/quote/ltp",
} as const;

export interface KiteConfig {
  apiKey: string;
  apiSecret: string;
}

/** The Zerodha page the user opens to log in. `state` comes back on the redirect. */
export function kiteLoginUrl(apiKey: string, state?: string): string {
  const u = new URL(KITE_LOGIN_URL);
  u.searchParams.set("v", "3");
  u.searchParams.set("api_key", apiKey);
  if (state) u.searchParams.set("redirect_params", new URLSearchParams({ state }).toString());
  return u.href;
}

function headers(apiKey: string, access?: string): Record<string, string> {
  const h: Record<string, string> = { "X-Kite-Version": "3", Accept: "application/json" };
  if (access) h.Authorization = `token ${apiKey}:${access}`;
  return h;
}

async function call(fetchFn: typeof fetch, path: string, init: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetchFn(KITE_ROOT + path, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new BrokerError("kite", "Zerodha did not answer in time.");
  }
  let body: any;
  try {
    body = await res.json();
  } catch {
    if (res.status === 401 || res.status === 403) throw new LoginNeeded("kite");
    throw new BrokerError("kite", `Zerodha returned HTTP ${res.status}.`);
  }
  // 403 also means "your plan lacks this" (PermissionException); only a bad token means log in again.
  if (body?.error_type === "TokenException" || (res.status === 403 && !body?.error_type)) throw new LoginNeeded("kite");
  if (!res.ok || body?.status === "error") {
    throw new BrokerError("kite", `Zerodha error: ${body?.message ?? "unknown"} (${body?.error_type ?? res.status})`);
  }
  return body?.data;
}

/** Swap the request_token from the login redirect for today's access token. */
export async function kiteLogin(cfg: KiteConfig, requestToken: string, fetchFn: typeof fetch = fetch): Promise<StoredToken> {
  if (!/^[A-Za-z0-9]{8,64}$/.test(requestToken)) throw new BrokerError("kite", "That request_token doesn't look right.");
  let data: any;
  try {
    data = await call(fetchFn, KITE_PATHS.session, {
      method: "POST",
      headers: { ...headers(cfg.apiKey), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        api_key: cfg.apiKey,
        request_token: requestToken,
        checksum: await sha256Hex(cfg.apiKey + requestToken + cfg.apiSecret),
      }).toString(),
    });
  } catch (e) {
    if (e instanceof LoginNeeded) throw new BrokerError("kite", "Zerodha rejected the login. Start again with kite_login.");
    throw e;
  }
  const token: string | undefined = data?.access_token;
  if (!token) throw new BrokerError("kite", "Zerodha login returned no token.");
  // Kite access tokens expire at 6 AM IST the next day.
  return { token, expiresAt: nextIstHour(6) };
}

function get(fetchFn: typeof fetch, apiKey: string, access: string, path: string) {
  return call(fetchFn, path, { method: "GET", headers: headers(apiKey, access) });
}

export function normalizeKiteHoldings(data: any): Holding[] {
  const list: any[] = Array.isArray(data) ? data : [];
  return list.map((h) => {
    // T1 shares are bought but not yet settled; they are still yours.
    const qty = (num(h.quantity) ?? 0) + (num(h.t1_quantity) ?? 0);
    const avg = num(h.average_price) ?? 0;
    const ltp = num(h.last_price);
    const invested = qty * avg;
    const value = ltp === null ? null : qty * ltp;
    const pnl = value === null ? null : value - invested;
    return {
      broker: "kite",
      symbol: String(h.tradingsymbol ?? ""),
      exchange: h.exchange ?? null,
      isin: h.isin ?? null,
      qty,
      avg_price: round(avg)!,
      ltp,
      invested: round(invested)!,
      value: round(value),
      pnl: round(pnl),
      pnl_pct: pnl === null || invested === 0 ? null : round((pnl / invested) * 100),
    };
  });
}

export function normalizeKitePositions(data: any): Position[] {
  const list: any[] = Array.isArray(data?.net) ? data.net : [];
  return list.map((p) => ({
    broker: "kite",
    symbol: String(p.tradingsymbol ?? ""),
    exchange: p.exchange ?? null,
    product: p.product ?? null,
    qty: num(p.quantity) ?? 0,
    avg_price: num(p.average_price),
    ltp: num(p.last_price),
    pnl: num(p.pnl),
  }));
}

export function normalizeKiteFunds(data: any): Funds {
  const eq = (data?.equity ?? {}) as Record<string, any>;
  return {
    broker: "kite",
    available_cash: num(eq.available?.live_balance) ?? num(eq.available?.cash) ?? num(eq.net),
    used_margin: num(eq.utilised?.debits),
    raw: eq,
  };
}

export async function kiteHoldings(apiKey: string, access: string, fetchFn: typeof fetch = fetch) {
  return normalizeKiteHoldings(await get(fetchFn, apiKey, access, KITE_PATHS.holdings));
}
export async function kitePositions(apiKey: string, access: string, fetchFn: typeof fetch = fetch) {
  return normalizeKitePositions(await get(fetchFn, apiKey, access, KITE_PATHS.positions));
}
export async function kiteFunds(apiKey: string, access: string, fetchFn: typeof fetch = fetch) {
  return normalizeKiteFunds(await get(fetchFn, apiKey, access, KITE_PATHS.funds));
}

/**
 * Last traded prices for "EXCHANGE:SYMBOL" keys, e.g. "NSE:INFY".
 * Needs a Kite Connect plan with market data; callers treat failure as "no price".
 */
export async function kiteLtp(apiKey: string, access: string, keys: string[], fetchFn: typeof fetch = fetch): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (let i = 0; i < keys.length; i += 500) {
    const qs = keys.slice(i, i + 500).map((k) => "i=" + encodeURIComponent(k)).join("&");
    const data = await get(fetchFn, apiKey, access, `${KITE_PATHS.ltp}?${qs}`);
    for (const [k, v] of Object.entries(data ?? {})) {
      const n = num((v as any)?.last_price);
      if (n !== null) out[k] = n;
    }
  }
  return out;
}
