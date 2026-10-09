import assert from "node:assert/strict";
import test from "node:test";
import { RETAILER } from "../client/retailer.js";
import { ShopClient } from "../client/shop.js";
import { createShop, expected, productUrl, robotSnapshot } from "./fixtures.js";

test("confirme une session prête sur le site officiel", async () => {
  const { browser, config } = createShop();
  const status = await new ShopClient(config, undefined, browser).sessionStatus();
  assert.equal(status.ready, true);
  assert.equal(status.retailer.id, RETAILER.id);
  assert.deepEqual(status.fulfillment, [...RETAILER.fulfillment]);
  assert.equal("account_label" in status, false);
});

test("demande une action humaine devant une vérification anti-robot", async () => {
  const { browser, config } = createShop();
  browser.snapshotValue = robotSnapshot;
  const status = await new ShopClient(config, undefined, browser).sessionStatus();
  assert.equal(status.connected, false);
  assert.equal(status.manual_action_required, true);
  assert.match(status.manual_action ?? "", /contourn|vérification/i);
});

test("normalise une recherche réelle", async () => {
  const { browser, config } = createShop();
  const result = await new ShopClient(config, undefined, browser).search(expected.query, 5);
  assert.ok(result.products.length >= 1);
  const product = result.products.find((candidate) => candidate.product_id === expected.productId);
  assert.ok(product, "Le produit de référence doit figurer dans la recherche.");
  assert.equal(product.name, expected.name);
  assert.equal(product.price, expected.price);
  assert.equal(product.availability, "available");
  assert.equal(product.product_url, productUrl);
});

test("lit une fiche uniquement sur le site officiel", async () => {
  const { browser, config } = createShop();
  const client = new ShopClient(config, undefined, browser);
  const product = await client.product(productUrl);
  assert.equal(product.product_id, expected.productId);
  assert.equal(typeof product.vegan_claim, "boolean");
  await assert.rejects(() => client.product("https://example.com/produit"), /n’appartient pas|invalide/);
  await assert.rejects(() => client.product("http://" + new URL(productUrl).host + "/produit"), /HTTPS/);
});

test("modifie le panier et réconcilie la quantité réelle", async () => {
  const { browser, config, cartQuantity } = createShop();
  const client = new ShopClient(config, undefined, browser);
  assert.equal((await client.cart()).empty, true);
  const added = await client.setCartProductQuantity(expected.productId, 2, productUrl);
  assert.equal(added.items.find((item) => item.product_id === expected.productId)?.quantity, 2);
  assert.equal(cartQuantity(), 2);
  const removed = await client.setCartProductQuantity(expected.productId, 0, null);
  assert.equal(removed.empty, true);
});

test("refuse une quantité hors bornes", async () => {
  const { browser, config } = createShop();
  await assert.rejects(() => new ShopClient(config, undefined, browser).setCartProductQuantity(expected.productId, 51, productUrl), /quantité cible/);
});
