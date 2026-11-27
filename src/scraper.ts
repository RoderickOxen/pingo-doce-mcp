/**
 * scraper.ts — Browser Rendering scraper for the Pingo Doce online store.
 *
 * ⚠️  LEGAL / ETHICAL NOTICE ⚠️
 * Personal, internal, or demo use only. Review https://www.pingodoce.pt/robots.txt
 * and the Pingo Doce Terms of Service before deploying. Note that robots.txt
 * disallows `/on/demandware.store/` (the only search endpoint) and `?sz=`.
 * Do NOT use at high frequency or for commercial resale of pricing data.
 *
 * Site facts (verified against the live site, Nov 2026):
 *  - Salesforce Commerce Cloud (SFCC), server-side rendered.
 *  - Search:      /on/demandware.store/Sites-pingo-doce-Site/default/Search-Show?q=…&sz=N
 *  - Promotions:  /home/produtos/promocoes[/poupe-esta-semana|/poupe-este-fim-de-semana]
 *  - Categories:  /home/produtos/<slug>             e.g. leite-e-bebidas-vegetais
 *  - Product:     /home/produtos/<cat>/…/<slug>-<pid>.html
 *  - Tile:        .product-tile-pd[data-pid]  (name, brand, unit, .sales/.strike-through .value[content])
 *  - PDP:         .product-detail[data-pid]   (JSON-LD has NO offers → price must come from DOM)
 */

import puppeteer, { type Browser, type Page } from "@cloudflare/puppeteer";
import type { Env, ProductResult } from "./types.ts";

// ────────────────────────────────────────────────────────────────────
// Guardrails / constants
// ────────────────────────────────────────────────────────────────────

const ALLOWED_HOSTNAMES = new Set(["pingodoce.pt", "www.pingodoce.pt"]);
const BASE_URL = "https://www.pingodoce.pt";
const SEARCH_URL = `${BASE_URL}/on/demandware.store/Sites-pingo-doce-Site/default/Search-Show`;

export const MAX_QUERY_LENGTH = 200;
export const MAX_LIMIT = 50;
export const DEFAULT_LIMIT = 10;

/** Promotion sub-lists that live under /home/produtos/promocoes/ */
export const PROMO_LISTS = ["poupe-esta-semana", "poupe-este-fim-de-semana"] as const;

/** Top-level product categories (slugs under /home/produtos/). */
export const CATEGORY_SLUGS = [
  "aguas-sumos-e-refrigerantes", "alternativas-alimentares", "animais",
  "bebe-e-crianca", "bolachas-cereais-e-guloseimas", "cafe-cha-e-achocolatados",
  "casa-e-eletrodomesticos", "cervejas-e-sidras", "charcutaria-e-queijos",
  "congelados", "espirituosas", "frutas-e-vegetais", "higiene-pessoal-e-beleza",
  "iogurtes-e-sobremesas", "leite-e-bebidas-vegetais", "limpeza",
  "livraria-e-papelaria", "manteiga-margarina-e-natas", "mercearia", "ovos",
  "padaria-e-pastelaria", "parafarmacia", "peixaria", "take-away", "talho", "vinhos",
] as const;

const NAV_TIMEOUT_MS = 20_000;
const SELECTOR_TIMEOUT_MS = 8_000;

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 " +
  "CloudflareWorkerBrowserRendering/1.0 (+https://developers.cloudflare.com/browser-rendering/)";

// ────────────────────────────────────────────────────────────────────
// Input sanitisers / validators
// ────────────────────────────────────────────────────────────────────

export function sanitizeQuery(query: string): string {
  return query.slice(0, MAX_QUERY_LENGTH).trim();
}

export function clampLimit(limit: number | undefined, defaultVal = DEFAULT_LIMIT): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return defaultVal;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

