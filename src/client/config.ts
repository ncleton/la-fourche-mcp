import { z } from "zod";
import { ShopError } from "./errors.js";
import { RETAILER } from "./retailer.js";

export interface ShopConfig {
  /** Valeurs du périmètre (magasin, drive) exigées par l’enseigne ; vide pour une enseigne nationale. */
  scope: Record<string, string>;
  camoufoxUrl: string;
  camoufoxUserId: string;
  camoufoxApiKey: string;
}

const camoufoxSchema = z.object({
  camoufoxUrl: z.string().url(),
  camoufoxUserId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/),
  camoufoxApiKey: z.string().min(32),
});

function first(env: NodeJS.ProcessEnv, ...keys: string[]): string {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return "";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ShopConfig {
  if (first(env, "CAMOFOX_AUTH_MODE") !== "required") {
    throw new ShopError(
      "CAMOFOX_AUTH_MODE doit valoir required.",
      "invalid_configuration",
      "Protégez le service Camoufox local avec CAMOFOX_AUTH_MODE=required et une CAMOFOX_API_KEY aléatoire d’au moins 32 caractères.",
    );
  }
  const scope: Record<string, string> = {};
  const missing: string[] = [];
  for (const field of RETAILER.scopeFields) {
    const value = first(env, field.env);
    if (!value) { missing.push(field.env); continue; }
    if (field.pattern && !new RegExp(field.pattern).test(value)) {
      throw new ShopError(
        `${field.env} a un format invalide.`,
        "invalid_configuration",
        `${field.description} Exemple : ${field.example}`,
      );
    }
    scope[field.key] = value;
  }
  if (missing.length) {
    throw new ShopError(
      `Configuration ${RETAILER.label} incomplète : ${missing.join(", ")}.`,
      "invalid_configuration",
      "Copiez .env.example vers .env et renseignez le périmètre exact choisi sur le site officiel, un identifiant de profil unique et une clé Camoufox forte.",
      { fields: missing },
    );
  }
  const parsed = camoufoxSchema.safeParse({
    camoufoxUrl: first(env, "CAMOFOX_URL") || "http://127.0.0.1:9377",
    camoufoxUserId: first(env, "CAMOFOX_USER_ID"),
    camoufoxApiKey: first(env, "CAMOFOX_API_KEY"),
  });
  if (!parsed.success) {
    throw new ShopError(
      "Configuration Camoufox incomplète ou invalide.",
      "invalid_configuration",
      "Renseignez CAMOFOX_USER_ID (identifiant de profil unique par personne et par compte), CAMOFOX_URL et une CAMOFOX_API_KEY forte dans .env.",
      { fields: parsed.error.issues.map((issue) => issue.path.join(".")) },
    );
  }
  const camoufox = new URL(parsed.data.camoufoxUrl);
  if (camoufox.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(camoufox.hostname) || camoufox.username || camoufox.password || !["", "/"].includes(camoufox.pathname) || camoufox.search || camoufox.hash) {
    throw new ShopError("CAMOFOX_URL doit être une origine HTTP loopback sans chemin.", "invalid_configuration", "Utilisez par exemple http://127.0.0.1:9377. N’exposez pas le navigateur sur Internet.");
  }
  if (new Set(parsed.data.camoufoxApiKey).size < 12 || /change.?me|example|password|secret|123456/i.test(parsed.data.camoufoxApiKey)) {
    throw new ShopError("CAMOFOX_API_KEY n’est pas suffisamment forte.", "invalid_configuration", "Générez une clé aléatoire d’au moins 32 caractères et conservez-la dans un gestionnaire de secrets.");
  }
  return { scope, ...parsed.data, camoufoxUrl: parsed.data.camoufoxUrl.replace(/\/+$/, "") };
}
