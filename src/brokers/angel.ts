// Angel One SmartAPI. Read-only: login, holdings, positions, funds.
// Endpoints match the official smartapi-python client (SmartApi/smartConnect.py).
import { BrokerError, LoginNeeded, type Funds, type Holding, type Position, type StoredToken } from "../types";
import { TIMEOUT_MS, jwtExpiry, nextIstHour, num, round } from "../util";

export const ANGEL_ROOT = "https://apiconnect.angelone.in";
export const ANGEL_PATHS = {
  login: "/rest/auth/angelbroking/user/v1/loginByPassword",
  holdings: "/rest/secure/angelbroking/portfolio/v1/getHolding",
  positions: "/rest/secure/angelbroking/order/v1/getPosition",
  funds: "/rest/secure/angelbroking/user/v1/getRMS",
} as const;

export interface AngelConfig {
  apiKey: string;
  clientCode: string;
  mpin: string;
}

function headers(apiKey: string, jwt?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-UserType": "USER",
    "X-SourceID": "WEB",
    "X-ClientLocalIP": "127.0.0.1",
    "X-ClientPublicIP": "127.0.0.1",
    "X-MACAddress": "00:00:00:00:00:00",
    "X-PrivateKey": apiKey,
  };
  if (jwt) h.Authorization = `Bearer ${jwt}`;
  return h;
}

const TOKEN_ERRORS = new Set(["AG8001", "AG8002", "AG8003", "AB8050", "AB8051", "AB1010"]);

async function call(fetchFn: typeof fetch, path: string, init: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetchFn(ANGEL_ROOT + path, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new BrokerError("angel", "Angel One did not answer in time.");
  }
  if (res.status === 401 || res.status === 403) throw new LoginNeeded("angel");
  let body: any;
  try {
    body = await res.json();
  } catch {
    throw new BrokerError("angel", `Angel One returned HTTP ${res.status}.`);
  }
  if (body?.status === false || body?.success === false) {
    if (TOKEN_ERRORS.has(body.errorcode) || body.error_type === "TokenException") throw new LoginNeeded("angel");
    throw new BrokerError("angel", `Angel One error: ${body.message ?? "unknown"} (${body.errorcode ?? res.status})`);
  }
  if (!res.ok) throw new BrokerError("angel", `Angel One returned HTTP ${res.status}.`);
  return body;
}

export async function angelLogin(cfg: AngelConfig, totp: string, fetchFn: typeof fetch = fetch): Promise<StoredToken> {
  if (!/^\d{6}$/.test(totp)) throw new BrokerError("angel", "The TOTP code must be 6 digits.");
  let body: any;
  try {
    body = await call(fetchFn, ANGEL_PATHS.login, {
      method: "POST",
      headers: headers(cfg.apiKey),
      body: JSON.stringify({ clientcode: cfg.clientCode, password: cfg.mpin, totp }),
    });
  } catch (e) {
    // A failed login is never "login needed"; surface the real reason.
    if (e instanceof LoginNeeded) throw new BrokerError("angel", "Angel One rejected the login. Check the TOTP code.");
    throw e;
  }
  const jwt: string | undefined = body?.data?.jwtToken;
  if (!jwt) throw new BrokerError("angel", "Angel One login returned no token.");
  const token = jwt.replace(/^Bearer\s+/i, "");
  // Angel sessions end at midnight IST; use the JWT expiry if it is earlier.
  const exp = Math.min(jwtExpiry(token) ?? Infinity, nextIstHour(0));
  return { token, expiresAt: exp };
}

function get(fetchFn: typeof fetch, apiKey: string, jwt: string, path: string) {
  return call(fetchFn, path, { method: "GET", headers: headers(apiKey, jwt) });
}

export function normalizeAngelHoldings(data: any): Holding[] {
  const list: any[] = Array.isArray(data) ? data : (data?.holdings ?? []);
  return list.map((h) => {
    const qty = num(h.quantity) ?? 0;
    const avg = num(h.averageprice) ?? 0;
    const ltp = num(h.ltp);
    const invested = qty * avg;
    const value = ltp === null ? null : qty * ltp;
    const pnl = value === null ? null : value - invested;
    return {
      broker: "angel",
      symbol: String(h.tradingsymbol ?? h.symbolname ?? ""),
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

export function normalizeAngelPositions(data: any): Position[] {
  const list: any[] = Array.isArray(data) ? data : [];
  return list.map((p) => ({
    broker: "angel",
    symbol: String(p.tradingsymbol ?? ""),
    exchange: p.exchange ?? null,
    product: p.producttype ?? null,
    qty: num(p.netqty) ?? 0,
    avg_price: num(p.avgnetprice) ?? num(p.netprice),
    ltp: num(p.ltp),
    pnl: num(p.pnl) ?? num(p.unrealised),
  }));
}

export function normalizeAngelFunds(data: any): Funds {
  const raw = (data ?? {}) as Record<string, unknown>;
  return {
    broker: "angel",
    available_cash: num(raw.availablecash) ?? num(raw.net),
    used_margin: num(raw.utiliseddebits),
    raw,
  };
}

export async function angelHoldings(apiKey: string, jwt: string, fetchFn: typeof fetch = fetch) {
  return normalizeAngelHoldings((await get(fetchFn, apiKey, jwt, ANGEL_PATHS.holdings)).data);
}
export async function angelPositions(apiKey: string, jwt: string, fetchFn: typeof fetch = fetch) {
  return normalizeAngelPositions((await get(fetchFn, apiKey, jwt, ANGEL_PATHS.positions)).data);
}
export async function angelFunds(apiKey: string, jwt: string, fetchFn: typeof fetch = fetch) {
  return normalizeAngelFunds((await get(fetchFn, apiKey, jwt, ANGEL_PATHS.funds)).data);
}
