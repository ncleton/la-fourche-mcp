import "dotenv/config";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { RETAILER } from "../client/retailer.js";

type Cart = { items: Array<{ product_id: string; quantity: number }>; empty: boolean; total_quantity: number; total_price: string };

const childEnv = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../mcp/server.js", import.meta.url))], env: childEnv });
const client = new Client({ name: `${RETAILER.id}-live-smoke`, version: "1.0.0" });

function structured<T>(response: Awaited<ReturnType<Client["callTool"]>>): T {
  if (response.isError || !response.structuredContent) throw new Error(`Outil MCP refusé : ${JSON.stringify(response.structuredContent ?? response.content)}`);
  return response.structuredContent as T;
}

function fingerprint(cart: Cart): string {
  return JSON.stringify([...cart.items].map((item) => ({ product_id: item.product_id, quantity: item.quantity })).sort((left, right) => left.product_id.localeCompare(right.product_id)));
}

function quantity(cart: Cart, productId: string): number {
  return cart.items.find((item) => item.product_id === productId)?.quantity ?? 0;
}

async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  return structured<T>(await client.callTool({ name, arguments: args }));
}

await client.connect(transport);
let baseline: Cart | null = null;
let productId = "";
let added = false;
let restored = false;
try {
  await call(`connect_${RETAILER.slug}`);
  const session = await call<{ connected: boolean }>("session_status");
  if (!session.connected) throw new Error(`La session ${RETAILER.label} n’est pas prête.`);
  let productUrl = String(process.env.SMOKE_PRODUCT_URL ?? "").trim();
  if (!productUrl) {
    const search = await call<{ products: Array<{ product_url: string; availability: string; price: number }> }>("search_products", { query: String(process.env.SMOKE_QUERY ?? "tofu"), limit: 10 });
    const candidate = search.products.find((product) => product.availability === "available" && product.price > 0);
    if (!candidate) throw new Error("Aucun produit disponible dans la recherche de contrôle.");
    productUrl = candidate.product_url;
  }
  baseline = await call<Cart>("get_cart");
  const baselineFingerprint = fingerprint(baseline);
  const preview = await call<{ product_id: string; confirmation_token: string }>("add_to_cart", { product_url: productUrl, quantity: 1 });
  productId = preview.product_id;
  const baselineQuantity = quantity(baseline, productId);
  const applied = await call<{ cart: Cart }>("add_to_cart", { product_url: productUrl, quantity: 1, confirmation_token: preview.confirmation_token });
  if (quantity(applied.cart, productId) !== baselineQuantity + 1) throw new Error("L’ajout réel ne correspond pas au delta attendu.");
  added = true;
  const removePreview = await call<{ confirmation_token: string }>("remove_from_cart", { product_id: productId, quantity: 1 });
  const removed = await call<{ cart: Cart }>("remove_from_cart", { product_id: productId, quantity: 1, confirmation_token: removePreview.confirmation_token });
  if (fingerprint(removed.cart) !== baselineFingerprint) throw new Error("Le panier final ne correspond pas exactement à l’état initial.");
  restored = true;
  process.stdout.write(`${JSON.stringify({ ok: true, retailer: RETAILER.id, product_id: productId, add_delta: 1, restored: true, final_total_quantity: removed.cart.total_quantity, final_total_price: removed.cart.total_price }, null, 2)}\n`);
} finally {
  if (baseline && productId && added && !restored) {
    const current = await call<Cart>("get_cart").catch(() => null);
    const expected = quantity(baseline, productId) + 1;
    if (current && quantity(current, productId) === expected) {
      const preview = await call<{ confirmation_token: string }>("remove_from_cart", { product_id: productId, quantity: 1 });
      await call("remove_from_cart", { product_id: productId, quantity: 1, confirmation_token: preview.confirmation_token });
    }
  }
  await client.close();
}
