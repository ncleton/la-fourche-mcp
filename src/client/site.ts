import {
  ROBOT_PATTERN, decodeHtml, formatEuro, hasVeganClaim, isObject, isOrganic, parsePrice, str, stripTags,
  type Adapter, type MutationInput, type SessionSignals,
} from "./adapter.js";
import { ContractChangedError } from "./errors.js";
import type { CartInput, ProductInput, SummaryInput } from "./types.js";

const HOST = "lafourche.fr";
const ORIGIN = `https://${HOST}`;

const PRELUDE = String.raw`
const clean = (value) => String(value == null ? "" : value).replace(/\s+/g, " ").trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, timeout, label) => {
  const start = Date.now();
  while (Date.now() - start < timeout) { const value = predicate(); if (value) return value; await sleep(250); }
  throw new Error("Délai dépassé : " + label);
};
const go = async (path) => { await window.next.router.push(path); };
const algoliaConfig = () => {
  const config = window.__NEXT_DATA__ && window.__NEXT_DATA__.runtimeConfig && window.__NEXT_DATA__.runtimeConfig.algoliaConfig;
  if (!config || !config.app || !config.app.id || !config.app.key || !config.environment) throw new Error("Contrat Algolia absent de la configuration publique");
  return config;
};
const algolia = async (params) => {
  const config = algoliaConfig();
  const response = await fetch("https://" + config.app.id + "-dsn.algolia.net/1/indexes/*/queries", { method: "POST", headers: { "X-Algolia-Application-Id": config.app.id, "X-Algolia-API-Key": config.app.key }, body: JSON.stringify({ requests: [{ indexName: config.environment + "_products_default:fr_FR", params: params }] }) });
  if (!response.ok) throw new Error("Algolia HTTP " + response.status);
  const json = await response.json();
  if (!json.results || !json.results[0] || !Array.isArray(json.results[0].hits)) throw new Error("Contrat Algolia modifié");
  return json.results[0].hits;
};
const parseList = (value) => { if (Array.isArray(value)) return value; try { const parsed = JSON.parse(value || "[]"); return Array.isArray(parsed) ? parsed : []; } catch (error) { return []; } };
const unitPrice = (hit) => {
  const finance = hit.meta && hit.meta.finance;
  if (!finance || typeof finance.unit_price !== "number" || !finance.unit_of_measurement) return null;
  return finance.unit_price.toFixed(2).replace(".", ",") + " €/" + String(finance.unit_of_measurement).toLowerCase();
};
const summarize = (hit) => ({
  handle: hit.handle, sku: hit.sku, title: clean(hit.title), brand: hit.vendor || null, price: hit.price, per_unit: unitPrice(hit), available: hit.inventory_available === true, quantity: hit.inventory_quantity,
  fresh: hit.is_fresh === true || hit.is_ultra_fresh === true, organic: /\bbio\b/i.test(hit.title || "") || (hit.tags || []).some((tag) => /bio/i.test(tag)), vegan: parseList(hit.diets).some((diet) => /vegan|v[ée]g[ée]talien/i.test(diet)),
});
const readCartPage = async () => {
  await go("/cart");
  await waitFor(() => document.querySelector("main") && /panier/i.test(document.body.innerText), 15000, "page panier");
  let signature = "";
  let stable = 0;
  const start = Date.now();
  while (Date.now() - start < 20000 && stable < 5) {
    await sleep(400);
    const current = document.querySelectorAll("main article[data-testname='product-card']").length + "|" + clean(document.querySelector("main").innerText).slice(0, 4000);
    if (current === signature) stable++; else { signature = current; stable = 0; }
  }
  const main = document.querySelector("main");
  const cards = Array.prototype.slice.call(main.querySelectorAll("article[data-testname='product-card']"));
  const text = clean(main.innerText);
  const subtotal = text.match(/Sous-total\s*\((\d+)\s*produits?\)\s*([\d\s.,\u00a0]+)\s*€/i);
  if (!subtotal) throw new Error("Contrat sous-total du panier absent");
  const items = cards.map((card) => {
    const link = card.querySelector("[data-testid='product-title'] a, a[data-testid='product-title']");
    const href = link ? link.getAttribute("href") : null;
    const handle = href ? new URL(href, location.origin).pathname.replace(/^\/products\//, "") : null;
    const region = card.querySelector("[role='region']");
    const amounts = Array.prototype.slice.call(card.querySelectorAll("p")).map((node) => clean(node.textContent)).filter((value) => /^[\d\s.,\u00a0]+€$/.test(value));
    return { id: handle, name: clean(card.getAttribute("aria-label") || (link && link.textContent)), quantity: region ? clean(region.textContent) : null, line_total: amounts.length ? amounts[amounts.length - 1] : null };
  });
  if (!items.length && !/panier est vide/i.test(text)) throw new Error("Contrat panier absent");
  return { total: clean(subtotal[2]) + " €", items: items };
};
`;

