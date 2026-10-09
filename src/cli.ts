#!/usr/bin/env node
import "dotenv/config";
import { ShopError } from "./client/errors.js";
import { startLoginServer } from "./client/onboarding.js";
import { RETAILER } from "./client/retailer.js";
import { ShopClient } from "./client/shop.js";

function usage(): never {
  process.stderr.write(`Usage:\n  ${RETAILER.id} connect|doctor|status|cart\n  ${RETAILER.id} search <query> [--limit N]\n  ${RETAILER.id} product <product_url>\n  ${RETAILER.id} add <product_url> [--quantity N] [--confirm]\n  ${RETAILER.id} remove <product_id> [--quantity N] [--confirm]\n`);
  process.exit(2);
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command) usage();
  const client = new ShopClient();
  if (command === "connect") {
    const first = await client.connect();
    if (first.connected && (first.account_connected || !RETAILER.accountRequired)) return output({ status: "connected", ...first });
    const flow = await startLoginServer(client);
    process.stderr.write(`Ouvrez ce wizard local pour connecter ${RETAILER.label} :\n${flow.url}\n`);
    const deadline = Date.now() + 15 * 60_000;
    try {
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        try {
          const status = await client.sessionStatus();
          if (status.connected && status.account_connected) return output({ status: "connected", ...status });
        } catch { /* Attendre l’action humaine dans le wizard. */ }
      }
      throw new ShopError("Le wizard de connexion a expiré.", "connection_timeout", `Relancez ${RETAILER.id} connect et terminez la connexion dans les quinze minutes.`);
    } finally { await flow.close(); }
  }
  if (command === "doctor") {
    try {
      const status = await client.sessionStatus();
      return output({ status: status.connected ? "ok" : "connection_required", ...status });
    } catch (cause) {
      if (cause instanceof ShopError && cause.code === "store_tab_missing") return output({ status: "connection_required", reason: cause.message });
      throw cause;
    }
  }
  if (command === "status") return output(await client.sessionStatus());
  if (command === "search") {
    const value = args.shift();
    if (!value) usage();
    const limit = Number(option(args, "--limit") ?? "10");
    return output(await client.search(value, limit));
  }
  if (command === "product") {
    const value = args.shift();
    if (!value) usage();
    return output(await client.product(value));
  }
  if (command === "cart") return output(await client.cart());
  if (command === "add" || command === "remove") {
    const value = args.shift();
    if (!value) usage();
    const quantity = Number(option(args, "--quantity") ?? "1");
    const confirmed = flag(args, "--confirm");
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) throw new ShopError("La quantité doit être comprise entre 1 et 50.", "invalid_input", "Utilisez --quantity avec un entier entre 1 et 50.");
    const cart = await client.cart();
    const product = command === "add" ? await client.product(value) : null;
    const productId = product?.product_id ?? value;
    const current = cart.items.find((item) => item.product_id === productId)?.quantity ?? 0;
    const target = current + (command === "add" ? quantity : -quantity);
    if (target < 0) throw new ShopError("La quantité à retirer dépasse le panier actuel.", "invalid_quantity", "Relisez le panier et réduisez --quantity.");
    if (product && (product.availability !== "available" || (product.available_quantity !== null && target > product.available_quantity))) throw new ShopError("Le produit ou la quantité n’est plus disponible.", "product_unavailable", "Relancez search puis choisissez une quantité disponible.");
    if (!confirmed) return output({ status: "confirmation_required", operation: command, product_id: productId, product_name: product?.name ?? null, quantity, current_quantity: current, resulting_quantity: target, next: "Relancez exactement la même commande avec --confirm après avoir vérifié cette prévisualisation." });
    const applied = await client.setCartProductQuantity(productId, target, command === "add" ? value : null);
    return output({ status: "applied", operation: command, product_id: productId, quantity, cart: applied });
  }
  usage();
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value) throw new ShopError(`${name} exige une valeur.`, "invalid_input", `Consultez ${RETAILER.id} --help.`);
  args.splice(index, 2);
  return value;
}

function flag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

main().catch((cause: unknown) => {
  const error = cause instanceof ShopError
    ? { code: cause.code, message: cause.message, remediation: cause.remediation, ...cause.details }
    : { code: "internal_error", message: cause instanceof Error ? cause.message : String(cause) };
  process.stderr.write(`${JSON.stringify({ error }, null, 2)}\n`);
  process.exitCode = 1;
});
