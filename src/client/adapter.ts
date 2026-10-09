import type { ShopConfig } from "./config.js";
import type { CartInput, ProductInput, SummaryInput } from "./types.js";

export interface SessionSignals {
  /** Le site officiel répond dans l’onglet et le périmètre (magasin, drive) attendu est visible. */
  ready: boolean;
  /** Un compte client est visiblement connecté. */
  accountConnected: boolean;
  /** Une vérification anti-robot ou un blocage est affiché. */
  robotVisible: boolean;
}

export interface MutationInput {
  productId: string;
  productUrl: string | null;
  targetQuantity: number;
}

/**
 * Contrat propre à chaque enseigne. Les expressions s’exécutent dans la page officielle de la
 * session Camoufox de l’utilisateur ; les fonctions normalize* tournent en Node et sont testées
 * avec des charges utiles réellement observées et expurgées.
 */
export interface Adapter {
  entryUrl(config: ShopConfig): string;
  matchesTab(url: URL, config: ShopConfig): boolean;
  inspectSession(input: { snapshot: string; tabUrl: string; config: ShopConfig }): SessionSignals;
  validateScope?(scope: Record<string, string>): void;
  scopeLabel?(config: ShopConfig): string | null;
  validateProductUrl(url: URL, config: ShopConfig): void;
  searchExpression(config: ShopConfig, query: string, limit: number): string;
  normalizeSearch(raw: unknown, config: ShopConfig): SummaryInput[];
  productExpression(config: ShopConfig, productUrl: string): string;
  normalizeProduct(raw: unknown, config: ShopConfig, productUrl: string): ProductInput;
  cartExpression(config: ShopConfig): string;
  normalizeCart(raw: unknown, config: ShopConfig): CartInput;
  mutationExpression(config: ShopConfig, input: MutationInput): string;
}

export const ROBOT_PATTERN = /je ne suis pas un robot|confirmer que vous n.êtes pas un robot|verify you are human|just a moment|checking your browser|vérification de sécurité|accès (?:temporairement )?restreint|access (?:is )?(?:temporarily )?restricted|attention required|pardon our interruption/i;

export function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    amp: "&", quot: '"', apos: "'", nbsp: " ", lt: "<", gt: ">", euro: "€", rsquo: "’", lsquo: "‘",
    eacute: "é", egrave: "è", ecirc: "ê", agrave: "à", acirc: "â", ccedil: "ç", ocirc: "ô", ugrave: "ù", ucirc: "û", icirc: "î", iuml: "ï", euml: "ë", oelig: "œ",
  };
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
}

export function stripTags(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Convertit « 1 234,56 € », « 2.49 » ou 2.49 en nombre ; renvoie null si le texte n’est pas un prix. */
export function parsePrice(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u00a0\u202f\s]/g, "").replace(/[^0-9.,-]/g, "");
  if (!cleaned) return null;
  const comma = cleaned.lastIndexOf(",");
  const dot = cleaned.lastIndexOf(".");
  const normalized = comma > dot ? cleaned.replace(/\./g, "").replace(",", ".") : cleaned.replace(/,/g, "");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

export function formatEuro(value: number): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value);
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function str(raw: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) return decodeHtml(value.trim());
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

export function isOrganic(text: string): boolean {
  return /\bbio\b|agriculture biologique|\bab\b ?bio|eurofeuille/i.test(text);
}

export function hasVeganClaim(text: string): boolean {
  return /\bvegan\b|\bv[ée]gane?\b|100 ?% v[ée]g[ée]tal/i.test(text);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