function searchExpression(query: string, limit: number): string {
  return String.raw`(async () => {
    ${PRELUDE}
    const hits = await algolia("query=" + encodeURIComponent(${JSON.stringify(query)}) + "&hitsPerPage=${limit}");
    return hits.map(summarize);
  })()`;
}

function productExpression(productUrl: string): string {
  return String.raw`(async () => {
    ${PRELUDE}
    const handle = new URL(${JSON.stringify(productUrl)}).pathname.replace(/^\/products\//, "");
    const hits = await algolia("query=&hitsPerPage=1&filters=" + encodeURIComponent("handle:\"" + handle + "\""));
    if (!hits.length) throw new Error("Fiche introuvable : " + handle);
    const hit = hits[0];
    const marketing = (hit.meta && hit.meta.marketing) || {};
    const strip = (html) => html ? clean(new DOMParser().parseFromString(String(html), "text/html").body.textContent) : null;
    return Object.assign(summarize(hit), { ingredients: strip(marketing.ingredients), description: strip(marketing.short_description) || strip(hit.body_html_safe), nutriscore: marketing.nutriscore_grade || null });
  })()`;
}

function cartExpression(): string {
  return String.raw`(async () => { ${PRELUDE} return readCartPage(); })()`;
}

function mutationExpression(input: MutationInput): string {
  return String.raw`(async () => {
    ${PRELUDE}
    const handle = ${JSON.stringify(input.productId)};
    const target = ${input.targetQuantity};
    const before = await readCartPage();
    const line = before.items.find((item) => item.id === handle);
    const current = line ? Number(line.quantity) : 0;
    if (current === target) return { before: before, after: before, applied: false };
    await go("/products/" + handle);
    const section = await waitFor(() => document.querySelector("#main-price-actions"), 20000, "zone d’achat de la fiche");
    await sleep(1500);
    const count = () => { const input = section.querySelector("input[data-testid='ButtonCounter-input-count']"); return input ? Number(input.value) : 0; };
    const addButton = () => section.querySelector("[data-testid='ButtonCounter-Button-add-item']") || Array.prototype.slice.call(section.querySelectorAll("button")).find((button) => /ajouter au panier/i.test((button.getAttribute("aria-label") || "") + button.textContent));
    const removeButton = () => section.querySelector("[data-testid='ButtonCounter-Button-remove-item']");
    const freshModal = () => Array.prototype.slice.call(document.querySelectorAll("*")).find((node) => getComputedStyle(node).position === "fixed" && /[ée]ligible au March[ée] Frais/i.test(node.innerText || "") && node.getBoundingClientRect().height > 100);
    while (count() !== target) {
      const wanted = count() < target;
      const button = wanted ? addButton() : removeButton();
      if (!button || button.disabled) throw new Error(wanted ? "Ajout impossible : le bouton est absent ou désactivé (stock ou plafond atteint)" : "Retrait impossible : le bouton est absent ou désactivé");
      const was = count();
      button.click();
      const start = Date.now();
      while (count() === was && Date.now() - start < 8000) {
        if (freshModal()) throw new Error("Produit du Marché Frais : La Fourche exige une adresse éligible. Saisissez votre adresse dans la fenêtre Camoufox (« Suis-je éligible au Marché Frais ? ») puis relancez la commande.");
        await sleep(250);
      }
      if (count() === was) throw new Error("Le compteur de la fiche n’a pas bougé après le clic");
      await sleep(400);
    }
    await sleep(2000);
    return { before: before, after: await readCartPage(), applied: true };
  })()`;
}

function handleOf(url: URL): string | null {
  return url.pathname.match(/^\/products\/([a-z0-9-]+)\/?$/)?.[1] ?? null;
}

function availabilityOf(entry: Record<string, unknown>): "available" | "out_of_stock" {
  return entry.available === true && Number(entry.quantity) > 0 ? "available" : "out_of_stock";
}

