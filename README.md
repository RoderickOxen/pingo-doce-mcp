# 🛒 pingo-doce-mcp

A **remote MCP (Model Context Protocol) server** that uses Cloudflare Workers + Browser Rendering to scrape the [Pingo Doce](https://www.pingodoce.pt) online store.

> ⚠️ **Legal Notice** — This project is intended for personal/internal/demo use only. Always review `https://www.pingodoce.pt/robots.txt` and Pingo Doce's Terms of Service before deploying. Do not use for commercial resale of pricing data or at high frequency.

---

## Features

| Tool | Description |
|------|-------------|
| `search_products` | Search products by keyword, returns structured JSON |
| `get_product` | Detailed scrape of a specific product page URL |
| `get_promotions` | Scrape current promotions / offers (optional category filter) |
| `compare_prices` | Side-by-side comparison of multiple product searches |

**Scraping strategy** (most-specific → least-specific):
1. JSON-LD structured data (`application/ld+json`)
2. CSS selector heuristics (common e-commerce patterns)
3. Price-text regex fallback

**Guardrails**:
- Domain allowlist: only `pingodoce.pt` / `*.pingodoce.pt`
- Max query length: 200 chars
- Max results: 50 per call
- Browser closed in `finally` on every request
- Sequential execution for `compare_prices` (no parallel browser instances)
- Descriptive User-Agent string

---

## Architecture

```
Client (MCP Inspector / foundation-os / Claude Desktop)
    │
    │  HTTPS POST /mcp  (Streamable HTTP transport)
    ▼
Cloudflare Worker (src/index.ts)
    │  ① Cloudflare Access JWT validation (optional but recommended)
    │  ② Route /mcp → McpAgent.serve()
    ▼
Durable Object: PingoDoceMCP  (src/mcp.ts)
    │  McpAgent from `agents` SDK manages SSE / WS sessions
    │
    ├─ search_products   ─────────────────────────────────────────┐
    ├─ get_product        ──→ src/scraper.ts  ──→ BROWSER binding │
    ├─ get_promotions     ──→ @cloudflare/puppeteer               │
    └─ compare_prices    ─────────────────────────────────────────┘
                                ▼
                    www.pingodoce.pt  (headless Chromium)
```

---

## Prerequisites

- **Node.js** ≥ 18
- **Wrangler** ≥ 4 (`npm install -g wrangler`)
- **Cloudflare account** with:
  - Workers **Paid plan** (required for Browser Rendering)
  - **Durable Objects** enabled (included in Paid plan)

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Type-check

```bash
npm run typecheck
```

### 3. Configure Browser Rendering (dashboard)

1. Go to **Workers & Pages** → your Worker → **Settings** → **Bindings**
2. Add a **Browser Rendering** binding named exactly `BROWSER`
3. Or — it will be created automatically on first deploy if the `wrangler.jsonc` `browser` section is present

### 4. Local development

> ⚠️ **Browser Rendering is NOT available in local `wrangler dev` mode.**
> Use `--remote` to proxy to Cloudflare's edge:

```bash
npm run dev -- --remote
```

For local-only testing (without Browser Rendering, to check routing/auth):

```bash
npm run dev
# Browser Rendering calls will fail — expected in local mode
```

---

## Deploy

```bash
npm run deploy
```

After deploy, the MCP endpoint is available at:
```
https://pingo-doce-mcp.<your-subdomain>.workers.dev/mcp
```

---

## Cloudflare Access Protection

Restrict the MCP endpoint to authenticated users via **Cloudflare Zero Trust**.

### Required secrets

```bash
wrangler secret put CF_ACCESS_AUD
# Paste the "Application Audience (AUD) Tag" from Zero Trust dashboard

wrangler secret put CF_ACCESS_TEAM_DOMAIN
# Paste your team domain, e.g. "myteam.cloudflareaccess.com"
```

### Zero Trust setup steps

1. **Create an Access Application**
   - Go to [Zero Trust Dashboard](https://one.dash.cloudflare.com) → **Access** → **Applications** → **Add an application**
   - Choose **Self-hosted**
   - Application domain: `pingo-doce-mcp.<subdomain>.workers.dev`
   - Path: `/mcp` (protect only the MCP endpoint)

2. **Add an Access Policy**
   - Define who can access: email list, GitHub org, Google Workspace, etc.
   - Or use a **Service Token** for machine-to-machine access (for MCP clients)

3. **Copy the AUD tag**
   - Edit the application → **Overview** → copy **Application Audience (AUD) Tag**
   - Run `wrangler secret put CF_ACCESS_AUD` and paste it

4. **Locate your team domain**
   - Zero Trust → **Settings** → **Custom Pages** → your team domain
   - Run `wrangler secret put CF_ACCESS_TEAM_DOMAIN` and paste it

5. **For Service Token (machine access)**
   - Zero Trust → **Access** → **Service Auth** → **Service Tokens** → **Create Service Token**
   - The token provides `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers
   - MCP clients must pass these headers with every request

### How JWT validation works

When both secrets are set, the Worker:
1. Reads the `CF-Access-JWT-Assertion` header (or `CF_Authorization` cookie)
2. Decodes and checks the `exp` (expiry) and `aud` (audience) claims
3. Fetches JWKS from `https://<team-domain>/cdn-cgi/access/certs` (cached 5 min)
4. Verifies the RS256 signature with Web Crypto API
5. Returns **401** if any check fails

> If `CF_ACCESS_AUD` is not set, validation is skipped (useful for local dev).

### Alternatively — edge-level Access enforcement

You can enforce Access at the **Cloudflare edge** (before the Worker runs) by:
1. Creating the Access application for the Worker route
2. Enabling **"Block all traffic that doesn't have a valid JWT"** in the Access policy

This offloads JWT validation entirely to Cloudflare's edge — no code changes needed.

---

## Testing with MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

1. Select **"Streamable HTTP"** transport
2. Enter URL: `https://pingo-doce-mcp.<subdomain>.workers.dev/mcp`
3. If Access is enabled, add your service token headers:
   - `CF-Access-Client-Id: <client-id>`
   - `CF-Access-Client-Secret: <client-secret>`
4. Connect → list tools → call `search_products` with `{ "query": "leite" }`

---

## Connecting to MCP Portal / foundation-os

Add to your MCP client configuration (e.g. `mcp.json` or foundation-os settings):

```json
{
  "mcpServers": {
    "pingo-doce": {
      "url": "https://pingo-doce-mcp.<subdomain>.workers.dev/mcp",
      "transport": "streamable-http",
      "headers": {
        "CF-Access-Client-Id": "<your-service-token-client-id>",
        "CF-Access-Client-Secret": "<your-service-token-client-secret>"
      }
    }
  }
}
```

For Claude Desktop (SSE transport):
```json
{
  "mcpServers": {
    "pingo-doce": {
      "url": "https://pingo-doce-mcp.<subdomain>.workers.dev/mcp",
      "transport": "sse"
    }
  }
}
```

---

## Selector Maintenance

Because Pingo Doce's website HTML structure may change, the scraper uses
**multiple fallback strategies**. After deployment, if tools return empty results:

1. Open `https://www.pingodoce.pt/produtos/?s=leite` in a real browser
2. Inspect the product card elements (`F12` → pick element)
3. Note the CSS class names or data-attributes on product cards
4. Update `CARD_SELECTORS` in `src/scraper.ts` with the confirmed selectors
5. Also update the `searchUrls` array if the search URL pattern differs

The JSON-LD strategy (`source: "json-ld"`) is the most reliable — check if
the site embeds `<script type="application/ld+json">` tags with `@type: "Product"`.

---

## Project structure

```
pingo-doce-mcp/
├── src/
│   ├── index.ts     # Worker entry: routing + Access JWT validation
│   ├── mcp.ts       # McpAgent + all 4 MCP tools
│   ├── scraper.ts   # Browser Rendering scraping logic
│   └── types.ts     # Shared TypeScript interfaces
├── wrangler.jsonc   # Cloudflare config (Browser + Durable Objects)
├── package.json
├── tsconfig.json
└── README.md
```

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Local dev (no Browser Rendering) |
| `npm run dev -- --remote` | Remote dev with Browser Rendering |
| `npm run deploy` | Deploy to Cloudflare Workers |
| `npm run typecheck` | TypeScript type check (no emit) |

---

## Limitations & known issues

- **Browser Rendering is synchronous per call** — each tool invocation launches one browser. The `compare_prices` tool runs searches sequentially to avoid resource exhaustion.
- **Selectors need live verification** — the CSS heuristics are best-effort. After first deployment, inspect the site and update `CARD_SELECTORS`.
- **Durable Objects bill separately** — check [Cloudflare pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).
- **`wrangler dev` (local)** does not support Browser Rendering. Use `--remote`.
- **Rate limiting** — be conservative with usage. The site may return CAPTCHAs or block IPs under high load.
