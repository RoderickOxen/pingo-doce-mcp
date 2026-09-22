/**
 * index.ts — Cloudflare Worker entry point
 *
 * Routing:
 *   POST /mcp         → McpAgent (Streamable HTTP, MCP protocol)
 *   GET  /mcp         → McpAgent (SSE upgrade for legacy clients)
 *   GET  /            → Health check / info page
 *   GET  /health      → 200 OK for uptime monitoring
 *
 * Cloudflare Access protection is enforced at the fetch handler level.
 * When CF_ACCESS_AUD and CF_ACCESS_TEAM_DOMAIN secrets are set,
 * the JWT in the CF-Access-JWT-Assertion header is validated before
 * any request is forwarded to the MCP agent.
 *
 * For Zero Trust / Access-for-SaaS full setup, see README.md.
 */

import type { Env } from "./types.ts";
import { PingoDoceMCP } from "./mcp.ts";

// Re-export the Durable Object class so wrangler can discover it.
// The class_name in wrangler.jsonc must match this export name exactly.
export { PingoDoceMCP };

// ────────────────────────────────────────────────────────────────────
// Cloudflare Access JWT validation
// ────────────────────────────────────────────────────────────────────

/**
 * Validates the Cloudflare Access JWT in the request headers.
 *
 * Full JWT signature verification uses the Web Crypto API against
 * Cloudflare's JWKS endpoint. This is a best-effort implementation
 * that verifies:
 *  1. The JWT is present (CF-Access-JWT-Assertion header or cookie)
 *  2. The `aud` claim matches CF_ACCESS_AUD
 *  3. The token is not expired (`exp` claim)
 *  4. The signature is valid (RS256, verified against Cloudflare JWKS)
 *
 * Required secrets (set via `wrangler secret put`):
 *  - CF_ACCESS_AUD         — audience tag from Zero Trust dashboard
 *  - CF_ACCESS_TEAM_DOMAIN — e.g. "yourteam.cloudflareaccess.com"
 *
 * If CF_ACCESS_AUD is not set, validation is SKIPPED — useful for
 * local development but MUST NOT be deployed without secrets set.
 */
async function validateAccessJwt(
  request: Request,
  env: Env
): Promise<{ valid: boolean; reason?: string }> {
  // Skip if Access is not configured
  if (!env.CF_ACCESS_AUD || !env.CF_ACCESS_TEAM_DOMAIN) {
    return {
      valid: true,
      reason: "CF_ACCESS_AUD/CF_ACCESS_TEAM_DOMAIN not set — Access validation skipped.",
    };
  }

  // Skip explicitly disabled via var (local dev only — never in prod)
  if (env.CF_ACCESS_SKIP_AUTH === "true") {
    return { valid: true, reason: "CF_ACCESS_SKIP_AUTH=true — skipped." };
  }

  // Extract the JWT from header or cookie
  let token: string | null =
    request.headers.get("CF-Access-JWT-Assertion") ?? null;

  if (!token) {
    const cookie = request.headers.get("Cookie") ?? "";
    const match = cookie.match(/CF_Authorization=([^;]+)/);
    token = match ? match[1] : null;
  }

  if (!token) {
    return { valid: false, reason: "Missing CF-Access-JWT-Assertion header or CF_Authorization cookie." };
  }

  try {
    // Decode JWT parts (header.payload.signature)
    const parts = token.split(".");
    if (parts.length !== 3) {
      return { valid: false, reason: "Malformed JWT: expected 3 parts." };
    }

    // Decode payload (base64url)
    const payloadJson = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(payloadJson) as {
      aud?: string | string[];
      exp?: number;
      kid?: string;
    };

    // Check expiry
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp !== undefined && payload.exp < now) {
      return { valid: false, reason: "JWT has expired." };
    }

    // Check audience
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(env.CF_ACCESS_AUD)) {
      return { valid: false, reason: "JWT audience mismatch." };
    }

    // Signature verification via Cloudflare JWKS
    const jwksUrl = `https://${env.CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;
    const jwksResponse = await fetch(jwksUrl, {
      cf: { cacheTtl: 300 }, // cache public keys for 5 min
    });
    if (!jwksResponse.ok) {
      // If JWKS is unreachable, fail closed (deny access)
      return {
        valid: false,
        reason: `Failed to fetch JWKS from ${jwksUrl}: ${jwksResponse.status}`,
      };
    }

    const jwks = (await jwksResponse.json()) as {
      keys: Array<{ kid: string; n: string; e: string; kty: string; alg: string }>;
    };

    // Decode JWT header to get `kid`
    const headerJson = atob(parts[0].replace(/-/g, "+").replace(/_/g, "/"));
    const header = JSON.parse(headerJson) as { kid?: string; alg?: string };

    // Find the matching public key
    const jwk = jwks.keys.find((k) => k.kid === header.kid) ?? jwks.keys[0];
    if (!jwk) {
      return { valid: false, reason: "No matching JWK found." };
    }

    // Import public key and verify
    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const signatureBytes = Uint8Array.from(
      atob(parts[2].replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0)
    );
    const dataBytes = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);

    const isValid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      signatureBytes,
      dataBytes
    );

    return isValid
      ? { valid: true }
      : { valid: false, reason: "JWT signature verification failed." };
  } catch (err) {
    return {
      valid: false,
      reason: `JWT validation error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ────────────────────────────────────────────────────────────────────
