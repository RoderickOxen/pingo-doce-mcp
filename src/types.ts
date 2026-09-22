/**
 * Shared type definitions for pingo-doce-mcp.
 */

// ────────────────────────────────────────────────────────────────────
// Cloudflare Worker environment bindings
// ────────────────────────────────────────────────────────────────────

export interface Env {
  /**
   * Browser Rendering binding (Cloudflare Puppeteer).
   * Defined in wrangler.jsonc under "browser".
   */
  BROWSER: Fetcher;

  /**
   * Durable Object namespace for MCP session state (McpAgent).
   * Defined in wrangler.jsonc under "durable_objects".
   */
  MCP_OBJECT: DurableObjectNamespace;

  // ── Cloudflare Access secrets (set via `wrangler secret put`) ───────
  /**
   * The "Application Audience (AUD) Tag" from your Cloudflare Access
   * application. Found in Zero Trust > Access > Applications > Edit.
   * Used to validate the CF-Access-JWT-Assertion header.
   */
  CF_ACCESS_AUD?: string;

  /**
   * Your Cloudflare Access team domain, e.g. "yourteam.cloudflareaccess.com".
   * Used to fetch the JWKS public keys for JWT validation.
   */
  CF_ACCESS_TEAM_DOMAIN?: string;

  /**
   * Set to "true" to bypass Access JWT validation (local dev only).
   * Never enable in production.
   */
  CF_ACCESS_SKIP_AUTH?: string;
}

// ────────────────────────────────────────────────────────────────────
// Scraper result types
// ────────────────────────────────────────────────────────────────────

/**
 * A single product scraped from Pingo Doce.
 */
export interface ProductResult {
  /** Product display name as shown on the page */
  name: string | null;
  /** Formatted price string, e.g. "2,99€" */
  price: string | null;
  /** Unit price, e.g. "1,50€/kg" (null if not found) */
  unitPrice: string | null;
  /** Promotion or discount label, if visible */
  promotion: string | null;
  /** Absolute URL to the product page */
  url: string | null;
  /** URL to the product image (null if placeholder/data-URI) */
  image: string | null;
  /** First 500 chars of visible text for debugging (null on detail pages) */
  rawText: string | null;
  /** Extraction strategy: "json-ld" | "heuristic" | "detail-page" */
  source: string;
}

export interface SearchResponse {
  query: string;
  limit: number;
  count: number;
  products: ProductResult[];
  scrapedAt: string;
  warning?: string;
}

export interface PromotionsResponse {
  category: string | null;
  limit: number;
  count: number;
  products: ProductResult[];
  scrapedAt: string;
  warning?: string;
}

export interface ProductDetailResponse {
  requestedUrl: string;
  product: ProductResult;
  scrapedAt: string;
  warning?: string;
}

export interface CompareResponse {
  productNames: string[];
  limitPerProduct: number;
  results: Record<string, ProductResult[]>;
  scrapedAt: string;
}
