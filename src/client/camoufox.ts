import type { ShopConfig } from "./config.js";
import { ShopError } from "./errors.js";
import { RETAILER } from "./retailer.js";

export type BrowserTab = { tabId: string; url: string; title?: string };
export type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface BrowserAdapter {
  health(): Promise<{ version: string }>;
  listTabs(): Promise<BrowserTab[]>;
  open(url: string): Promise<BrowserTab>;
  navigate(tabId: string, url: string): Promise<BrowserTab>;
  snapshot(tabId: string): Promise<string>;
  evaluate<T>(tabId: string, expression: string): Promise<T>;
}

export class CamoufoxClient implements BrowserAdapter {
  private queue: Promise<void> = Promise.resolve();
  private lastEvaluationAt = 0;

  constructor(private readonly config: ShopConfig, private readonly fetcher: Fetcher = fetch) {}

  private async request(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<{ response: Response; body: Record<string, unknown> }> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.config.camoufoxUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          authorization: `Bearer ${this.config.camoufoxApiKey}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(init.headers ?? {}),
        },
      });
    } catch (cause) {
      throw new ShopError(
        `Camoufox est inaccessible : ${cause instanceof Error ? cause.message : String(cause)}.`,
        "camoufox_unavailable",
        `Démarrez Camoufox sur ${this.config.camoufoxUrl}, puis réessayez.`,
      );
    }
    const raw = await response.text();
    let body: Record<string, unknown> = {};
    try { body = raw ? JSON.parse(raw) as Record<string, unknown> : {}; }
    catch {
      throw new ShopError("Camoufox a retourné une réponse non JSON.", "camoufox_contract_changed", "Vérifiez la version de camofox-browser et ses journaux locaux.");
    }
    if (response.status === 429 || body.error === "Rate limit exceeded") {
      const retryAfterMs = typeof body.retryAfterMs === "number" ? body.retryAfterMs : null;
      throw new ShopError(
        "La limite de débit Camoufox est atteinte.",
        "rate_limited",
        retryAfterMs ? `Réessayez dans ${Math.ceil(retryAfterMs / 1000)} secondes.` : "Attendez une minute avant de réessayer.",
        { retry_after_ms: retryAfterMs },
      );
    }
    if (!response.ok) {
      throw new ShopError(
        `Camoufox a retourné HTTP ${response.status}.`,
        response.status === 403 ? "camoufox_forbidden" : "camoufox_error",
        response.status === 403 ? "Vérifiez CAMOFOX_API_KEY et CAMOFOX_AUTH_MODE." : "Consultez les journaux Camoufox puis réessayez.",
      );
    }
    return { response, body };
  }

  async health(): Promise<{ version: string }> {
    const { body } = await this.request("/health", {}, 5_000);
    if (body.ok !== true || body.running !== true || body.engine !== "camoufox") {
      throw new ShopError("Le moteur Camoufox n’est pas prêt.", "camoufox_not_ready", "Démarrez le moteur Camoufox et vérifiez son endpoint /health.");
    }
    return { version: String(body.version ?? "unknown") };
  }

  async listTabs(): Promise<BrowserTab[]> {
    const { body } = await this.request(`/tabs?userId=${encodeURIComponent(this.config.camoufoxUserId)}`);
    const tabs = Array.isArray(body.tabs) ? body.tabs : [];
    return tabs.flatMap((value): BrowserTab[] => {
      if (!value || typeof value !== "object") return [];
      const item = value as Record<string, unknown>;
      const tabId = String(item.tabId ?? item.targetId ?? "");
      const url = String(item.url ?? "");
      return tabId && url ? [{ tabId, url, title: typeof item.title === "string" ? item.title : undefined }] : [];
    });
  }

  async open(url: string): Promise<BrowserTab> {
    const { body } = await this.request("/tabs", {
      method: "POST",
      body: JSON.stringify({ userId: this.config.camoufoxUserId, sessionKey: RETAILER.id, listItemId: RETAILER.id, url }),
    }, 45_000);
    const tabId = String(body.tabId ?? body.targetId ?? "");
    if (!tabId) throw new ShopError("Camoufox n’a pas retourné l’identifiant de l’onglet.", "camoufox_contract_changed", "Vérifiez la version de camofox-browser.");
    return { tabId, url };
  }

  async navigate(tabId: string, url: string): Promise<BrowserTab> {
    const { body } = await this.request(`/tabs/${encodeURIComponent(tabId)}/navigate`, {
      method: "POST",
      body: JSON.stringify({ userId: this.config.camoufoxUserId, url }),
    }, 45_000);
    if (body.ok !== true) throw new ShopError("Camoufox n’a pas confirmé la navigation.", "camoufox_contract_changed", "Vérifiez l’onglet et la version de camofox-browser.");
    return { tabId, url: typeof body.url === "string" ? body.url : url };
  }

  async snapshot(tabId: string): Promise<string> {
    const { body } = await this.request(`/snapshot?targetId=${encodeURIComponent(tabId)}&userId=${encodeURIComponent(this.config.camoufoxUserId)}`, {}, 15_000);
    const snapshot = body.snapshot ?? body.tree;
    if (typeof snapshot !== "string") throw new ShopError("Camoufox n’a pas retourné le snapshot attendu.", "camoufox_contract_changed", "Vérifiez l’onglet et la version de camofox-browser.");
    return snapshot;
  }

  async evaluate<T>(tabId: string, expression: string): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const waitMs = Math.max(0, 3_200 - (Date.now() - this.lastEvaluationAt));
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      const { body } = await this.request(`/tabs/${encodeURIComponent(tabId)}/evaluate-extended`, {
        method: "POST",
        body: JSON.stringify({ userId: this.config.camoufoxUserId, expression, timeout: 45_000 }),
      }, 50_000);
      if (body.ok !== true) {
        throw new ShopError(String(body.error ?? "Évaluation Camoufox refusée."), "browser_evaluation_failed", `Vérifiez la page ${RETAILER.label} ouverte dans Camoufox.`);
      }
      this.lastEvaluationAt = Date.now();
      return body.result as T;
    } finally {
      if (this.lastEvaluationAt === 0) this.lastEvaluationAt = Date.now();
      release();
    }
  }
}
