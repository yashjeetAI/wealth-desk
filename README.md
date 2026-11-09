# Wealth Desk

Read-only Groww and Angel One portfolio data for Claude, as a remote MCP server you deploy to your own Cloudflare account (free tier).

Ask Claude "show my full portfolio" and get holdings, positions and funds from both brokers, merged.

- **Read-only.** No order, modify, cancel or GTT code exists. `test/no-orders.test.ts` fails if any appears.
- **Locked to you.** GitHub login; only `ALLOWED_GITHUB_USER_ID` gets in.
- **No TOTP secret stored.** You type the 6-digit code once a day. Daily tokens live in a Durable Object.
- **Kill switch.** Set `DISABLED` to `"true"` and redeploy: every tool turns off.
- **Logs** contain only tool name and status.

## Tools

| Tool | What it does |
|---|---|
| `auth_status` | Which brokers are logged in, and until when |
| `angel_login(totp)` | Angel One daily login with your 6-digit TOTP |
| `angel_holdings` / `angel_positions` / `angel_funds` | Angel One data |
| `groww_login(totp?)` | Groww daily login (approval key: no args; TOTP key: pass the code) |
| `groww_holdings` / `groww_positions` / `groww_funds` | Groww data |
| `get_portfolio` | Both brokers merged: totals, per-broker split, weights |

Every holding has the same fields: `broker, symbol, exchange, isin, qty, avg_price, ltp, invested, value, pnl, pnl_pct`.
Expired or missing tokens return "login needed", not an error.

Groww's free plan may not include live prices. Then Groww holdings show `ltp: null`, and `get_portfolio` values them at cost and lists them under `unpriced`.

## Setup (once, about 20 minutes)

You need Node 20+ and a free Cloudflare account.

```sh
npm install
npx wrangler login
npx wrangler kv namespace create OAUTH_KV     # paste the id into wrangler.jsonc
```

Copy `.dev.vars.example` to `.dev.vars` if you want to run it locally.

1. **Your GitHub id:** open `https://api.github.com/users/<your-login>`, copy `id` into `ALLOWED_GITHUB_USER_ID` in `wrangler.jsonc`.
2. **First deploy:** `npm run deploy`. Note the URL, e.g. `https://wealth-desk.<you>.workers.dev`, and put it in `PUBLIC_URL` in `wrangler.jsonc`.
3. **GitHub OAuth app:** GitHub → Settings → Developer settings → OAuth Apps → New.
   Homepage: your Worker URL. Callback: `<Worker URL>/callback`.
4. **Secrets:**
   ```sh
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler secret put ANGEL_API_KEY       # SmartAPI app key (New Login)
   npx wrangler secret put ANGEL_CLIENT_CODE   # your Angel client id
   npx wrangler secret put ANGEL_MPIN          # your Angel MPIN
   npx wrangler secret put GROWW_API_KEY       # Groww Trade API key
   npx wrangler secret put GROWW_API_SECRET    # only for approval-type keys
   ```
5. **Deploy again:** `npm run deploy`.
6. **Add to Claude:** Settings → Connectors → Add custom connector → `<Worker URL>/mcp`. Sign in with GitHub.

You only need the broker secrets for the brokers you use.

## Daily use

- Ask Claude: "Log in to Angel with 123456" (your current TOTP code).
- Groww: approve your key in Groww if it's an approval key, then "log in to Groww".
- Then: "Show my full portfolio".

## Development

```sh
npm run check     # typecheck + tests
npm run dev       # local server (needs .dev.vars with GITHUB_CLIENT_ID/SECRET)
```

API endpoints follow the official SDKs: `smartapi-python` 1.5.5 and `growwapi` 1.5.0.

## Security

- Each person deploys their own Worker. Your keys and tokens stay in your Cloudflare account; nothing is sent to the author of this repo.
- Broker API keys are Worker secrets, never in code or `wrangler.jsonc`.
- Only one GitHub account (yours) can sign in.
- Read-only by design, enforced by a test.

## Disclaimer

Not financial advice. Not affiliated with Groww, Angel One or Anthropic. Use of each broker's API is subject to that broker's terms; you are responsible for following them.

## License

MIT
