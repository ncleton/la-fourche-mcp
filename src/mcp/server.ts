#!/usr/bin/env node
import "dotenv/config";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ConfirmationStore, MutationCoordinator } from "../client/confirmations.js";
import { ShopError } from "../client/errors.js";
import { startLoginServer, type LoginFlow } from "../client/onboarding.js";
import { RETAILER } from "../client/retailer.js";
import { ShopClient } from "../client/shop.js";
import type { Cart, SessionStatus } from "../client/types.js";

function success(value: object) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function failure(cause: unknown) {
  const known = cause instanceof ShopError
    ? cause
    : new ShopError("Erreur interne du connecteur.", "internal_error", "Consultez les diagnostics locaux puis réessayez.");
  const value = { error: { code: known.code, message: known.message, remediation: known.remediation, ...known.details } };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true };

export function createServer(client = new ShopClient()): McpServer {
  const server = new McpServer({ name: `${RETAILER.id}-mcp`, version: RETAILER.version }, {
    instructions: `Appelez connect_${RETAILER.slug} avant la première opération. Le compte ${RETAILER.label} ${RETAILER.accountRequired ? "est indispensable" : "est facultatif pour remplir un panier mais nécessaire pour commander"} : si une connexion est proposée, présentez le wizard loopback et ses deux parcours (connexion à un compte existant ou création officielle de compte). Les identifiants, cookies, codes 2FA et CAPTCHA ne transitent jamais dans le MCP. Modes de réception du site : ${RETAILER.fulfillment.join(", ")}. Toute mutation de panier exige une prévisualisation, puis le même outil avec son jeton de confirmation. Aucun outil ne choisit de créneau, ne valide de commande et ne paie.`,
  });
  const confirmations = new ConfirmationStore();
  const mutations = new MutationCoordinator();
  let loginFlow: LoginFlow | undefined;

  server.registerPrompt(`onboard_${RETAILER.slug}`, {
    title: `Connecter ou créer un compte ${RETAILER.label}`,
    description: `Démarre le wizard local ${RETAILER.label} avant toute action de compte ou de panier.`,
  }, async () => ({ messages: [{ role: "user", content: { type: "text", text: `Utilise connect_${RETAILER.slug} et présente le wizard local avec ses deux parcours : connexion à un compte existant ou création officielle de compte. Ne demande aucun identifiant dans cette conversation.` } }] }));

  async function offerWizard(status: SessionStatus) {
    loginFlow ??= await startLoginServer(client);
    return {
      login_url: loginFlow.url,
      links: { sign_in: `${loginFlow.url}/connect`, create_account: `${loginFlow.url}/create-account` },
      user_action: status.manual_action ?? `Ouvrez ce wizard local. Il ouvre le site officiel ${RETAILER.label} pour la connexion ou la création de compte, puis appelez connect_${RETAILER.slug} à nouveau.`,
    };
  }

  server.registerTool(`connect_${RETAILER.slug}`, {
    title: `Ouvrir ou vérifier la connexion ${RETAILER.label}`,
    description: `Ouvre de façon idempotente ${RETAILER.label} dans le profil Camoufox isolé et indique si une connexion humaine est requise ou possible.`,
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: true },
  }, async () => {
    try {
      const status = await client.connect();
      if (status.connected && (status.account_connected || !RETAILER.accountRequired)) {
        if (status.account_connected) {
          if (loginFlow) await loginFlow.close();
          loginFlow = undefined;
          return success({ status: "connected", ...status });
        }
        return success({ status: "connected", ...status, optional_account: await offerWizard(status) });
      }
      return success({ status: "connection_required", ...status, ...(await offerWizard(status)) });
    } catch (cause) { return failure(cause); }
  });

  server.registerTool("session_status", {
    title: `Vérifier la session ${RETAILER.label}`,
    description: `Vérifie Camoufox, le site officiel ${RETAILER.label}, son périmètre et l’état connecté visible sans retourner de donnée de compte ou de session. Indique les modes de réception : ${RETAILER.fulfillment.join(", ")}.`,
    inputSchema: {},
    annotations: readOnly,
  }, async () => {
    try { return success(await client.sessionStatus()); }
    catch (cause) { return failure(cause); }
  });

  server.registerTool("search_products", {
    title: `Rechercher chez ${RETAILER.label}`,
    description: `Recherche le catalogue actuel de ${RETAILER.label} et retourne des fiches avec prix et disponibilité observés.`,
    inputSchema: {
      query: z.string().trim().min(2).max(160),
      limit: z.number().int().min(1).max(20).default(10),
    },
    annotations: readOnly,
  }, async ({ query, limit }) => {
    try { return success(await client.search(query, limit)); }
    catch (cause) { return failure(cause); }
  });

  server.registerTool("get_product", {
    title: `Lire une fiche produit ${RETAILER.label}`,
    description: `Lit la fiche actuelle correspondant exactement à product_url retourné par search_products.`,
    inputSchema: { product_url: z.string().url().max(2_000) },
    annotations: readOnly,
  }, async ({ product_url }) => {
    try { return success(await client.product(product_url)); }
    catch (cause) { return failure(cause); }
  });

  server.registerTool("get_cart", {
    title: `Lire le panier ${RETAILER.label}`,
    description: `Lit le panier actuel sans retourner d’adresse, d’identité, de créneau ou de paiement.`,
    inputSchema: {},
    annotations: readOnly,
  }, async () => {
    try { return success(await client.cart()); }
    catch (cause) { return failure(cause); }
  });

  registerCartMutation(server, "add_to_cart", "add", client, confirmations, mutations);
  registerCartMutation(server, "remove_from_cart", "remove", client, confirmations, mutations);

  server.server.onclose = () => {
    if (loginFlow) void loginFlow.close().catch(() => undefined);
  };

  return server;
}

