import { DurableObject } from "cloudflare:workers";
import type { Broker, StoredToken, TokenStoreLike } from "./types";

/** One instance holds the owner's daily broker tokens. */
export class TokenStore extends DurableObject {
  async getToken(broker: Broker): Promise<StoredToken | null> {
    return (await this.ctx.storage.get<StoredToken>(`token:${broker}`)) ?? null;
  }
  async putToken(broker: Broker, token: StoredToken): Promise<void> {
    await this.ctx.storage.put(`token:${broker}`, token);
  }
  async clearToken(broker: Broker): Promise<void> {
    await this.ctx.storage.delete(`token:${broker}`);
  }
}

export function tokenStore(ns: DurableObjectNamespace<TokenStore>): TokenStoreLike {
  const stub = ns.get(ns.idFromName("owner"));
  return {
    get: (b) => stub.getToken(b),
    put: (b, t) => stub.putToken(b, t),
    clear: (b) => stub.clearToken(b),
  };
}
