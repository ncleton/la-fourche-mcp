import { randomBytes } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { RETAILER } from "./retailer.js";
import type { ShopClient } from "./shop.js";

export interface LoginFlow {
  url: string;
  close(): Promise<void>;
}

type State = "ready" | "connecting" | "connected" | "manual_action" | "error";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function secure(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
}

function send(response: ServerResponse, status: number, body: string, contentType = "text/html; charset=utf-8"): void {
  secure(response);
  response.writeHead(status, { "content-type": contentType });
  response.end(body);
}

function page(baseUrl: string, state: State, message: string): string {
  const title = state === "connected" ? "Connexion terminée" : state === "error" ? "Connexion à relancer" : `Connecter ${RETAILER.label}`;
  const optional = RETAILER.accountRequired ? "" : " Le compte est facultatif pour remplir un panier ; il sert à retrouver vos adresses, créneaux et paiements au moment de commander.";
  return `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>body{font:16px system-ui;background:#f3f6fa;color:#17202b;margin:0}main{max-width:40rem;margin:10vh auto;background:#fff;padding:2rem;border-radius:1rem;box-shadow:0 8px 32px #0001}h1{font-size:1.5rem}.actions{display:grid;gap:.75rem;margin:1.5rem 0}.action{display:block;text-align:center;padding:.85rem;border-radius:.5rem;text-decoration:none;font-weight:700;background:#1456a0;color:#fff}.secondary{background:#e5effa;color:#0e477f}.status{padding:.9rem;background:#eef4fa;border-radius:.5rem}.small{font-size:.9rem;color:#435466}</style><main><h1>${escapeHtml(title)}</h1><p>Choisissez un parcours. Saisissez mot de passe, code ou CAPTCHA uniquement dans la fenêtre officielle ${escapeHtml(RETAILER.label)} ouverte par le connecteur.${escapeHtml(optional)}</p><div class="actions"><a class="action" href="${baseUrl}/connect">J’ai un compte — me connecter</a><a class="action secondary" href="${baseUrl}/create-account">Créer un compte ${escapeHtml(RETAILER.label)}</a></div><p class="status" id="message">${escapeHtml(message)}</p><p class="small">Pour créer un compte, suivez le formulaire officiel dans la fenêtre ouverte. Cette page locale n’écoute que sur votre ordinateur et ne collecte aucun identifiant.</p></main><script>const refresh=async()=>{const value=await fetch('${baseUrl}/status',{cache:'no-store'}).then(r=>r.json());document.getElementById('message').textContent=value.message;if(!['connected','error'].includes(value.state))setTimeout(refresh,1500)};refresh()</script></html>`;
}

export async function startLoginServer(client: ShopClient): Promise<LoginFlow> {
  const token = randomBytes(32).toString("hex");
  let server: Server;
  let state: State = "ready";
  let message = "Choisissez la connexion ou la création de compte.";
  let opening: Promise<void> | null = null;
  const baseUrl = (): string => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Le wizard local n’a pas démarré.");
    return `http://127.0.0.1:${address.port}/${token}`;
  };
  const accountDone = (status: { connected: boolean; account_connected: boolean }): boolean => status.connected && status.account_connected;
  const openOfficialPage = (target: "sign_in" | "create_account"): void => {
    if (opening || state === "connected") return;
    state = "connecting";
    message = target === "create_account"
      ? `La fenêtre officielle ${RETAILER.label} est ouverte sur la création de compte. Terminez le formulaire et toute vérification manuelle dans cette fenêtre.`
      : `La fenêtre officielle ${RETAILER.label} est ouverte sur la connexion. Terminez la connexion ou la vérification manuelle dans cette fenêtre.`;
    opening = client.connect(target).then((status) => {
      if (accountDone(status)) {
        state = "connected";
        message = "Compte connecté. Vous pouvez revenir au client MCP.";
      } else {
        state = "manual_action";
        message = status.manual_action ?? "Terminez l’action manuelle dans la fenêtre officielle.";
      }
    }).catch(() => {
      state = "error";
      message = "La page officielle n’a pas pu être ouverte. Vérifiez Camoufox et relancez le parcours.";
    }).finally(() => { opening = null; });
  };
  server = createServer(async (request, response) => {
    const origin = baseUrl();
    const requestUrl = new URL(request.url ?? "/", origin);
    if (!requestUrl.pathname.startsWith(`/${token}`)) return send(response, 404, "Page introuvable", "text/plain; charset=utf-8");
    const suffix = requestUrl.pathname.slice(`/${token}`.length) || "/";
    if (request.method !== "GET") return send(response, 405, "Méthode refusée", "text/plain; charset=utf-8");
    if (suffix === "/status") {
      if (state === "manual_action" || state === "connecting") {
        try {
          const status = await client.sessionStatus();
          if (accountDone(status)) {
            state = "connected";
            message = "Compte connecté. Vous pouvez revenir au client MCP.";
          } else if (status.manual_action) message = status.manual_action;
        } catch { /* L’état courant reste explicite ; aucun secret ni détail brut n’est renvoyé. */ }
      }
      return send(response, 200, JSON.stringify({ state, message }), "application/json; charset=utf-8");
    }
    if (suffix === "/connect" || suffix === "/create-account") {
      openOfficialPage(suffix === "/create-account" ? "create_account" : "sign_in");
      secure(response);
      response.writeHead(302, { location: origin });
      response.end();
      return;
    }
    if (suffix !== "/") return send(response, 404, "Page introuvable", "text/plain; charset=utf-8");
    return send(response, 200, page(origin, state, message));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: baseUrl(),
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