function cartQuantity(cart: Cart, productId: string): number {
  return cart.items.find((item) => item.product_id === productId)?.quantity ?? 0;
}

function registerCartMutation(
  server: McpServer,
  name: "add_to_cart" | "remove_from_cart",
  operation: "add" | "remove",
  client: ShopClient,
  confirmations: ConfirmationStore,
  mutations: MutationCoordinator,
): void {
  server.registerTool(name, {
    title: operation === "add" ? `Ajouter au panier ${RETAILER.label}` : `Retirer du panier ${RETAILER.label}`,
    description: operation === "add"
      ? "Prévisualise, confirme et ajoute une quantité d’une fiche fraîche issue de search_products."
      : "Prévisualise, confirme et retire une quantité d’un produit déjà présent dans get_cart.",
    inputSchema: operation === "add" ? {
      product_url: z.string().url().max(2_000),
      quantity: z.number().int().min(1).max(50).default(1),
      confirmation_token: z.string().uuid().optional(),
    } : {
      product_id: z.string().min(1).max(200),
      quantity: z.number().int().min(1).max(50).default(1),
      confirmation_token: z.string().uuid().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
  }, async (input: Record<string, unknown>) => {
    try {
      const quantity = Number(input.quantity ?? 1);
      const productUrl = operation === "add" ? String(input.product_url) : null;
      const product = operation === "add" ? await client.product(productUrl!) : null;
      const productId = product ? product.product_id : String(input.product_id);
      const token = typeof input.confirmation_token === "string" ? input.confirmation_token : undefined;
      if (!token) {
        const cart = await client.cart();
        const currentQuantity = cartQuantity(cart, productId);
        if (operation === "remove" && currentQuantity < quantity) {
          throw new ShopError("La quantité à retirer dépasse le contenu actuel du panier.", "invalid_quantity", "Relisez get_cart et choisissez une quantité inférieure ou égale.");
        }
        if (product && product.availability !== "available") {
          throw new ShopError("Le produit n’est plus disponible.", "product_unavailable", "Relancez search_products et choisissez une fiche disponible.");
        }
        const resultingQuantity = currentQuantity + (operation === "add" ? quantity : -quantity);
        if (product && product.available_quantity !== null && resultingQuantity > product.available_quantity) {
          throw new ShopError("La quantité demandée dépasse le stock actuellement exposé.", "invalid_quantity", `Utilisez au maximum ${Math.max(0, product.available_quantity - currentQuantity)} unité(s) supplémentaire(s).`);
        }
        return success({
          status: "confirmation_required",
          operation,
          product_id: productId,
          product_url: productUrl,
          product_name: product?.name ?? null,
          quantity,
          current_quantity: currentQuantity,
          resulting_quantity: resultingQuantity,
          confirmation_token: confirmations.create(operation, productId, quantity, productUrl, cart),
          expires_in_seconds: 300,
        });
      }
      return await mutations.run(async () => {
        const current = await client.cart();
        confirmations.consume(token, operation, productId, quantity, productUrl, current);
        const currentQuantity = cartQuantity(current, productId);
        if (product && (product.availability !== "available" || (product.available_quantity !== null && currentQuantity + quantity > product.available_quantity))) {
          throw new ShopError("Le produit ou son stock a changé depuis la prévisualisation.", "product_conflict", "Relancez search_products et demandez une nouvelle prévisualisation.");
        }
        const target = currentQuantity + (operation === "add" ? quantity : -quantity);
        if (target < 0) throw new ShopError("Le panier a changé avant le retrait.", "cart_conflict", "Relisez le panier et demandez une nouvelle prévisualisation.");
        const cart = await client.setCartProductQuantity(productId, target, productUrl);
        return success({ status: "applied", operation, product_id: productId, quantity, cart });
      });
    } catch (cause) { return failure(cause); }
  });
}

async function main(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); }
  catch { return false; }
}

if (isMainModule()) {
  main().catch((cause: unknown) => {
    process.stderr.write(`${RETAILER.id}-mcp: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  });
}
