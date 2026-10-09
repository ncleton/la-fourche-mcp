import type { BrowserAdapter, BrowserTab } from "../client/camoufox.js";
import type { ShopConfig } from "../client/config.js";
import { RETAILER } from "../client/retailer.js";

export interface FakeHandlers {
  search(): unknown;
  product(): unknown;
  cart(): unknown;
  mutate(productId: string, target: number): unknown;
}

/** Navigateur simulé : reconnaît l’opération grâce au marqueur /*op:...*\/ posé par le client. */
export class FakeBrowser implements BrowserAdapter {
  tabs: BrowserTab[];
  snapshotValue: string;
  navigations: string[] = [];
  evaluations: string[] = [];

  constructor(readonly entryUrl: string, snapshot: string, private readonly handlers: FakeHandlers) {
    this.tabs = [{ tabId: "tab-1", url: entryUrl }];
    this.snapshotValue = snapshot;
  }

  async health() { return { version: "2.4.6" }; }
  async listTabs() { return this.tabs; }
  async open(url: string) { const tab = { tabId: "tab-opened", url }; this.tabs.push(tab); return tab; }
  async navigate(tabId: string, url: string) { this.navigations.push(url); return { tabId, url }; }
  async snapshot() { return this.snapshotValue; }
  async evaluate<T>(_tabId: string, expression: string): Promise<T> {
    const marker = expression.match(/^\/\*op:(\w+)(?: ([^*]*))?\*\//);
    if (!marker) throw new Error("Expression sans marqueur d’opération.");
    this.evaluations.push(marker[1]);
    if (marker[1] === "search") return this.handlers.search() as T;
    if (marker[1] === "product") return this.handlers.product() as T;
    if (marker[1] === "cart") return this.handlers.cart() as T;
    if (marker[1] === "mutate") {
      const meta = new URLSearchParams((marker[2] ?? "").replace(/ /g, "&"));
      return this.handlers.mutate(decodeURIComponent(meta.get("product") ?? ""), Number(meta.get("target"))) as T;
    }
    throw new Error("Opération inconnue.");
  }
}

export interface Captured {
  query: string;
  productUrl: string;
  expected: { productId: string; name: string; price: number };
  searchRaw: unknown[];
  productRaw: unknown;
  cartEmpty: unknown;
  cartFilled: { quantity: number; raw: unknown };
}

/** Boutique simulée à partir des charges utiles réellement capturées ; cartFor fabrique le panier brut pour une quantité donnée. */
export function buildShop(data: Captured, scope: Record<string, string>, cartFor: (count: number) => unknown) {
  const config: ShopConfig = {
    scope,
    camoufoxUrl: "http://127.0.0.1:9377",
    camoufoxUserId: "test-profile-user",
    camoufoxApiKey: "0123456789abcdefghijklmnopqrstuvwxyzAB",
  };
  let quantity = 0;
  const snapshot = `navigation "Menu"\nlink "Mon compte"\nlink "Panier"\ntext "${RETAILER.label}"\n${Object.values(scope).join("\n")}`;
  const browser = new FakeBrowser(RETAILER.entryUrl, snapshot, {
    search: () => data.searchRaw,
    product: () => data.productRaw,
    cart: () => cartFor(quantity),
    mutate: (_productId, target) => { const before = cartFor(quantity); quantity = target; return { before, after: cartFor(quantity), applied: true }; },
  });
  return {
    config,
    browser,
    cartQuantity: () => quantity,
    setCartQuantity: (value: number) => { quantity = value; },
  };
}
