export type Broker = "angel" | "groww";

/** One holding, same shape for every broker. */
export interface Holding {
  broker: Broker;
  symbol: string;
  exchange: string | null;
  isin: string | null;
  qty: number;
  avg_price: number;
  ltp: number | null;
  invested: number;
  value: number | null;
  pnl: number | null;
  pnl_pct: number | null;
}

export interface Position {
  broker: Broker;
  symbol: string;
  exchange: string | null;
  product: string | null;
  qty: number;
  avg_price: number | null;
  ltp: number | null;
  pnl: number | null;
}

export interface Funds {
  broker: Broker;
  available_cash: number | null;
  used_margin: number | null;
  raw: Record<string, unknown>;
}

export interface StoredToken {
  token: string;
  expiresAt: number; // epoch ms
}

/** Where daily broker tokens live (a Durable Object in production). */
export interface TokenStoreLike {
  get(broker: Broker): Promise<StoredToken | null>;
  put(broker: Broker, token: StoredToken): Promise<void>;
  clear(broker: Broker): Promise<void>;
}

/** Thrown when a broker token is missing, expired or rejected. */
export class LoginNeeded extends Error {
  constructor(public broker: Broker) {
    super(`${broker} login needed`);
  }
}

/** Thrown for any other broker API failure. Message is safe to show the user. */
export class BrokerError extends Error {
  constructor(public broker: Broker, message: string) {
    super(message);
  }
}
