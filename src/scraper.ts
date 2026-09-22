/**
 * scraper.ts — Browser Rendering scraper for Pingo Doce online store.
 *
 * ⚠️  IMPORTANT — LEGAL / ETHICAL NOTICE ⚠️
 * This scraper is intended for personal, internal, or demo use only.
 * Before deploying, review:
 *   • https://www.pingodoce.pt/robots.txt
 *   • Jerónimo Martins / Pingo Doce Terms of Service
 *   • GDPR obligations if any personal data is processed
 *
 * Do NOT use this at high frequency, for commercial resale of pricing
 * data, or in any way that could violate the site's ToS.
 *
 * This implementation uses Cloudflare Browser Rendering, which fetches
 * pages exactly as a real browser would — single-page, sequential,
 * with conservative timeouts and no aggressive concurrency.
 */

import puppeteer from "@cloudflare/puppeteer";
import type { Env, ProductResult } from "./types.ts";

// ────────────────────────────────────────────────────────────────────
// Guardrails
// ────────────────────────────────────────────────────────────────────

/** Permitted hostnames — strict allowlist */
const ALLOWED_HOSTNAMES = new Set(["pingodoce.pt", "www.pingodoce.pt"]);

/** Base URL of the Pingo Doce website */
const BASE_URL = "https://www.pingodoce.pt";

/** Maximum query string length to prevent abuse */
export const MAX_QUERY_LENGTH = 200;

/** Hard cap on result count per call */
export const MAX_LIMIT = 50;

/** Default result limit */
export const DEFAULT_LIMIT = 10;

/** Browser navigation timeout (ms) — keep well under Worker's 30 s wall-clock */
const NAV_TIMEOUT_MS = 20_000;

/** Additional wait after domcontentloaded for JS-rendered content (ms) */
const JS_RENDER_WAIT_MS = 1_500;

/**
 * Descriptive user-agent that identifies this as a browser-based tool.
 * We do not masquerade as a regular user browser on purpose.
 */
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 " +
  "CloudflareWorkerBrowserRendering/1.0 (+https://developers.cloudflare.com/browser-rendering/)";

// ────────────────────────────────────────────────────────────────────
// Input sanitisers / validators
// ────────────────────────────────────────────────────────────────────

/** Trim and enforce max query length. */
export function sanitizeQuery(query: string): string {
  return query.slice(0, MAX_QUERY_LENGTH).trim();
}

/** Clamp limit to [1, MAX_LIMIT], defaulting when undefined/0. */
export function clampLimit(
  limit: number | undefined,
  defaultVal = DEFAULT_LIMIT
): number {
  if (limit === undefined || limit <= 0) return defaultVal;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

/**
 * Parse and validate that `rawUrl` belongs to pingodoce.pt.
 * Accepts both absolute URLs and root-relative paths.
 * Throws on disallowed domains.
 */
export function validatePingoDoceUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(
      rawUrl.startsWith("http") ? rawUrl : `${BASE_URL}${rawUrl}`
    );
  } catch {
    throw new Error(`Invalid URL: "${rawUrl}"`);
  }
  if (!ALLOWED_HOSTNAMES.has(parsed.hostname)) {
    throw new Error(
      `Domain "${parsed.hostname}" is not in the allowlist. ` +
        `Only pingodoce.pt is permitted.`
    );
  }
  return parsed;
}

// ────────────────────────────────────────────────────────────────────
// DOM extraction (serialised into page.evaluate — no outer-scope refs)
// ────────────────────────────────────────────────────────────────────

/**
 * Extracts product cards from the current page DOM.
 *
 * Strategy order (most-specific → least-specific):
 *  1. SFCC product-link walk  — anchors matching Pingo Doce's confirmed URL
 *                               pattern, walk up to the card container that
 *                               holds image + price; SFCC price format aware.
 *  2. JSON-LD structured data — application/ld+json Product / ItemList
 *  3. CSS heuristics          — common SFCC / e-commerce card selectors
 *  4. Price-text fallback     — any element whose text contains a price
 *
 * Arguments are passed from page.evaluate(fn, limit, baseUrl) so that
 * outer-scope constants are not captured by the serialised function.
 */
