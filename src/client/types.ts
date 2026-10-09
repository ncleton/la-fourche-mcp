import { z } from "zod";

export const availabilitySchema = z.enum(["available", "out_of_stock", "unknown"]);

export const productSummarySchema = z.object({
  product_id: z.string().min(1),
  name: z.string().min(1),
  brand: z.string().nullable(),
  price: z.number().nonnegative(),
  unit_price: z.string().nullable(),
  availability: availabilitySchema,
  available_quantity: z.number().int().nonnegative().nullable(),
  organic: z.boolean(),
  product_url: z.string().url(),
  scope: z.string().nullable(),
  checked_at: z.string().datetime(),
});

export const nutritionRowSchema = z.object({ label: z.string(), value: z.string(), unit: z.string().nullable() });

export const productSchema = productSummarySchema.extend({
  ean: z.string().nullable(),
  ingredients: z.string().nullable(),
  vegan_claim: z.boolean(),
  nutrition: z.array(nutritionRowSchema),
});

export const cartItemSchema = z.object({
  product_id: z.string().min(1),
  name: z.string().nullable(),
  quantity: z.number().int().nonnegative(),
  available_quantity: z.number().int().nonnegative().nullable(),
  unit_price: z.number().nonnegative().nullable(),
  line_total: z.number().nonnegative().nullable(),
});

export const cartSchema = z.object({
  scope: z.string().nullable(),
  empty: z.boolean(),
  total_quantity: z.number().int().nonnegative(),
  total_price: z.string(),
  currency: z.literal("EUR"),
  items: z.array(cartItemSchema),
  checked_at: z.string().datetime(),
});

export const searchSchema = z.object({
  query: z.string().min(2),
  scope: z.string().nullable(),
  checked_at: z.string().datetime(),
  products: z.array(productSummarySchema),
});

export const sessionSchema = z.object({
  connected: z.boolean(),
  ready: z.boolean(),
  account_connected: z.boolean(),
  account_required: z.boolean(),
  retailer: z.object({ id: z.string(), label: z.string(), origin: z.string().url() }),
  fulfillment: z.array(z.enum(["delivery", "click_and_collect"])),
  scope: z.record(z.string(), z.string()).nullable(),
  camoufox: z.object({ ready: z.boolean(), version: z.string() }),
  manual_action_required: z.boolean(),
  manual_action: z.string().nullable(),
});

export type ProductSummary = z.infer<typeof productSummarySchema>;
export type Product = z.infer<typeof productSchema>;
export type Cart = z.infer<typeof cartSchema>;
export type CartItem = z.infer<typeof cartItemSchema>;
export type SearchResult = z.infer<typeof searchSchema>;
export type SessionStatus = z.infer<typeof sessionSchema>;

/** Ce que l’adaptateur du site renvoie ; le client ajoute l’heure de contrôle et le périmètre. */
export type SummaryInput = Omit<ProductSummary, "checked_at" | "scope">;
export type ProductInput = Omit<Product, "checked_at" | "scope">;
export type CartInput = Omit<Cart, "checked_at" | "scope" | "currency">;
