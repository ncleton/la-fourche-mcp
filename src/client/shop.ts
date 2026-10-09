import { BrowserAdapter, CamoufoxClient } from "./camoufox.js";
import type { Adapter, SessionSignals } from "./adapter.js";
import { loadConfig, type ShopConfig } from "./config.js";
import { ContractChangedError, ShopError } from "./errors.js";
import { RETAILER } from "./retailer.js";
import { adapter as siteAdapter } from "./site.js";
import {
  cartSchema, productSchema, searchSchema, sessionSchema,
  type Cart, type CartInput, type Product, type SearchResult, type SessionStatus,
} from "./types.js";

export type ConnectTarget = "sign_in" | "create_account";

function mark(operation: string, expression: string, meta = ""): string {
  return `/*op:${operation}${meta ? " " + meta : ""}*/${expression}`;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export class ShopClient {
  readonly browser: BrowserAdapter;

  constructor(readonly config: ShopConfig = loadConfig(), readonly adapter: Adapter = siteAdapter, browser?: BrowserAdapter) {
    adapter.validateScope?.(config.scope);
    this.browser = browser ?? new CamoufoxClient(config);
  }

  private scopeLabel(): string | null {
    return this.adapter.scopeLabel?.(this.config) ?? null;
  }

  private async shopTab(openIfMissing: boolean): Promise<{ tabId: string; url: string }> {
    await this.browser.health();
    const tab = (await this.browser.listTabs()).find((candidate) => {
      try { return this.adapter.matchesTab(new URL(candidate.url), this.config); }
      catch { return false; }
    });
    if (tab) return tab;
    if (openIfMissing) return this.browser.open(this.adapter.entryUrl(this.config));
    throw new ShopError(
      `L’onglet ${RETAILER.label} n’est pas ouvert dans Camoufox.`,
      "store_tab_missing",
      `Appelez connect_${RETAILER.slug}, puis terminez si nécessaire la connexion humaine dans la fenêtre Camoufox.`,
    );
  }

  async connect(target?: ConnectTarget): Promise<SessionStatus> {
    const tab = await this.shopTab(true);
    if (target) {
      const url = target === "sign_in" ? RETAILER.loginUrl : RETAILER.signupUrl;
      await this.browser.navigate(tab.tabId, url);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    return this.sessionStatus();
  }

  private async inspect(tab: { tabId: string; url: string }): Promise<SessionSignals> {
    const snapshot = await this.browser.snapshot(tab.tabId);
    return this.adapter.inspectSession({ snapshot, tabUrl: tab.url, config: this.config });
  }

  async sessionStatus(options: { recover?: boolean } = {}): Promise<SessionStatus> {
    const health = await this.browser.health();
    let tab = await this.shopTab(false);
    let signals = await this.inspect(tab);
    if (options.recover && !signals.ready && !signals.robotVisible) {
      const entry = this.adapter.entryUrl(this.config);
      if (tab.url !== entry) {
        tab = await this.browser.navigate(tab.tabId, entry);
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        signals = await this.inspect(tab);
      }
    }
    const usable = signals.ready && !signals.robotVisible;
    const connected = usable && (!RETAILER.accountRequired || signals.accountConnected);
    let manualAction: string | null = null;
    if (signals.robotVisible) {
      manualAction = "Arrêtez les requêtes automatiques. Attendez la levée de la restriction puis validez manuellement la vérification officielle dans Camoufox ; ne tentez aucun contournement.";
    } else if (!usable) {
      manualAction = RETAILER.scopeFields.length
        ? `Dans la fenêtre Camoufox, ouvrez ${RETAILER.label} et sélectionnez exactement le magasin ou le drive configuré (${this.scopeLabel() ?? "voir .env"}).`
        : `Ouvrez ${RETAILER.label} dans la fenêtre Camoufox et terminez toute vérification manuelle demandée.`;
    } else if (RETAILER.accountRequired && !signals.accountConnected) {
      manualAction = `Terminez manuellement la connexion ${RETAILER.label} dans la fenêtre Camoufox, sans transmettre votre mot de passe ou votre code au MCP.`;
    }
    return sessionSchema.parse({
      connected,
      ready: usable,
      account_connected: signals.accountConnected,
      account_required: RETAILER.accountRequired,
      retailer: { id: RETAILER.id, label: RETAILER.label, origin: RETAILER.origin },
      fulfillment: RETAILER.fulfillment,
      scope: RETAILER.scopeFields.length ? this.config.scope : null,
      camoufox: { ready: true, version: health.version },
      manual_action_required: !connected,
      manual_action: manualAction,
    });
  }

  private async requireReadyTab(): Promise<{ tabId: string; url: string }> {
    const status = await this.sessionStatus({ recover: true });
    if (!status.connected) {
      throw new ShopError(`La session ${RETAILER.label} n’est pas prête.`, "authentication_required", status.manual_action ?? "Connectez-vous dans Camoufox.");
    }
    return this.shopTab(false);
  }

  private async run<T>(tab: { tabId: string }, operation: string, expression: string, meta: string, code: string, failure: string): Promise<T> {
    try { return await this.browser.evaluate<T>(tab.tabId, mark(operation, expression, meta)); }
    catch (cause) {
      if (cause instanceof ShopError) throw cause;
      throw new ShopError(`${failure} : ${describe(cause)}.`, code, `Vérifiez la page ${RETAILER.label} dans Camoufox puis réessayez.`);
    }
  }

  async search(query: string, limit = 10): Promise<SearchResult> {
    const normalized = query.trim();
    if (normalized.length < 2 || normalized.length > 160) throw new ShopError("La recherche doit contenir entre 2 et 160 caractères.", "invalid_input", "Saisissez un terme de recherche plus précis.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new ShopError("La limite doit être comprise entre 1 et 20.", "invalid_input", "Utilisez une limite entière entre 1 et 20.");
    const tab = await this.requireReadyTab();
    const checkedAt = new Date().toISOString();
    const raw = await this.run<unknown>(tab, "search", this.adapter.searchExpression(this.config, normalized, limit), "", "upstream_error", `La recherche ${RETAILER.label} a échoué`);
    const products = this.adapter.normalizeSearch(raw, this.config).slice(0, limit).map((item) => {
      try { this.adapter.validateProductUrl(new URL(item.product_url), this.config); }
      catch { throw new ContractChangedError(`Une fiche produit ${RETAILER.label} pointe hors du site officiel configuré.`); }
      return { ...item, scope: this.scopeLabel(), checked_at: checkedAt };
    });
    return searchSchema.parse({ query: normalized, scope: this.scopeLabel(), checked_at: checkedAt, products });
  }

  async product(productUrl: string): Promise<Product> {
    let url: URL;
    try { url = new URL(productUrl); }
    catch { throw new ShopError("L’URL produit est invalide.", "invalid_input", "Utilisez exactement product_url retourné par search_products."); }
    if (url.protocol !== "https:") throw new ShopError("L’URL produit doit être HTTPS.", "invalid_input", "Utilisez exactement product_url retourné par search_products.");
    try { this.adapter.validateProductUrl(url, this.config); }
    catch (cause) {
      if (cause instanceof ShopError) throw cause;
      throw new ShopError(`La fiche produit n’appartient pas à ${RETAILER.label}.`, "invalid_input", "Utilisez exactement product_url retourné par search_products.");
    }
    const tab = await this.requireReadyTab();
    const raw = await this.run<unknown>(tab, "product", this.adapter.productExpression(this.config, url.toString()), "", "upstream_error", `La fiche ${RETAILER.label} a échoué`);
    const detail = this.adapter.normalizeProduct(raw, this.config, url.toString());
    return productSchema.parse({ ...detail, scope: this.scopeLabel(), checked_at: new Date().toISOString() });
  }

  private cartFrom(raw: unknown): Cart {
    const input = this.adapter.normalizeCart(raw, this.config) as CartInput;
    const parsed = cartSchema.safeParse({ ...input, scope: this.scopeLabel(), currency: "EUR", checked_at: new Date().toISOString() });
    if (!parsed.success) throw new ContractChangedError(`Le panier ${RETAILER.label} ne correspond plus au contrat observé.`);
    return parsed.data;
  }

  async cart(): Promise<Cart> {
    const tab = await this.requireReadyTab();
    const raw = await this.run<unknown>(tab, "cart", this.adapter.cartExpression(this.config), "", "cart_read_failed", `La lecture du panier ${RETAILER.label} a échoué`);
    return this.cartFrom(raw);
  }

  async setCartProductQuantity(productId: string, targetQuantity: number, productUrl: string | null = null): Promise<Cart> {
    if (!productId || productId.length > 200) throw new ShopError("L’identifiant produit est invalide.", "invalid_input", "Utilisez une référence retournée par search_products ou get_cart.");
    if (!Number.isInteger(targetQuantity) || targetQuantity < 0 || targetQuantity > 50) throw new ShopError("La quantité cible doit être comprise entre 0 et 50.", "invalid_input", "Utilisez une quantité entière entre 0 et 50.");
    const tab = await this.requireReadyTab();
    let result: unknown;
    try {
      result = await this.browser.evaluate<unknown>(tab.tabId, mark("mutate", this.adapter.mutationExpression(this.config, { productId, productUrl, targetQuantity }), `product=${encodeURIComponent(productId).replace(/\*/g, "%2A")} target=${targetQuantity}`));
    } catch (cause) {
      const reconciled = await this.cart().catch(() => null);
      const actual = reconciled?.items.find((item) => item.product_id === productId)?.quantity ?? 0;
      if (reconciled && actual === targetQuantity) return reconciled;
      if (cause instanceof ShopError) throw cause;
      throw new ShopError(`La modification du panier ${RETAILER.label} a échoué : ${describe(cause)}.`, "cart_update_failed", "Relisez le panier réel. Ne relancez pas automatiquement si son état reste ambigu.");
    }
    if (!result || typeof result !== "object" || !("after" in result)) throw new ContractChangedError("La réponse de mutation du panier n’est plus reconnue.");
    const after = this.cartFrom((result as { after: unknown }).after);
    const actual = after.items.find((item) => item.product_id === productId)?.quantity ?? 0;
    if (actual !== targetQuantity) {
      throw new ShopError(
        `Le panier contient ${actual} unité(s) du produit ${productId}, au lieu de ${targetQuantity}.`,
        "cart_reconciliation_failed",
        "Relisez le panier et demandez une nouvelle prévisualisation avant toute autre mutation.",
      );
    }
    return after;
  }
}