export const adapter: Adapter = {
  entryUrl: () => `${ORIGIN}/`,
  matchesTab: (u) => u.protocol === "https:" && u.hostname === HOST,
  inspectSession({ snapshot, tabUrl }): SessionSignals {
    let onSite = false;
    try { onSite = new URL(tabUrl).hostname === HOST; } catch { onSite = false; }
    const robotVisible = ROBOT_PATTERN.test(snapshot);
    return { ready: onSite && !robotVisible && snapshot.trim().length > 0, robotVisible, accountConnected: !/se connecter/i.test(snapshot) && /mon compte|d[ée]connexion/i.test(snapshot) };
  },
  validateProductUrl(u) {
    if (u.protocol !== "https:" || u.hostname !== HOST || !handleOf(u)) throw new Error("Hors des fiches produit La Fourche.");
  },
  searchExpression: (_config, query, limit) => searchExpression(query, limit),
  normalizeSearch(raw): SummaryInput[] {
    if (!Array.isArray(raw)) throw new ContractChangedError("La recherche n’a pas retourné une liste de produits.");
    return raw.map((entry): SummaryInput => {
      if (!isObject(entry)) throw new ContractChangedError("Un produit n’est plus un objet exploitable.");
      const handle = str(entry, "handle");
      const name = str(entry, "title");
      const price = parsePrice(entry.price);
      if (!handle || !name || price === null || typeof entry.available !== "boolean") throw new ContractChangedError("Un produit ne contient plus son identifiant, son nom, son prix ou son état commandable.");
      const quantity = Number(entry.quantity);
      return {
        product_id: handle, name: decodeHtml(name), brand: str(entry, "brand"), price, unit_price: str(entry, "per_unit"),
        availability: availabilityOf(entry), available_quantity: Number.isInteger(quantity) && quantity >= 0 ? quantity : null, organic: entry.organic === true || isOrganic(name), product_url: `${ORIGIN}/products/${handle}`,
      };
    });
  },
  productExpression: (_config, productUrl) => productExpression(productUrl),
  normalizeProduct(raw, _config, requestedUrl): ProductInput {
    if (!isObject(raw)) throw new ContractChangedError("La fiche n’a pas retourné l’objet produit attendu.");
    const handle = str(raw, "handle") ?? handleOf(new URL(requestedUrl));
    const name = str(raw, "title");
    const price = parsePrice(raw.price);
    if (!handle || !name || price === null || typeof raw.available !== "boolean") throw new ContractChangedError("La fiche ne contient plus son identifiant, son nom, son prix ou son état commandable.");
    const quantity = Number(raw.quantity);
    const text = `${name} ${str(raw, "description") ?? ""}`;
    return {
      product_id: handle, name: decodeHtml(name), brand: str(raw, "brand"), price, unit_price: str(raw, "per_unit"),
      availability: availabilityOf(raw), available_quantity: Number.isInteger(quantity) && quantity >= 0 ? quantity : null, organic: raw.organic === true || isOrganic(text), product_url: requestedUrl,
      ean: null, ingredients: str(raw, "ingredients"), vegan_claim: raw.vegan === true || hasVeganClaim(stripTags(text)), nutrition: [],
    };
  },
  cartExpression: () => cartExpression(),
  normalizeCart(raw): CartInput {
    if (!isObject(raw) || !Array.isArray(raw.items)) throw new ContractChangedError("Le panier n’a plus la forme observée.");
    const items = raw.items.map((entry) => {
      if (!isObject(entry)) throw new ContractChangedError("Une ligne de panier n’est plus exploitable.");
      const id = str(entry, "id");
      const quantity = Math.round(Number(entry.quantity));
      if (!id || !Number.isInteger(quantity) || quantity < 0) throw new ContractChangedError("Une ligne de panier ne contient plus son identifiant ou sa quantité.");
      const lineTotal = parsePrice(entry.line_total);
      return { product_id: id, name: str(entry, "name"), quantity, available_quantity: null, unit_price: lineTotal === null || quantity === 0 ? null : Math.round((lineTotal / quantity) * 100) / 100, line_total: lineTotal };
    });
    const total = parsePrice(raw.total);
    if (total === null) throw new ContractChangedError("Le total du panier n’est plus publié.");
    const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
    return { empty: totalQuantity === 0, total_quantity: totalQuantity, total_price: formatEuro(total), items };
  },
  mutationExpression: (_config, input) => mutationExpression(input),
};
