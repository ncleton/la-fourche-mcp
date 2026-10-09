import { buildShop } from "./fake-browser.js";
import { captured } from "./data.js";

export const productUrl = captured.productUrl;
export const expected = { query: captured.query, ...captured.expected };
export const robotSnapshot = 'heading "Vérification de sécurité"\nlink "Mon compte"';

type RawCart = { total: string; items: Array<Record<string, unknown>> };

export function createShop() {
  const filled = captured.cartFilled.raw as RawCart;
  const line = filled.items[0];
  const quantity = Number(line.quantity);
  const unit = Number(String(line.line_total).replace(/[^0-9,]/g, "").replace(",", ".")) / quantity;
  const money = (value: number) => `${value.toFixed(2).replace(".", ",")} €`;
  return buildShop(captured, {}, (count) => {
    if (count === 0) return captured.cartEmpty;
    return { total: money(unit * count), items: [{ ...line, quantity: String(count), line_total: money(unit * count) }] };
  });
}