/** Parse and validate that `rawUrl` is an https URL on pingodoce.pt. */
export function validatePingoDoceUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl, BASE_URL);
  } catch {
    throw new Error(`Invalid URL: "${rawUrl}"`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Unsupported protocol "${parsed.protocol}".`);
  }
  if (!ALLOWED_HOSTNAMES.has(parsed.hostname)) {
    throw new Error(
      `Domain "${parsed.hostname}" is not in the allowlist. Only pingodoce.pt is permitted.`
    );
  }
  parsed.protocol = "https:";
  return parsed;
}

/** Normalise a category / promo-list slug; throws on anything unsafe. */
function normaliseSlug(raw: string): string {
  const slug = raw.trim().toLowerCase().replace(/^\/+|\/+$/g, "");
  if (!/^[a-z0-9-]+(\/[a-z0-9-]+)*$/.test(slug) || slug.length > 100) {
    throw new Error(
      `Invalid category "${raw}". Use a slug such as "leite-e-bebidas-vegetais".`
    );
  }
  return slug;
}

// ────────────────────────────────────────────────────────────────────
// In-page extraction
//
// These functions are serialised by page.evaluate(). They must not reference
// outer-scope values. wrangler.jsonc sets `keep_names: false` so esbuild does
// not inject `__name(...)` helpers into them (which would throw
// "ReferenceError: __name is not defined" inside the browser).
// ────────────────────────────────────────────────────────────────────

function extractTilesInPage(
  limit: number,
  baseUrl: string,
  onlyPromos: boolean
): ProductResult[] {
  const clean = (s: string | null | undefined): string | null => {
    const t = (s ?? "").replace(/[\s\u200b]+/g, " ").trim();
    return t.length > 0 ? t : null;
  };
  const abs = (href: string | null | undefined): string | null => {
    if (!href) return null;
    try {
      return new URL(href, baseUrl).href;
    } catch {
      return null;
    }
  };
  const toNum = (v: string | null | undefined): number | null => {
    if (v == null || v === "") return null;
    const n = Number(String(v).replace(",", "."));
    return Number.isFinite(n) ? n : null;
  };
  const eur = (n: number | null): string | null =>
    n == null ? null : `${n.toFixed(2).replace(".", ",")} €`;
  /** Price number + per-unit suffix (weighted goods show e.g. "6,19 €/Kg"). */
  const priceOf = (scope: Element, sel: string): { value: number | null; suffix: string } => {
    const el = scope.querySelector(sel);
    if (!el) return { value: null, suffix: "" };
    const text = (el.textContent ?? "").replace(/\s+/g, " ");
    const sm = text.match(/€\s*(\/\s*[A-Za-z]+)/);
    const suffix = sm ? sm[1].replace(/\s+/g, "") : "";
    const fromAttr = toNum(el.querySelector(".value")?.getAttribute("content"));
    if (fromAttr != null) return { value: fromAttr, suffix };
    const m = text.match(/(\d{1,4}(?:[.,]\d{1,2})?)\s*€/);
    return { value: m ? toNum(m[1]) : null, suffix };
  };

  const out: ProductResult[] = [];
  const tiles = Array.from(document.querySelectorAll(".product-tile-pd[data-pid]"));

  for (const tile of tiles) {
    if (out.length >= limit) break;

    const sale = priceOf(tile, ".product-price .sales");
    const list = priceOf(tile, ".product-price .strike-through");
    const price = sale.value;
    const original = list.value;
    const promoLabel = clean(tile.querySelector(".product-tile-promo-label")?.getAttribute("alt"));
    const promoMsg = clean(tile.querySelector(".promo-message")?.textContent);
    const onPromotion = original != null || promoLabel != null || promoMsg != null;
    if (onlyPromos && !onPromotion) continue;

    // ".product-unit" looks like "1 L | 0,89 €/L"
    const unitText = clean(tile.querySelector(".product-unit")?.textContent);
    const unitParts = (unitText ?? "").split("|").map((p) => p.trim()).filter(Boolean);
    const size = unitParts.find((p) => !p.includes("€")) ?? null;
    const salePriceText = eur(price) == null ? null : `${eur(price)}${sale.suffix}`;
    const unitPrice =
      unitParts.find((p) => p.includes("€")) ?? (sale.suffix ? salePriceText : null);

    let category: string | null = null;
    try {
      const gtm = JSON.parse(tile.getAttribute("data-gtm-info") ?? "");
      const item = gtm?.items?.[0];
      category = clean(item?.item_category2 || item?.item_category) ?? null;
    } catch {
      /* no GTM data */
    }

    const nameLink = tile.querySelector(".product-name-link a");
    const imageLink = tile.querySelector("a.product-tile-image-link");
    const img = tile.querySelector("img.product-tile-component-image");

    const promoParts = [promoLabel, promoMsg].filter((p): p is string => p != null);

    out.push({
      id: tile.getAttribute("data-pid"),
      name: clean(nameLink?.textContent) ?? clean(img?.getAttribute("alt")),
      brand: clean(tile.querySelector(".product-brand-name")?.textContent),
      size,
      price: salePriceText,
      priceValue: price,
      originalPrice: eur(original) == null ? null : `${eur(original)}${list.suffix}`,
      unitPrice,
      onPromotion,
      promotion: promoParts.length > 0 ? promoParts.join(" | ") : null,
      category,
      url: abs(nameLink?.getAttribute("href") ?? imageLink?.getAttribute("href")),
      image: abs(img?.getAttribute("src")),
      source: "product-tile",
    });
  }
  return out;
}

function extractProductPageInPage(baseUrl: string): ProductResult | null {
  const clean = (s: string | null | undefined): string | null => {
    const t = (s ?? "").replace(/[\s\u200b]+/g, " ").trim();
    return t.length > 0 ? t : null;
  };
  const toNum = (v: string | null | undefined): number | null => {
    if (v == null || v === "") return null;
    const n = Number(String(v).replace(",", "."));
    return Number.isFinite(n) ? n : null;
  };
  const eur = (n: number | null): string | null =>
    n == null ? null : `${n.toFixed(2).replace(".", ",")} €`;

  const root = document.querySelector(".product-detail[data-pid]");
  if (!root) return null;

  // JSON-LD: name / brand / image / description (no offers on this site)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ld: any = null;
  for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const data = JSON.parse(s.textContent ?? "");
      const nodes = Array.isArray(data) ? data : data?.["@graph"] ?? [data];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ld = nodes.find((n: any) => n?.["@type"] === "Product") ?? ld;
    } catch {
      /* malformed */
    }
  }

  const priceBox = root.querySelector(".prices-add-to-cart-actions") ?? root;
  const suffixOf = (el: Element | null): string => {
    const m = (el?.textContent ?? "").replace(/\s+/g, " ").match(/€\s*(\/\s*[A-Za-z]+)/);
    return m ? m[1].replace(/\s+/g, "") : "";
  };
  const saleEl = priceBox.querySelector(".sales");
  const listEl = priceBox.querySelector(".strike-through");
  const price = toNum(saleEl?.querySelector(".value")?.getAttribute("content"));
  const original = toNum(listEl?.querySelector(".value")?.getAttribute("content"));
  const priceText = eur(price) == null ? null : `${eur(price)}${suffixOf(saleEl)}`;
  const promoLabel = clean(root.querySelector(".product-tile-promo-label")?.getAttribute("alt"));
  const promoEnd = clean(root.querySelector(".product-promo-end")?.textContent);
  const promoParts = [promoLabel, promoEnd].filter((p): p is string => p != null);

  const unitText = clean(root.querySelector(".product-unit-measure")?.textContent);
  const unitParts = (unitText ?? "").split("|").map((p) => p.trim()).filter(Boolean);

  const ldImage = Array.isArray(ld?.image) ? ld.image[0] : ld?.image;
  const domImage = root.querySelector(".primary-images .carousel-item img")?.getAttribute("src");

  let category: string | null = null;
  try {
    const item = JSON.parse(root.getAttribute("data-gtm-info") ?? "")?.items?.[0];
    category = clean(item?.item_category2 || item?.item_category) ?? null;
  } catch {
    /* ignore */
  }

  const onPromotion = original != null || promoParts.length > 0;
  return {
    id: root.getAttribute("data-pid"),
    name: clean(root.querySelector(".product-name")?.textContent) ?? clean(ld?.name),
    brand: clean(root.querySelector(".product-brand")?.textContent) ?? clean(ld?.brand?.name),
    size: unitParts.find((p) => !p.includes("€")) ?? null,
    price: priceText,
    priceValue: price,
    originalPrice: eur(original) == null ? null : `${eur(original)}${suffixOf(listEl)}`,
    unitPrice: unitParts.find((p) => p.includes("€")) ?? (suffixOf(saleEl) ? priceText : null),
    onPromotion,
    promotion: promoParts.length > 0 ? promoParts.join(" | ") : null,
    category,
    description: clean(ld?.description),
    url: new URL(window.location.pathname, baseUrl).href,
    image: typeof ldImage === "string" ? ldImage : domImage ?? null,
    source: "product-page",
  };
}

// ────────────────────────────────────────────────────────────────────
// Browser session helpers
// ────────────────────────────────────────────────────────────────────

/**
 * Launch ONE browser, run `fn` with a prepared page, always close.
 * Re-use the page across several navigations (e.g. compare_prices) to stay
 * well within Browser Rendering's new-browser-per-minute limits.
 */
export async function withBrowser<T>(env: Env, fn: (page: Page) => Promise<T>): Promise<T> {
  let browser: Browser | null = null;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setExtraHTTPHeaders({ "Accept-Language": "pt-PT,pt;q=0.9" });
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

    // Pages are server-rendered: skip heavy assets to cut latency.
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (type === "image" || type === "font" || type === "media" || type === "stylesheet") {
        void req.abort();
      } else {
        void req.continue();
      }
    });

    return await fn(page);
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

/** Navigate, check HTTP status, and wait for the expected selector. */
async function open(page: Page, url: string, waitFor: string): Promise<void> {
  const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  const status = res?.status() ?? 0;
  if (status === 404) throw new Error(`Page not found (404): ${url}`);
  if (status >= 400) throw new Error(`HTTP ${status} from ${url}`);
  try {
    await page.waitForSelector(waitFor, { timeout: SELECTOR_TIMEOUT_MS });
  } catch {
    /* no matching elements (e.g. zero results) — caller decides */
  }
}

async function describePage(page: Page): Promise<string> {
  try {
    return `title="${await page.title()}", url=${page.url()}`;
  } catch {
    return "unknown page";
  }
}

// ────────────────────────────────────────────────────────────────────
// Public scraping functions
// ────────────────────────────────────────────────────────────────────

export type ListResult = { products: ProductResult[]; sourceUrl: string; warning?: string };

/** Search products by keyword. Tries online-only first, then the full catalogue. */
export async function searchProducts(page: Page, query: string, limit: number): Promise<ListResult> {
  const q = encodeURIComponent(sanitizeQuery(query));
  const n = clampLimit(limit);
  const urls = [
    `${SEARCH_URL}?q=${q}&prefn1=onlineFlag&prefv1=true&sz=${n}`,
    `${SEARCH_URL}?q=${q}&sz=${n}`,
  ];

  const errors: string[] = [];
  for (const url of urls) {
    try {
      await open(page, url, ".product-tile-pd[data-pid]");
      const products = await page.evaluate(extractTilesInPage, n, BASE_URL, false);
      if (products.length > 0) return { products, sourceUrl: url };
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return {
    products: [],
    sourceUrl: urls[urls.length - 1],
    warning:
      errors.length > 0
        ? `Search failed: ${errors.join("; ")}`
        : `No products found for "${query}" (${await describePage(page)}).`,
  };
}

/**
 * Current promotions.
 *  - no category            → /home/produtos/promocoes
 *  - "poupe-esta-semana" …  → /home/produtos/promocoes/<list>
 *  - any category slug      → /home/produtos/<slug>, keeping only promoted tiles
 */
export async function scrapePromotions(
  page: Page,
  category: string | undefined,
  limit: number
): Promise<ListResult> {
  const n = clampLimit(limit);
  let url: string;
  let onlyPromos = false;

  if (!category) {
    url = `${BASE_URL}/home/produtos/promocoes?sz=${n}`;
  } else {
    const slug = normaliseSlug(category).replace(/^promocoes\/?/, "");
    if (slug === "") {
      url = `${BASE_URL}/home/produtos/promocoes?sz=${n}`;
    } else if ((PROMO_LISTS as readonly string[]).includes(slug)) {
      url = `${BASE_URL}/home/produtos/promocoes/${slug}?sz=${n}`;
    } else {
      // Over-fetch the category and keep only promoted items.
      // Promos are ~1 in 3 tiles, so fetch generously.
      url = `${BASE_URL}/home/produtos/${slug}?sz=${Math.min(Math.max(n * 6, 48), 200)}`;
      onlyPromos = true;
    }
  }

  try {
    await open(page, url, ".product-tile-pd[data-pid]");
  } catch (err) {
    if (category && err instanceof Error && err.message.startsWith("Page not found")) {
      throw new Error(
        `Unknown category "${category}". Use one of: ${[...PROMO_LISTS, ...CATEGORY_SLUGS].join(", ")}`
      );
    }
    throw err;
  }
  const products = await page.evaluate(extractTilesInPage, n, BASE_URL, onlyPromos);
  return products.length > 0
    ? { products, sourceUrl: url }
    : {
        products,
        sourceUrl: url,
        warning: `No promoted products found (${await describePage(page)}).`,
      };
}

/** Detailed product information from a product page URL. */
export async function scrapeProductPage(
  page: Page,
  rawUrl: string
): Promise<{ product: ProductResult }> {
  const url = validatePingoDoceUrl(rawUrl);
  await open(page, url.href, ".product-detail[data-pid]");
  const product = await page.evaluate(extractProductPageInPage, BASE_URL);
  if (!product) {
    throw new Error(
      `Not a Pingo Doce product page (${await describePage(page)}). ` +
        `Expected a URL like ${BASE_URL}/home/produtos/<category>/…/<name>-<id>.html`
    );
  }
  return { product };
}