function buildExtractFn() {
  type ProductRow = {
    name: string | null;
    price: string | null;
    unitPrice: string | null;
    promotion: string | null;
    url: string | null;
    image: string | null;
    rawText: string | null;
    source: string;
  };

  return (limit: number, baseUrl: string): ProductRow[] => {
    const results: ProductRow[] = [];

    // ── helpers (defined inside so they survive serialisation) ─────

    /** Resolve a root-relative href to an absolute URL. */
    function resolveHref(href: string | null): string | null {
      if (!href) return null;
      if (href.startsWith("http")) return href;
      if (href.startsWith("/")) return `${baseUrl}${href}`;
      return `${baseUrl}/${href}`;
    }

    /** Pick the best src from an img element (handles lazy-load attrs). */
    function imgSrc(el: HTMLImageElement | null): string | null {
      if (!el) return null;
      const src =
        el.getAttribute("data-src") ??
        el.getAttribute("data-lazy-src") ??
        el.getAttribute("data-original") ??
        el.getAttribute("src") ??
        null;
      return src?.startsWith("data:") ? null : src; // drop placeholder blobs
    }

    /**
     * Parse SFCC-style price text, e.g.:
     *   "2,95 € Price reduced from 3,49 € to Promoção até 28/09"
     *
     * Returns { price, promotion } where price is the current (lowest)
     * price and promotion captures the original price + date if present.
     */
    function parsePrices(text: string): {
      price: string | null;
      promotion: string | null;
    } {
      // Collect all price tokens in document order
      const allPrices = [...text.matchAll(/(\d{1,4},\d{2})\s*€/g)].map(
        (m) => m[1]
      );
      if (allPrices.length === 0) return { price: null, promotion: null };

      // Current price is the first (and lowest when reduced)
      const currentPrice = `${allPrices[0]}€`;

      // Build promotion string from reduction info and/or promo date
      let promotion: string | null = null;
      const parts: string[] = [];

      if (allPrices.length > 1) {
        // "Price reduced from X to Y" pattern — original is the 2nd price
        parts.push(`Antes: ${allPrices[1]}€`);
      }
      const promoDateM = text.match(/Promoção\s+até\s+[\d\/]+/i);
      if (promoDateM) parts.push(promoDateM[0].trim());

      if (parts.length > 0) promotion = parts.join(" | ");

      return { price: currentPrice, promotion };
    }

    // ── Strategy 1: SFCC product-link walk ────────────────────────
    //
    // Explorer confirmed: product page URLs follow
    //   /home/produtos/<slug>.html
    // Images are served from static.pingodoce.pt/dw/image/
    //
    // Walk up from each unique product anchor to find the card container
    // that holds both an image and a price, then extract fields from it.

    const rawAnchors = Array.from(
      document.querySelectorAll<HTMLAnchorElement>(
        'a[href*="/home/produtos/"]'
      )
    ).filter((a) => {
      const href = a.getAttribute("href") ?? "";
      return href.endsWith(".html") || href.includes(".html?");
    });

    // Deduplicate by normalised href (image-links and name-links share the URL)
    const seenHrefs = new Set<string>();
    const productAnchors = rawAnchors.filter((a) => {
      const href = a.getAttribute("href") ?? "";
      if (seenHrefs.has(href)) return false;
      seenHrefs.add(href);
      return true;
    });

    for (const anchor of productAnchors) {
      if (results.length >= limit) break;

      // Walk up the DOM to find the smallest container that has
      // both an image and price text (max 8 levels to avoid <body>).
      let card: Element | null = anchor.parentElement;
      for (let depth = 0; depth < 8 && card && card !== document.body; depth++) {
        const hasImg = card.querySelector("img") !== null;
        const hasPrice = /\d+,\d{2}\s*€/.test(card.textContent ?? "");
        if (hasImg && hasPrice) break;
        card = card.parentElement;
      }

      // If walk failed, try known SFCC / common container selectors
      if (
        !card ||
        card === document.body ||
        !card.querySelector("img") ||
        !/\d+,\d{2}\s*€/.test(card.textContent ?? "")
      ) {
        card =
          anchor.closest<Element>(
            ".product-tile, .product-grid-item, " +
              '[class*="tile" i], [class*="product-item" i], ' +
              "li, article"
          ) ?? anchor.parentElement;
      }

      if (!card) continue;

      const cardText = (card.textContent ?? "").replace(/\s+/g, " ").trim();

      // ── Name ──────────────────────────────────────────────────────
      // Prefer the anchor text when it looks like a product name
      // (non-empty and doesn't start with a digit/price).
      let name: string | null = null;
      const anchorText = (anchor.textContent ?? "").replace(/\s+/g, " ").trim();
      if (anchorText.length > 2 && !/^\d+[,.]/.test(anchorText)) {
        name = anchorText;
      }
      if (!name) {
        // Look for a heading or named element within the card
        const nameEl = card.querySelector<Element>(
          "h2, h3, h4, " +
            '[class*="product-name" i], [class*="pdp-link" i], ' +
            '[class*="tile-body" i] a, [class*="name" i]'
        );
        name = (nameEl?.textContent ?? "").replace(/\s+/g, " ").trim() || null;
      }
      if (!name) {
        // Image alt attribute as last resort
        const sfccImg = card.querySelector<HTMLImageElement>(
          'img[src*="static.pingodoce.pt"], img[src*="/dw/image/"]'
        );
        name = sfccImg?.getAttribute("alt")?.trim() || null;
      }

      // ── Price + Promotion ─────────────────────────────────────────
      const { price, promotion } = parsePrices(cardText);

      // ── Unit price ────────────────────────────────────────────────
      const unitM = cardText.match(
        /(\d{1,4}[,.]\d{2,4})\s*€\s*\/\s*(kg|g|l|ml|cl|un)/i
      );
      const unitPrice = unitM
        ? `${unitM[1]}€/${unitM[2].toLowerCase()}`
        : null;

      // ── URL ───────────────────────────────────────────────────────
      const url = resolveHref(anchor.getAttribute("href"));

      // ── Image — prefer SFCC CDN, fall back to any img in card ─────
      const sfccImg = card.querySelector<HTMLImageElement>(
        'img[src*="static.pingodoce.pt"], img[src*="/dw/image/"]'
      );
      const image = imgSrc(sfccImg) ?? imgSrc(card.querySelector("img"));

      // Skip entries with no usable name AND no price (pure noise)
      if (!name && !price) continue;

      results.push({
        name,
        price,
        unitPrice,
        promotion,
        url,
        image,
        rawText: cardText.slice(0, 500),
        source: "sfcc-product-link",
      });
    }

    if (results.length >= limit) return results.slice(0, limit);

    // ── Strategy 2: JSON-LD ────────────────────────────────────────
    // Useful on product detail pages and any SFCC pages that emit LD+JSON.
    const ldScripts = Array.from(
      document.querySelectorAll('script[type="application/ld+json"]')
    );
    for (const script of ldScripts) {
      if (results.length >= limit) break;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data: any = JSON.parse(script.textContent ?? "");
        const items: unknown[] =
          data?.["@type"] === "ItemList"
            ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ((data.itemListElement ?? []) as any[]).map(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (i: any) => i?.item ?? i
              )
            : data?.["@type"] === "Product"
            ? [data]
            : [];

        for (const item of items as Record<string, unknown>[]) {
          if (results.length >= limit) break;
          if (item?.["@type"] !== "Product") continue;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const offers: any = Array.isArray(item.offers)
            ? item.offers[0]
            : (item.offers ?? {});
          const priceNum =
            offers?.price != null ? String(offers.price) : null;
          const currency: string = offers?.priceCurrency ?? "EUR";
          const rawImg = item.image;
          const imageUrl: string | null = Array.isArray(rawImg)
            ? (rawImg[0] as string) ?? null
            : typeof rawImg === "string"
            ? rawImg
            : null;
          results.push({
            name: typeof item.name === "string" ? item.name : null,
            price: priceNum ? `${priceNum} ${currency}` : null,
            unitPrice: null,
            promotion: null,
            url:
              typeof item.url === "string"
                ? item.url
                : typeof offers?.url === "string"
                ? offers.url
                : null,
            image: imageUrl,
            rawText: null,
            source: "json-ld",
          });
        }
      } catch {
        // malformed JSON-LD — skip
      }
    }
    if (results.length >= limit) return results.slice(0, limit);

    // ── Strategy 3: CSS heuristics ─────────────────────────────────
    // SFCC-common selectors first, then generic e-commerce patterns.
    const CARD_SELECTORS = [
      // SFCC standard
      ".product-tile",
      ".product-grid-item",
      '[class*="product-tile" i]',
      // Data-attribute patterns (reliable when present)
      "[data-product-id]",
      "[data-itemid]",
      "[data-sku]",
      "[data-product]",
      // BEM / component-name conventions
      ".product-card",
      ".product-item",
      '[class*="ProductCard"]',
      '[class*="product-card"]',
      '[class*="product-item"]',
      '[class*="ProductItem"]',
      "article.type-product",
      'li[class*="product"]',
      ".product",
    ];

    let cards: Element[] = [];
    for (const sel of CARD_SELECTORS) {
      const found = Array.from(document.querySelectorAll(sel));
      if (found.length > 0) {
        cards = found;
        break;
      }
    }

    // ── Strategy 4: Price-text fallback (last resort) ──────────────
    if (cards.length === 0) {
      const PRICE_RE = /\d+,\d{2}\s*€/;
      cards = Array.from(
        document.querySelectorAll("div, li, article, section")
      ).filter(
        (el) =>
          PRICE_RE.test(el.textContent ?? "") &&
          el.children.length >= 1 &&
          el.children.length <= 30
      );
    }

    for (const card of cards) {
      if (results.length >= limit) break;

      const text = (card.textContent ?? "").replace(/\s+/g, " ").trim();

      const nameEl = card.querySelector(
        "h1, h2, h3, h4, " +
          '[class*="name" i], [class*="title" i], ' +
          '[class*="pdp-link" i], [data-testid*="name" i]'
      );
      const name = (nameEl?.textContent ?? "").trim() || null;

      const { price, promotion } = parsePrices(text);

      const unitMatch = text.match(
        /(\d{1,4}[,.]\d{2,4})\s*€\s*\/\s*(kg|g|l|ml|cl|un)/i
      );
      const unitPrice = unitMatch
        ? `${unitMatch[1]}€/${unitMatch[2].toLowerCase()}`
        : null;

      const aEl = card.querySelector("a[href]");
      const url = resolveHref(aEl?.getAttribute("href") ?? null);

      const imgEl = card.querySelector<HTMLImageElement>("img");
      let image: string | null = imgSrc(imgEl);
      if (!image) image = null;

      if (name || price) {
        results.push({
          name,
          price,
          unitPrice,
          promotion,
          url,
          image,
          rawText: text.slice(0, 500),
          source: "heuristic",
        });
      }
    }

    return results.slice(0, limit);
  };
}

