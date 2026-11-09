// Groww Trade API. Read-only: login, holdings, positions, funds.
// Endpoints match the official growwapi Python client (growwapi/groww/client.py).
import { BrokerError, LoginNeeded, type Funds, type Holding, type Position, type StoredToken } from "../types";
import { TIMEOUT_MS, jwtExpiry, nextIstHour, num, round, sha256Hex } from "../util";

export const GROWW_ROOT = "https://api.groww.in/v1";
export const GROWW_PATHS = {
  login: "/token/api/access",
  holdings: "/holdings/user",
  positions: "/positions/user",
  funds: "/margins/detail/user",
  ltp: "/live-data/ltp",
} as const;

export interface GrowwConfig {
  apiKey: string;
  apiSecret?: string;
}

function headers(bearer: string): Record<string, string> {
  return {
    "x-request-id": crypto.randomUUID(),
    Authorization: `Bearer ${bearer}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "x-api-version": "1.0",
  };
}

async function call(fetchFn: typeof fetch, url: string, init: RequestInit, timeoutMs = TIMEOUT_MS): Promise<any> {
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new BrokerError("groww", "Groww did not answer in time.");
  }
  if (res.status === 401 || res.status === 403) throw new LoginNeeded("groww");
  let body: any;
  try {
    body = await res.json();
  } catch {
    throw new BrokerError("groww", `Groww returned HTTP ${res.status}.`);
  }
  if (body?.status === "FAILURE") {
    const err = body.error ?? {};
    throw new BrokerError("groww", `Groww error: ${err.message ?? err.displayMessage ?? "unknown"} (${err.code ?? res.status})`);
  }
  if (!res.ok) {
    const msg = body?.error?.displayMessage ?? body?.error?.message;
    throw new BrokerError("groww", `Groww returned HTTP ${res.status}${msg ? `: ${msg}` : ""}.`);
  }
  return body && typeof body === "object" && "payload" in body ? body.payload : body;
}

/**
 * Get today's Groww access token.
 * - With a TOTP code: uses a TOTP-type API key.
 * - Without: uses an approval-type key + secret (approve the key in Groww first each day).
 */
export async function growwLogin(cfg: GrowwConfig, totp?: string, fetchFn: typeof fetch = fetch): Promise<StoredToken> {
  let data: Record<string, unknown>;
  if (totp) {
    if (!/^\d{6}$/.test(totp)) throw new BrokerError("groww", "The TOTP code must be 6 digits.");
    data = { key_type: "totp", totp };
  } else {
    if (!cfg.apiSecret) throw new BrokerError("groww", "No GROWW_API_SECRET set. Pass a TOTP code instead.");
    const timestamp = Math.floor(Date.now() / 1000);
    data = { key_type: "approval", checksum: await sha256Hex(cfg.apiSecret + String(timestamp)), timestamp };
  }
  let body: any;
  try {
    body = await call(fetchFn, GROWW_ROOT + GROWW_PATHS.login, {
      method: "POST",
      headers: headers(cfg.apiKey),
      body: JSON.stringify(data),
    }, 8000);
  } catch (e) {
    if (e instanceof LoginNeeded) throw new BrokerError("groww", "Groww rejected the login. Check the API key, and approve it in Groww today.");
    throw e;
  }
  const token: string | undefined = body?.token;
  if (!token) throw new BrokerError("groww", "Groww login returned no token.");
  // Groww tokens expire at 6:00 AM IST.
  const exp = Math.min(jwtExpiry(token) ?? Infinity, nextIstHour(6));
  return { token, expiresAt: exp };
}

function get(fetchFn: typeof fetch, token: string, path: string, query?: Record<string, string>) {
  const qs = query ? "?" + new URLSearchParams(query).toString() : "";
  return call(fetchFn, GROWW_ROOT + path + qs, { method: "GET", headers: headers(token) });
}

export function normalizeGrowwHoldings(payload: any, ltps: Record<string, number> = {}): Holding[] {
  const list: any[] = payload?.holdings ?? [];
  return list.map((h) => {
    const symbol = String(h.trading_symbol ?? "");
    const qty = num(h.quantity) ?? 0;
    const avg = num(h.average_price) ?? 0;
    const ltp = ltps[symbol] ?? null;
    const invested = qty * avg;
    const value = ltp === null ? null : qty * ltp;
    const pnl = value === null ? null : value - invested;
    return {
      broker: "groww",
      symbol,
      exchange: ltp === null ? null : "NSE",
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

export function normalizeGrowwPositions(payload: any): Position[] {
  const list: any[] = payload?.positions ?? [];
  return list.map((p) => ({
    broker: "groww",
    symbol: String(p.trading_symbol ?? ""),
    exchange: p.exchange ?? null,
    product: p.product ?? null,
    qty: num(p.quantity) ?? 0,
    avg_price: num(p.net_price),
    ltp: null,
    pnl: num(p.realised_pnl),
  }));
}

export function normalizeGrowwFunds(payload: any): Funds {
  const raw = (payload ?? {}) as Record<string, unknown>;
  return {
    broker: "groww",
    available_cash: num(raw.clear_cash),
    used_margin: num(raw.net_margin_used),
    raw,
  };
}

/** Best effort: live prices need Groww's paid plan, so failures just mean no LTP. */
async function growwLtps(fetchFn: typeof fetch, token: string, symbols: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const batches: string[][] = [];
  for (let i = 0; i < symbols.length; i += 50) batches.push(symbols.slice(i, i + 50));
  await Promise.all(
    batches.map(async (batch) => {
      try {
        const p = await get(fetchFn, token, GROWW_PATHS.ltp, {
          segment: "CASH",
          exchange_symbols: batch.map((s) => `NSE_${s}`).join(","),
        });
        for (const [k, v] of Object.entries(p ?? {})) {
          const n = num(v);
          if (n !== null) out[k.replace(/^NSE_/, "")] = n;
        }
      } catch {
        // LTP is optional: the free plan may not include live data.
      }
    }),
  );
  return out;
}

export async function growwHoldings(token: string, fetchFn: typeof fetch = fetch) {
  const payload = await get(fetchFn, token, GROWW_PATHS.holdings);
  const symbols = (payload?.holdings ?? []).map((h: any) => String(h.trading_symbol ?? "")).filter(Boolean);
  const ltps = symbols.length ? await growwLtps(fetchFn, token, symbols) : {};
  return normalizeGrowwHoldings(payload, ltps);
}
export async function growwPositions(token: string, fetchFn: typeof fetch = fetch) {
  return normalizeGrowwPositions(await get(fetchFn, token, GROWW_PATHS.positions));
}
export async function growwFunds(token: string, fetchFn: typeof fetch = fetch) {
  return normalizeGrowwFunds(await get(fetchFn, token, GROWW_PATHS.funds));
}
