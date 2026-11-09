import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools, type ToolDeps } from "../src/tools";
import type { Broker, StoredToken, TokenStoreLike } from "../src/types";

export class MemStore implements TokenStoreLike {
  m = new Map<Broker, StoredToken>();
  async get(b: Broker) { return this.m.get(b) ?? null; }
  async put(b: Broker, t: StoredToken) { this.m.set(b, t); }
  async clear(b: Broker) { this.m.delete(b); }
  states = new Map<string, number>();
  async putState(s: string, ttl: number) { this.states.set(s, Date.now() + ttl); }
  async takeState(s: string) {
    const exp = this.states.get(s);
    this.states.delete(s);
    return exp !== undefined && exp > Date.now();
  }
}

export const OWNER = "12345";
export const baseEnv = {
  ANGEL_API_KEY: "ak",
  ANGEL_CLIENT_CODE: "C1",
  ANGEL_MPIN: "1111",
  GROWW_API_KEY: "gk",
  GROWW_API_SECRET: "gs",
  KITE_API_KEY: "kk",
  KITE_API_SECRET: "ks",
  PUBLIC_URL: "https://pm.example.workers.dev",
  ALLOWED_GITHUB_USER_ID: OWNER,
  DISABLED: "false",
};

type Route = (url: URL, init: RequestInit) => Response | Promise<Response>;
export function mockFetch(routes: Record<string, Route>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (input: any, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.href, init });
    const key = Object.keys(routes).find((k) => url.href.startsWith(k));
    if (!key) return new Response("not found", { status: 404 });
    return routes[key](url, init);
  }) as typeof fetch;
  return { f, calls };
}

export const jsonRes = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

export async function connect(deps: Partial<ToolDeps> & { fetch?: typeof fetch }) {
  const logs: string[] = [];
  const store = (deps.store as MemStore) ?? new MemStore();
  const server = new McpServer({ name: "t", version: "0" });
  registerTools(server, {
    env: { ...baseEnv, ...(deps.env ?? {}) },
    store,
    githubId: "githubId" in deps ? deps.githubId : OWNER,
    fetch: deps.fetch,
    log: (l) => logs.push(l),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { text: r.content?.[0]?.text as string, isError: !!r.isError };
  };
  return { client, call, store, logs };
}