// ────────────────────────────────────────────────────────────────────
// Browser launch helper
// ────────────────────────────────────────────────────────────────────

type BrowserInstance = Awaited<ReturnType<typeof puppeteer.launch>>;

async function launchBrowser(env: Env): Promise<BrowserInstance> {
  // puppeteer.launch accepts the Cloudflare BROWSER Fetcher binding.
  // Cast to `any` because the type definition expects a slightly
  // different signature depending on workers-types version.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return puppeteer.launch(env.BROWSER as any);
}

/** Shared page setup — user-agent + timeouts. */
async function setupPage(
  browser: BrowserInstance
): Promise<ReturnType<BrowserInstance["newPage"]> extends Promise<infer P> ? P : never> {
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  page.setDefaultTimeout(NAV_TIMEOUT_MS);
  return page;
}

/** Navigate and wait for JS rendering. */
async function navigateTo(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any,
  url: string
): Promise<void> {
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: NAV_TIMEOUT_MS,
  });
  // Brief pause for JS-rendered product grids / lazy-load triggers
  await new Promise<void>((r) => setTimeout(r, JS_RENDER_WAIT_MS));
}

// ────────────────────────────────────────────────────────────────────
// Public scraping functions
// ────────────────────────────────────────────────────────────────────

/**
 * Searches Pingo Doce for products matching `query`.
 *
 * Tries multiple candidate search URLs in sequence until one returns
 * results. The correct URL can only be confirmed by inspecting the
 * live site — update the `searchUrls` array after manual testing.
 */
