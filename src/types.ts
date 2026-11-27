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
  /** Pingo Doce product id (SFCC pid), e.g. "41043" */
  id: string | null;
  /** Product display name as shown on the page */
  name: string | null;
  /** Brand, e.g. "Mimosa" */
  brand: string | null;
  /** Pack size, e.g. "1 L" or "6 x 1 L" */
  size: string | null;
  /** Current (sale) price, formatted, e.g. "0,89 €" */
  price: string | null;
  /** Current price as a number in EUR, e.g. 0.89 */
  priceValue: number | null;
  /** Price before discount, formatted (null when not reduced) */
  originalPrice: string | null;
  /** Unit price as shown, e.g. "0,89 €/L" */
  unitPrice: string | null;
  /** True when a reduction / promo label / promo message is shown */
  onPromotion: boolean;
  /** Promotion label + validity, e.g. "Poupe mais de 10% | Promoção até 30/11" */
  promotion: string | null;
  /** Category name, e.g. "Leite e Bebidas Vegetais" */
  category: string | null;
  /** Product description (product pages only) */
  description?: string | null;
  /** Absolute URL to the product page */
  url: string | null;
  /** URL to the product image */
  image: string | null;
  /** Extraction strategy: "product-tile" | "product-page" */
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