// HTML info page
// ────────────────────────────────────────────────────────────────────

const INFO_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pingo Doce MCP Server</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 680px; margin: 3rem auto; padding: 0 1rem; color: #1a1a1a; }
    h1 { color: #e30613; }
    code { background: #f4f4f4; padding: .1em .4em; border-radius: 3px; font-size: .9em; }
    pre  { background: #f4f4f4; padding: 1rem; border-radius: 6px; overflow-x: auto; }
    ul   { line-height: 1.8; }
    .badge { display: inline-block; background: #e30613; color: #fff; font-size: .75em; padding: .15em .5em; border-radius: 12px; vertical-align: middle; }
  </style>
</head>
<body>
  <h1>🛒 Pingo Doce MCP Server</h1>
  <p>Remote <a href="https://modelcontextprotocol.io">Model Context Protocol</a> server
     for Pingo Doce online store, powered by Cloudflare Workers &amp; Browser Rendering.</p>

  <h2>MCP Endpoint</h2>
  <pre><code>POST /mcp   (Streamable HTTP — recommended)
GET  /mcp   (SSE — legacy clients)</code></pre>

  <h2>Available Tools <span class="badge">4</span></h2>
  <ul>
    <li><code>search_products(query, limit?)</code> — Search products by keyword</li>
    <li><code>get_product(url)</code> — Detailed info for a product page URL</li>
    <li><code>get_promotions(category?, limit?)</code> — Current promotions</li>
    <li><code>compare_prices(product_names[], limit_per_product?)</code> — Side-by-side comparison</li>
  </ul>

  <h2>Connect with MCP Inspector</h2>
  <pre><code>npx @modelcontextprotocol/inspector</code></pre>
  <p>Then enter: <code>https://&lt;your-worker&gt;.workers.dev/mcp</code></p>

  <h2>Access Protection</h2>
  <p>This endpoint is protected by Cloudflare Access JWT validation
     when <code>CF_ACCESS_AUD</code> and <code>CF_ACCESS_TEAM_DOMAIN</code> secrets are set.
     See <code>README.md</code> for setup instructions.</p>
</body>
</html>`;

// ────────────────────────────────────────────────────────────────────
// Default Worker export
// ────────────────────────────────────────────────────────────────────

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // ── /health — lightweight uptime check ─────────────────────────
    if (pathname === "/health") {
      return new Response("OK", { status: 200 });
    }

    // ── /mcp — MCP protocol endpoint ──────────────────────────────
    if (pathname === "/mcp" || pathname.startsWith("/mcp/")) {
      // Cloudflare Access JWT validation
      const { valid, reason } = await validateAccessJwt(request, env);
      if (!valid) {
        return new Response(
          JSON.stringify({ error: "Unauthorized", detail: reason }),
          {
            status: 401,
            headers: {
              "Content-Type": "application/json",
              // Tell Access-aware clients to redirect to login
              "WWW-Authenticate": 'Bearer realm="Cloudflare Access"',
            },
          }
        );
      }

      // Delegate to McpAgent — handles SSE, Streamable HTTP, and DO routing
      return PingoDoceMCP.serve("/mcp", { binding: "MCP_OBJECT" }).fetch(
        request,
        env,
        ctx
      );
    }

    // ── / — Info page ──────────────────────────────────────────────
    if (pathname === "/" || pathname === "") {
      return new Response(INFO_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // ── 404 ────────────────────────────────────────────────────────
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
