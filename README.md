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

**Scraping strategy** — the site is Salesforce Commerce Cloud and server-rendered:
- Listings (search / promotions / categories): `.product-tile-pd[data-pid]` tiles; prices
  come from `.sales .value[content]` / `.strike-through .value[content]`, so we don't need to parse text.
- Product pages: `.product-detail[data-pid]` for prices + JSON-LD for description/image
  (the site's JSON-LD has no `offers`).

| Tool | Source URL |
|------|------------|
| `search_products` | `/on/demandware.store/Sites-pingo-doce-Site/default/Search-Show?q=…&sz=N` |
| `get_promotions` | `/home/produtos/promocoes`, `/home/produtos/promocoes/poupe-esta-semana`, or `/home/produtos/<category>` filtered to promoted items |
| `get_product` | `/home/produtos/<category>/…/<name>-<id>.html` |

> robots.txt disallows `/on/demandware.store/` and `?sz=`. Search depends on that endpoint, so keep usage personal and low-frequency.

**Guardrails**:
- Domain allowlist: only `pingodoce.pt` / `*.pingodoce.pt`
- Max query length: 200 chars
- Max results: 50 per call
- Browser closed in `finally` on every request
- One browser per tool call; `compare_prices` reuses it for sequential searches
- Images / fonts / CSS are blocked (pages are server-rendered)
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

If tools start returning empty results or a "No products found" warning:

1. Open `https://www.pingodoce.pt/on/demandware.store/Sites-pingo-doce-Site/default/Search-Show?q=leite` in a browser
2. Inspect a product card (`F12`): it should be `.product-tile-pd[data-pid]`
3. Update the selectors in `extractTilesInPage` / `extractProductPageInPage` in `src/scraper.ts`

Note: `wrangler.jsonc` sets `keep_names: false`. It stops esbuild from injecting `__name()` into
functions passed to `page.evaluate()`, which can throw `__name is not defined` in the browser.

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
| `npm run dev` | Local dev (local Browser Rendering via a local Chrome; put `CF_ACCESS_SKIP_AUTH=true` in `.dev.vars`) |
| `npm run dev -- --remote` | Remote dev with Browser Rendering |
| `npm run deploy` | Deploy to Cloudflare Workers |
| `npm run typecheck` | TypeScript type check (no emit) |

---

## Limitations & known issues

- **One browser per tool call** — Browser Rendering limits how many browsers you can launch per minute; `compare_prices` reuses a single session.
- **Selectors are site-specific** — verified against the live site (Nov 2026); see *Selector Maintenance*.
- **Weighted goods** (talho/peixaria) are priced per kg — `price` then reads e.g. `6,19 €/Kg`.
- **Durable Objects bill separately** — check [Cloudflare pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).
- **Rate limiting** — be conservative with usage. The site may return CAPTCHAs or block IPs under high load.
