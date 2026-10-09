import assert from "node:assert/strict";
import test from "node:test";
import { ConfirmationStore } from "../client/confirmations.js";
import type { Cart } from "../client/types.js";

function cart(quantity: number): Cart {
  return {
    scope: null,
    empty: quantity === 0,
    total_quantity: quantity,
    total_price: quantity === 0 ? "0,00 €" : "0,85 €",
    currency: "EUR",
    items: quantity ? [{ product_id: "5870", name: "Tofu", quantity, available_quantity: 11, unit_price: 0.85, line_total: 0.85 * quantity }] : [],
    checked_at: new Date().toISOString(),
  };
}

test("un jeton est à usage unique et lié à l’état du panier", () => {
  const confirmations = new ConfirmationStore();
  const token = confirmations.create("add", "5870", 1, "https://example.test/5870", cart(0));
  assert.throws(() => confirmations.consume(token, "add", "5870", 1, "https://example.test/5870", cart(1)), /changé/);
  assert.throws(() => confirmations.consume(token, "add", "5870", 1, "https://example.test/5870", cart(0)), /expiré|utilisé/);
});

test("un jeton refuse une autre opération", () => {
  const confirmations = new ConfirmationStore();
  const token = confirmations.create("remove", "5870", 1, null, cart(1));
  assert.throws(() => confirmations.consume(token, "add", "5870", 1, null, cart(1)), /correspond/);
});
