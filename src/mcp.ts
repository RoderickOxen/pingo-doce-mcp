/**
 * mcp.ts — Pingo Doce MCP Agent
 *
 * Defines the McpAgent Durable Object that implements the four MCP tools.
 * Extend McpAgent<Env> from the `agents` SDK so the Worker runtime manages
 * WebSocket / Streamable-HTTP sessions automatically.
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Env } from "./types.ts";
import type { ProductResult } from "./types.ts";
import {
  withBrowser,
  searchProducts,
  scrapeProductPage,
  scrapePromotions,
  sanitizeQuery,
  clampLimit,
  validatePingoDoceUrl,
  MAX_QUERY_LENGTH,
  MAX_LIMIT,
  DEFAULT_LIMIT,
  CATEGORY_SLUGS,
  PROMO_LISTS,
} from "./scraper.ts";

// ────────────────────────────────────────────────────────────────────
// McpAgent class — exported so wrangler can register the Durable Object
// ────────────────────────────────────────────────────────────────────

export class PingoDoceMCP extends McpAgent<Env> {
  /**
   * MCP server instance — must be assigned before init() is called.
   * McpAgent reads this property to connect the transport layer.
   */
  server = new McpServer({
    name: "pingo-doce-mcp",
    version: "0.1.0",
  });

  /**
   * Register all tools.
   * Called once by McpAgent after the Durable Object is constructed.
   * `this.env` is available here (set by the Agent base-class constructor).
   */
  async init(): Promise<void> {
    // Capture env so arrow-function closures always reference the correct binding
    const env = this.env;

    // ── Tool 1: search_products ────────────────────────────────────
    this.server.tool(
      "search_products",
      `Search Pingo Doce's online store for products matching a query.
Returns up to \`limit\` products (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).
Each product includes id, name, brand, size, price (and numeric priceValue),
originalPrice when reduced, unitPrice, promotion info, category, URL and image.
Online-purchasable products are preferred; falls back to the full catalogue.`,
      {
        query: z
          .string()
          .min(1)
          .max(MAX_QUERY_LENGTH)
          .describe(
            `Search term, e.g. "leite" (milk) or "iogurte natural" (plain yoghurt).`
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIMIT)
          .optional()
          .describe(`Max number of products to return (default ${DEFAULT_LIMIT}).`),
      },
      {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      async ({ query, limit }) => {
        try {
          const n = clampLimit(limit, DEFAULT_LIMIT);
          const q = sanitizeQuery(query);
          const { products, sourceUrl, warning } = await withBrowser(env, (page) =>
            searchProducts(page, q, n)
          );

          const payload = {
            query: q,
            sourceUrl,
            limit: n,
            count: products.length,
            products,
            scrapedAt: new Date().toISOString(),
            ...(warning ? { warning } : {}),
          };

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(payload, null, 2),
              },
            ],
          };
        } catch (err) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Error scraping search results: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              },
            ],
          };
        }
      }
    );

    // ── Tool 2: get_product ────────────────────────────────────────
    this.server.tool(
      "get_product",
      `Fetch detailed information for a specific Pingo Doce product by its URL.
Only accepts URLs on the pingodoce.pt domain.
Use URLs returned by search_products / get_promotions.
Returns name, brand, size, price, originalPrice, unitPrice, promotion, category, description and image.`,
      {
        url: z
          .string()
          .url()
          .describe(
            `Full URL of the product page, e.g. "https://www.pingodoce.pt/home/produtos/leite-e-bebidas-vegetais/leite/leite-meio-gordo-e-gordo/leite-uht-meio-gordo-mimosa-41043.html".`
          ),
      },
      {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      async ({ url }) => {
        try {
          // Domain validation — throws for non-pingodoce.pt URLs
          validatePingoDoceUrl(url);

          const { product } = await withBrowser(env, (page) =>
            scrapeProductPage(page, url)
          );

          const payload = {
            requestedUrl: url,
            product,
            scrapedAt: new Date().toISOString(),
          };

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(payload, null, 2),
              },
            ],
          };
        } catch (err) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Error fetching product: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              },
            ],
          };
        }
      }
    );

    // ── Tool 3: get_promotions ─────────────────────────────────────
    this.server.tool(
      "get_promotions",
      `Current Pingo Doce promotions (from /home/produtos/promocoes).
Optional \`category\`:
  - a promotion list: ${PROMO_LISTS.join(", ")}
  - or a product category slug, returning only promoted items in it:
    ${CATEGORY_SLUGS.join(", ")}
Returns up to \`limit\` promoted products.`,
      {
        category: z
          .string()
          .max(100)
          .optional()
          .describe(
            `Optional promotion list or category slug, e.g. "poupe-esta-semana" or "leite-e-bebidas-vegetais".`
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIMIT)
          .optional()
          .describe(`Max number of promotions to return (default ${DEFAULT_LIMIT}).`),
      },
      {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      async ({ category, limit }) => {
        try {
          const n = clampLimit(limit, DEFAULT_LIMIT);
          const { products, sourceUrl, warning } = await withBrowser(env, (page) =>
            scrapePromotions(page, category, n)
          );

          const payload = {
            category: category ?? null,
            sourceUrl,
            limit: n,
            count: products.length,
            products,
            scrapedAt: new Date().toISOString(),
            ...(warning ? { warning } : {}),
          };

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(payload, null, 2),
              },
            ],
          };
        } catch (err) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Error scraping promotions: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              },
            ],
          };
        }
      }
    );

    // ── Tool 4: compare_prices ─────────────────────────────────────
    this.server.tool(
      "compare_prices",
      `Compare search results for multiple product names side-by-side.
Searches each product name sequentially in a single browser session and
returns grouped results plus the cheapest match per name (by shelf price, among results whose
name/brand contains every query word; null if none match).

Limits: max 5 product names per call, max ${MAX_LIMIT} results per product.`,
      {
        product_names: z
          .array(z.string().min(1).max(MAX_QUERY_LENGTH))
          .min(1)
          .max(5) // conservative — each search launches a browser
          .describe(
            `List of product names to compare, e.g. ["leite mimosa", "leite continente"].`
          ),
        limit_per_product: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIMIT)
          .optional()
          .describe(
            `Max results per product name (default ${DEFAULT_LIMIT}).`
          ),
      },
      {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      async ({ product_names, limit_per_product }) => {
        try {
          const n = clampLimit(limit_per_product, DEFAULT_LIMIT);
          const results: Record<string, ProductResult[]> = {};
          const cheapest: Record<string, ProductResult | null> = {};
          const warnings: Record<string, string> = {};

          // One browser, sequential navigations — never parallelise.
          await withBrowser(env, async (page) => {
            for (const productName of product_names) {
              const { products, warning } = await searchProducts(
                page,
                sanitizeQuery(productName),
                n
              );
              results[productName] = products;
              // Site search is fuzzy ("manteiga" also returns biscuits), so only
              // rank products whose name/brand contains every query word.
              const fold = (t: string) =>
                t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
              const words = fold(productName).split(/\s+/).filter((w) => w.length > 1);
              cheapest[productName] =
                products
                  .filter((p) => p.priceValue != null)
                  .filter((p) => {
                    const hay = fold(`${p.name ?? ""} ${p.brand ?? ""}`);
                    return words.every((w) => hay.includes(w));
                  })
                  .sort((a, b) => (a.priceValue ?? 0) - (b.priceValue ?? 0))[0] ?? null;
              if (warning) warnings[productName] = warning;
            }
          });

          const payload = {
            productNames: product_names,
            limitPerProduct: n,
            cheapest,
            results,
            ...(Object.keys(warnings).length > 0 ? { warnings } : {}),
            scrapedAt: new Date().toISOString(),
          };

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(payload, null, 2),
              },
            ],
          };
        } catch (err) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Error comparing prices: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              },
            ],
          };
        }
      }
    );
  }
}
