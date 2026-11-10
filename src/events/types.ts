/** How much attention an event needs. "other" = no rule matched. */
export type Flag = "review" | "watch" | "info" | "other";

/** The only stock data that ever leaves the Worker: no qty, value or account ids. */
export interface StockRef {
  symbol: string;
  isin: string | null;
}

/** One filing or corporate action, as a source returns it. */
export interface FilingEvent {
  title: string;
  /** ISO date (YYYY-MM-DD or full timestamp). */
  date: string;
  url: string | null;
  /** Category or subject line from the exchange, if any. Helps the classifier. */
  category?: string;
}

/** A filings provider (BSE, NSE, a licensed feed...). Plugged in once one is chosen. */
export interface EventSource {
  name: string;
  events(stock: StockRef, from: Date, to: Date, signal: AbortSignal): Promise<FilingEvent[]>;
}

/** Small cache, KV in production. */
export interface EventCache {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlSeconds: number): Promise<void>;
}
