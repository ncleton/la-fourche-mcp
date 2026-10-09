// Fichier généré par generate.mjs à partir de retailers/la-fourche/spec.json. Ne pas modifier ici.
export interface ScopeField { key: string; env: string; description: string; example: string; pattern?: string }
export const RETAILER: {
  id: string; slug: string; version: string; label: string; origin: string; entryUrl: string; loginUrl: string; signupUrl: string;
  platform: string; fulfillment: ReadonlyArray<"delivery" | "click_and_collect">; accountRequired: boolean;
  scopeFields: ReadonlyArray<ScopeField>;
} = {
  "id": "la-fourche",
  "slug": "la_fourche",
  "version": "0.1.0",
  "label": "La Fourche",
  "origin": "https://lafourche.fr",
  "entryUrl": "https://lafourche.fr/",
  "loginUrl": "https://lafourche.fr/account/login",
  "signupUrl": "https://lafourche.fr/account/register/flow",
  "platform": "lafourche-next",
  "fulfillment": [
    "delivery",
    "click_and_collect"
  ],
  "accountRequired": false,
  "scopeFields": []
};
