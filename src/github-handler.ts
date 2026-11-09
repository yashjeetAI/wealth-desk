// The /authorize page: consent, then GitHub sign-in. Only ALLOWED_GITHUB_USER_ID gets through.
import {
  AuthorizationError,
  CimdFetchError,
  authorizationErrorRedirect,
  type ConsentDescription,
} from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { isAllowedUser, type Env } from "./env";
import { handleKiteCallback } from "./kite-callback";
import { tokenStore } from "./token-store";

const app = new Hono<{ Bindings: Env }>();

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string, headers?: Headers, status = 200): Response {
  const h = headers ?? new Headers();
  h.set("Content-Type", "text/html; charset=utf-8");
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:480px;margin:48px auto;padding:0 16px;color:#111;background:#fafaf8}
button{font:inherit;padding:8px 18px;border-radius:999px;border:1px solid #ccc;background:#fff;margin-right:8px}
button[value=approve]{background:#a15c00;color:#fff;border-color:#a15c00}.warn{color:#b4441c}</style>
<h1>${esc(title)}</h1>${body}`;
  return new Response(html, { status, headers: h });
}

function consentPage(d: ConsentDescription, handle: string): string {
  const origin = d.clientDomain
    ? `Published by <strong>${esc(d.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  return `<p>Allow <strong>${esc(d.clientName)}</strong> to read your Groww, Angel One and Zerodha portfolio? It cannot trade.</p>
<p>${origin} Access goes to <strong>${esc(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? '<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>' : ""}
<form method="post"><input type="hidden" name="handle" value="${esc(handle)}">
<button name="decision" value="approve">Allow, then sign in with GitHub</button><button name="decision" value="deny">Deny</button></form>`;
}

async function s256(verifier: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...d)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function handleError(e: unknown): Response {
  if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
  if (e instanceof AuthorizationError || e instanceof CimdFetchError) {
    const msg = e instanceof AuthorizationError ? e.description : "This app could not be verified.";
    return page("Sign-in failed", `<p>${esc(msg ?? "Please start again from Claude.")}</p>`, undefined, 400);
  }
  throw e;
}

app.get("/authorize", async (c) => {
  try {
    const oauth = c.env.OAUTH_PROVIDER;
    const req = await oauth.parseAuthRequest(c.req.raw);
    const details = await oauth.describeConsent(req);
    const consent = await oauth.beginConsent(req);
    return page("Portfolio MCP", consentPage(details, consent.handle), consent.headers);
  } catch (e) {
    return handleError(e);
  }
});

app.post("/authorize", async (c) => {
  try {
    const oauth = c.env.OAUTH_PROVIDER;
    const form = await c.req.raw.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(c.req.raw, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await oauth.approveConsent(c.req.raw, handle);
    const verifier = crypto.randomUUID() + crypto.randomUUID();
    const { state, headers } = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
    const gh = new URL("https://github.com/login/oauth/authorize");
    gh.searchParams.set("client_id", c.env.GITHUB_CLIENT_ID);
    gh.searchParams.set("redirect_uri", new URL("/callback", c.req.url).href);
    gh.searchParams.set("scope", "read:user");
    gh.searchParams.set("state", state);
    gh.searchParams.set("code_challenge", await s256(verifier));
    gh.searchParams.set("code_challenge_method", "S256");
    headers.set("Location", gh.href);
    return new Response(null, { status: 302, headers });
  } catch (e) {
    return handleError(e);
  }
});

app.get("/callback", async (c) => {
  try {
    const oauth = c.env.OAUTH_PROVIDER;
    const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(c.req.raw);
    const url = new URL(c.req.url);
    const code = url.searchParams.get("code");
    if (url.searchParams.get("error") || !code) {
      headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
      return new Response(null, { status: 302, headers });
    }
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: c.env.GITHUB_CLIENT_ID,
        client_secret: c.env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: new URL("/callback", c.req.url).href,
        code_verifier: data.verifier,
      }),
    });
    const tok = (await tokenRes.json()) as { access_token?: string };
    if (!tok.access_token) return page("Sign-in failed", "<p>GitHub did not return a token. Start again from Claude.</p>", undefined, 400);
    const userRes = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${tok.access_token}`, "User-Agent": "wealth-desk", Accept: "application/vnd.github+json" },
    });
    const user = (await userRes.json()) as { id?: number; login?: string };
    const githubId = user.id === undefined ? undefined : String(user.id);
    if (!isAllowedUser(c.env, githubId)) {
      console.log(JSON.stringify({ event: "login", status: "forbidden" }));
      return page("Not allowed", "<p>This server is private.</p>", undefined, 403);
    }
    const { redirectTo } = await oauth.completeAuthorization({
      request: original,
      userId: githubId!,
      metadata: { label: user.login },
      scope: original.scope,
      props: { githubId: githubId!, login: user.login ?? "" },
    });
    console.log(JSON.stringify({ event: "login", status: "ok" }));
    headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers });
  } catch (e) {
    return handleError(e);
  }
});

app.get("/kite/callback", async (c) => {
  const r = await handleKiteCallback(new URL(c.req.url), c.env, tokenStore(c.env.TOKEN_STORE));
  return page(r.status === 200 ? "Zerodha connected" : "Zerodha login failed", `<p>${esc(r.message)}</p>`, undefined, r.status);
});

app.get("/", (c) => c.text("Portfolio MCP: read-only. Connect at /mcp."));

export default app;
