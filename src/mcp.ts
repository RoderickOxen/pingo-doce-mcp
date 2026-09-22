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
import {
  scrapeSearch,
  scrapeProductPage,
  scrapePromotions,
  sanitizeQuery,
  clampLimit,
  validatePingoDoceUrl,
  MAX_QUERY_LENGTH,
  MAX_LIMIT,
  DEFAULT_LIMIT,
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
Each product includes name, price, unit price, promotion label, URL, and image.

NOTE: Pingo Doce's website selectors are subject to change. If results are
empty, the search URL pattern may need updating — see scraper.ts.`,
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
          const { products, warning } = await scrapeSearch(env, q, n);

          const payload = {
            query: q,
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
Returns name, price, unit price, promotion, image, and raw visible text.`,
      {
        url: z
          .string()
          .url()
          .describe(
            `Full URL of the product page, e.g. "https://www.pingodoce.pt/produtos/leite-mimosa-magro/".`
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

          const { product, warning } = await scrapeProductPage(env, url);

          const payload = {
            requestedUrl: url,
            product,
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
      `Scrape current promotions from Pingo Doce's promotions/offers pages.
Optionally filter by category (e.g. "lacticinios", "frutas-e-legumes").
Returns up to \`limit\` promoted products.

NOTE: The promotions URL pattern may need live verification — see scraper.ts.`,
      {
        category: z
          .string()
          .max(100)
          .optional()
          .describe(
            `Optional category slug to filter promotions, e.g. "lacticinios" or "bebidas".`
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
          const { products, warning } = await scrapePromotions(
            env,
            category,
            n
          );

          const payload = {
            category: category ?? null,
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
Searches each product name sequentially (conservative — no parallel browsing)
and returns grouped results for price comparison.

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
          const results: Record<
            string,
            Array<{
              name: string | null;
              price: string | null;
              unitPrice: string | null;
              promotion: string | null;
              url: string | null;
              image: string | null;
              rawText: string | null;
              source: string;
            }>
          > = {};

          // Sequential execution — do NOT parallelise browser launches
          for (const productName of product_names) {
            const q = sanitizeQuery(productName);
            const { products } = await scrapeSearch(env, q, n);
            results[productName] = products;
          }

          const payload = {
            productNames: product_names,
            limitPerProduct: n,
            results,
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
