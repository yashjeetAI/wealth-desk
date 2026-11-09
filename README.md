# Wealth Desk

Ask Claude about your Indian stock portfolio across **Zerodha (Kite)**, **Groww** and **Angel One** in one answer.

It is a small, read-only [MCP](https://modelcontextprotocol.io) server. You deploy your own copy on Cloudflare Workers (free tier), add it to Claude as a connector, and ask things like *"show my full portfolio"* or *"which holdings are down?"*.

- **Read-only.** There is no code to place, change or cancel orders. A test fails the build if any appears.
- **Your keys, your server.** Each person deploys their own Worker with their own broker keys. Nothing goes through anyone else's server.
- **Locked to you.** Sign-in is with GitHub, and only the one GitHub account you set can use it.
- **No TOTP secret stored.** You type your 6-digit code (or click a Zerodha login link) once a day.

## Example

> **You:** Show my full portfolio
>
> **Claude:** ₹12.4L across 9 stocks, up ₹2.1L (+20%). Largest: INFY 18%, HDFCBANK 15%, TCS 12% …

(Sample numbers.)

## Tools

| Tool | What it does |
|---|---|
| `auth_status` | Which brokers are logged in, and until when |
| `kite_login(request_token?)` | Zerodha daily login. No args gives a login link; you're logged in when Zerodha sends you back |
| `groww_login(totp?)` | Groww daily login (approval key: no args; TOTP key: pass the code) |
| `angel_login(totp)` | Angel One daily login with your 6-digit TOTP |
| `kite_holdings` / `kite_positions` / `kite_funds` | Zerodha data |
| `groww_holdings` / `groww_positions` / `groww_funds` | Groww data |
| `angel_holdings` / `angel_positions` / `angel_funds` | Angel One data |
| `get_portfolio` | All brokers merged: totals, per-broker split, each holding's weight |

Every holding has the same fields: `broker, symbol, exchange, isin, qty, avg_price, ltp, invested, value, pnl, pnl_pct`.
Set up only the brokers you use; the rest are skipped. An expired login returns "login needed", not an error.

**Prices for Groww:** Groww's free API plan has no live prices. If Zerodha is logged in, missing prices are taken from Kite quotes and marked `price_source: "kite"` (this needs a Kite Connect plan with market data). Anything still unpriced is valued at cost and listed under `unpriced`.

## Setup (about 20 minutes)

You need Node 20+, a free Cloudflare account, and API access from at least one broker:
[Kite Connect](https://developers.kite.trade), [Groww Trade API](https://groww.in/trade-api), or [Angel One SmartAPI](https://smartapi.angelbroking.com).

```sh
git clone https://github.com/yashjeetAI/wealth-desk.git
cd wealth-desk
npm install
npx wrangler login
npx wrangler kv namespace create OAUTH_KV
```

1. **wrangler.jsonc:** replace the three placeholders:
   - `<your-kv-namespace-id>`: the id printed by the command above.
   - `<your-github-user-id>`: the numeric `id` from `https://api.github.com/users/<your-login>`.
   - `PUBLIC_URL`: fill in after the first deploy.
2. **First deploy:** `npm run deploy`. Note the URL (e.g. `https://wealth-desk.<you>.workers.dev`) and put it in `PUBLIC_URL`.
3. **GitHub OAuth app:** GitHub → Settings → Developer settings → OAuth Apps → New.
   Homepage: your Worker URL. Callback: `<Worker URL>/callback`.
4. **Secrets** (see `.dev.vars.example` for the full list):
   ```sh
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler secret put KITE_API_KEY        # Zerodha
   npx wrangler secret put KITE_API_SECRET
   npx wrangler secret put GROWW_API_KEY       # Groww
   npx wrangler secret put GROWW_API_SECRET    # only for approval-type keys
   npx wrangler secret put ANGEL_API_KEY       # Angel One
   npx wrangler secret put ANGEL_CLIENT_CODE
   npx wrangler secret put ANGEL_MPIN
   ```
   **Zerodha:** in your Kite Connect app, set the Redirect URL to `<Worker URL>/kite/callback`.
5. **Deploy again:** `npm run deploy`.
6. **Add to Claude:** Settings → Connectors → Add custom connector → `<Worker URL>/mcp`. Sign in with GitHub.

## Daily use

Broker logins last one day.

- **Zerodha:** "Log in to Zerodha", open the link, log in.
- **Groww:** approve your key in the Groww app (approval keys), then "log in to Groww".
- **Angel One:** "Log in to Angel with 123456" (your current TOTP code).
- Then: "Show my full portfolio".

## Security

- **No trading code.** `test/no-orders.test.ts` scans the source and the tool list for order, modify, cancel and GTT code, and checks that broker data calls are GET-only.
- **One user.** GitHub OAuth; anyone other than `ALLOWED_GITHUB_USER_ID` is refused. An empty value refuses everyone.
- **Secrets** live in Cloudflare Worker secrets, never in the repo. Daily broker tokens live in a Durable Object and expire on their own.
- **Kill switch.** Set `DISABLED` to `"true"` in `wrangler.jsonc` and redeploy: every tool turns off.
- **Logs** contain only the tool name and status: no tokens, codes or holdings.
- **Zerodha login links** carry a one-time state that expires after 10 minutes.

Found a security issue? Please open a private security advisory on GitHub rather than a public issue.

## Development

```sh
cp .dev.vars.example .dev.vars   # fill in what you need
npm run check                    # typecheck + tests
npm run dev                      # local server
```

API calls follow the official clients: `pykiteconnect`, `growwapi` 1.5.0 and `smartapi-python` 1.5.5.

## Disclaimer

Not financial advice. This is an unofficial tool, not affiliated with Zerodha, Groww, Angel One or Anthropic. Each broker's API terms apply to you; you are responsible for following them. It shows data your broker returns; check important numbers in your broker's app. Use at your own risk; see [LICENSE](LICENSE).