export async function scrapeSearch(
  env: Env,
  query: string,
  limit: number
): Promise<{ products: ProductResult[]; warning?: string }> {
  const q = sanitizeQuery(query);
  const n = clampLimit(limit);

  // ── Search URL candidates (ordered: best-known → fallback) ───────
  //
  // Primary: Salesforce Commerce Cloud (SFCC) Search-Show endpoint.
  //   Confirmed by live exploration of pingodoce.pt.
  //   - sz=N    → page size (number of results)
  //   - prefn1/prefv1 → refinement: only show products marked online
  //
  // Fallback: same endpoint without the online-flag refinement (wider net),
  // then a bare search in case the SFCC path changes.
  const qEnc = encodeURIComponent(q);
  const sfccBase =
    `${BASE_URL}/on/demandware.store/Sites-pingo-doce-Site/default/Search-Show`;
  const searchUrls = [
    // Primary — SFCC Search-Show with online-only refinement + page size
    `${sfccBase}?q=${qEnc}&prefn1=onlineFlag&prefv1=true&sz=${n}`,
    // Fallback 1 — without online refinement (catches items not tagged)
    `${sfccBase}?q=${qEnc}&sz=${n}`,
    // Fallback 2 — bare SFCC search (no params beyond query)
    `${sfccBase}?q=${qEnc}`,
  ];

  let browser: BrowserInstance | null = null;
  try {
    browser = await launchBrowser(env);
    const page = await setupPage(browser);

    let products: ProductResult[] = [];
    const warnings: string[] = [];

    for (const url of searchUrls) {
      try {
        await navigateTo(page, url);
        // Scroll to trigger lazy-loading (conservative — one viewport)
        await page.evaluate(() =>
          window.scrollBy(0, window.innerHeight * 0.8)
        );
        await new Promise<void>((r) => setTimeout(r, 500));

        const extractFn = buildExtractFn();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const raw = await page.evaluate(extractFn as any, n, BASE_URL);
        products = raw as ProductResult[];

        if (products.length > 0) break; // success
      } catch (err) {
        warnings.push(
          `URL ${url} failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    if (products.length === 0 && warnings.length > 0) {
      return {
        products: [],
        warning:
          "No results found. The search URL pattern may need updating. " +
          "Errors: " +
          warnings.join("; "),
      };
    }

    return {
      products,
      ...(warnings.length > 0 ? { warning: warnings.join("; ") } : {}),
    };
  } finally {
    // Always close the browser — even on error
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore close errors */
      }
    }
  }
}

/**
 * Fetches detailed product information from a specific Pingo Doce product URL.
 * Only accepts URLs on pingodoce.pt (enforced by validatePingoDoceUrl).
 */
export async function scrapeProductPage(
  env: Env,
  rawUrl: string
): Promise<{ product: ProductResult; warning?: string }> {
  const url = validatePingoDoceUrl(rawUrl);

  let browser: BrowserInstance | null = null;
  try {
    browser = await launchBrowser(env);
    const page = await setupPage(browser);
    await navigateTo(page, url.href);

    const product: ProductResult = await page.evaluate(
      (baseUrl: string): {
        name: string | null;
        price: string | null;
        unitPrice: string | null;
        promotion: string | null;
        url: string | null;
        image: string | null;
        rawText: string | null;
        source: string;
      } => {
        // ── JSON-LD first ────────────────────────────────────────
        const ldScripts = Array.from(
          document.querySelectorAll('script[type="application/ld+json"]')
        );
        for (const script of ldScripts) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const data: any = JSON.parse(script.textContent ?? "");
            if (data?.["@type"] === "Product") {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const offers: any = Array.isArray(data.offers)
                ? data.offers[0]
                : (data.offers ?? {});
              const priceNum =
                offers?.price != null ? String(offers.price) : null;
              const currency: string = offers?.priceCurrency ?? "EUR";
              const rawImg = data.image;
              const imageUrl: string | null = Array.isArray(rawImg)
                ? (rawImg[0] as string) ?? null
                : typeof rawImg === "string"
                ? rawImg
                : null;
              return {
                name: typeof data.name === "string" ? data.name : null,
                price: priceNum ? `${priceNum} ${currency}` : null,
                unitPrice: null,
                promotion: null,
                url: window.location.href,
                image: imageUrl,
                rawText: null,
                source: "json-ld",
              };
            }
          } catch {
            /* skip malformed */
          }
        }

        // ── Heuristic fallback ───────────────────────────────────
        const text = (document.body.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim();

        const h1 = document.querySelector("h1");
        const name = h1 ? (h1.textContent ?? "").trim() || null : null;

        const priceM =
          text.match(/(\d{1,4}[,.]\d{2})\s*€/) ??
          text.match(/€\s*(\d{1,4}[,.]\d{2})/);
        const price = priceM ? `${priceM[1]}€` : null;

        const unitM = text.match(
          /(\d{1,4}[,.]\d{2,4})\s*€\s*\/\s*(kg|g|l|ml|cl|un)/i
        );
        const unitPrice = unitM
          ? `${unitM[1]}€/${unitM[2].toLowerCase()}`
          : null;

        const promoEl = document.querySelector(
          '[class*="promo" i], [class*="sale" i], ' +
            '[class*="desconto" i], [class*="oferta" i], ' +
            '[class*="campanha" i], [class*="poupanca" i]'
        );
        const promotion =
          promoEl ? (promoEl.textContent ?? "").trim() || null : null;

        // Image: prefer product-specific containers
        const imgEl = document.querySelector(
          '.product img, [class*="product" i] img, ' +
            '[class*="gallery" i] img, [class*="hero" i] img, ' +
            "main img, article img"
        );
        let image: string | null =
          imgEl?.getAttribute("data-src") ??
          imgEl?.getAttribute("data-lazy-src") ??
          imgEl?.getAttribute("src") ??
          null;
        if (image?.startsWith("data:")) image = null;

        void baseUrl; // passed in but not needed after URL normalisation
        return {
          name,
          price,
          unitPrice,
          promotion,
          url: window.location.href,
          image,
          rawText: text.slice(0, 1_000),
          source: "detail-page",
        };
      },
      BASE_URL
    );

    return { product };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Scrapes the promotions/offers section of Pingo Doce.
 *
 * Tries multiple candidate promotion URLs. The correct URL must be
 * verified by inspecting the live site.
 */
export async function scrapePromotions(
  env: Env,
  category: string | undefined,
  limit: number
): Promise<{ products: ProductResult[]; warning?: string }> {
  const n = clampLimit(limit);
  const catSlug = category ? encodeURIComponent(category.toLowerCase()) : "";

  // Candidate promotion URL patterns (update after live inspection)
  const promoUrls = [
    `${BASE_URL}/promocoes/${catSlug ? catSlug + "/" : ""}`,
    `${BASE_URL}/oferta-da-semana/`,
    `${BASE_URL}/produtos/?on-sale=1${catSlug ? `&cat=${catSlug}` : ""}`,
    `${BASE_URL}/loja/promocoes/`,
    `${BASE_URL}/destaque/`,
  ];

  let browser: BrowserInstance | null = null;
  try {
    browser = await launchBrowser(env);
    const page = await setupPage(browser);

    let products: ProductResult[] = [];
    const warnings: string[] = [];

    for (const url of promoUrls) {
      try {
        await navigateTo(page, url);
        await page.evaluate(() =>
          window.scrollBy(0, window.innerHeight * 0.8)
        );
        await new Promise<void>((r) => setTimeout(r, 500));

        const extractFn = buildExtractFn();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const raw = await page.evaluate(extractFn as any, n, BASE_URL);
        products = raw as ProductResult[];

        if (products.length > 0) break;
      } catch (err) {
        warnings.push(
          `URL ${url} failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return {
      products,
      ...(warnings.length > 0 ? { warning: warnings.join("; ") } : {}),
    };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    }
  }
}
