import { createHash, randomUUID } from "node:crypto";
import { ShopError } from "./errors.js";
import type { Cart } from "./types.js";

type Operation = "add" | "remove";

interface Confirmation {
  operation: Operation;
  productId: string;
  quantity: number;
  productUrl: string | null;
  fingerprint: string;
  expiresAt: number;
}

export class ConfirmationStore {
  readonly #values = new Map<string, Confirmation>();

  create(operation: Operation, productId: string, quantity: number, productUrl: string | null, cart: Cart): string {
    this.#prune();
    const token = randomUUID();
    this.#values.set(token, {
      operation,
      productId,
      quantity,
      productUrl,
      fingerprint: cartFingerprint(cart),
      expiresAt: Date.now() + 5 * 60_000,
    });
    return token;
  }

  consume(token: string, operation: Operation, productId: string, quantity: number, productUrl: string | null, cart: Cart): void {
    this.#prune();
    const value = this.#values.get(token);
    this.#values.delete(token);
    if (!value) throw new ShopError("Le jeton de confirmation est absent, expiré ou déjà utilisé.", "confirmation_invalid", "Demandez une nouvelle prévisualisation.");
    if (value.operation !== operation || value.productId !== productId || value.quantity !== quantity || value.productUrl !== productUrl) {
      throw new ShopError("Le jeton ne correspond pas à cette mutation.", "confirmation_mismatch", "Demandez une nouvelle prévisualisation avec les mêmes paramètres.");
    }
    if (value.fingerprint !== cartFingerprint(cart)) {
      throw new ShopError("Le panier a changé depuis la prévisualisation.", "cart_conflict", "Relisez le panier et demandez une nouvelle prévisualisation.");
    }
  }

  #prune(): void {
    const now = Date.now();
    for (const [token, value] of this.#values) if (value.expiresAt <= now) this.#values.delete(token);
  }
}

export function cartFingerprint(cart: Cart): string {
  const state = [...cart.items]
    .map((item) => ({ product_id: item.product_id, quantity: item.quantity }))
    .sort((left, right) => left.product_id.localeCompare(right.product_id));
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

export class MutationCoordinator {
  #tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const preceding = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await preceding;
    try { return await operation(); }
    finally { release(); }
  }
}
