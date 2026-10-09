import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../client/config.js";
import { RETAILER } from "../client/retailer.js";

const key = "k9Xq2mZp7TrW4vNb8LcY3sHd6JfG1aEuQz";

function environment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CAMOFOX_AUTH_MODE: "required", CAMOFOX_API_KEY: key, CAMOFOX_USER_ID: "test-user-profile", CAMOFOX_URL: "http://127.0.0.1:9377" };
  for (const field of RETAILER.scopeFields) env[field.env] = field.example;
  return env;
}

test("accepte une configuration complète", () => {
  const config = loadConfig(environment());
  assert.equal(config.camoufoxUserId, "test-user-profile");
  for (const field of RETAILER.scopeFields) assert.equal(config.scope[field.key], field.example);
});

test("refuse un Camoufox non protégé", () => {
  const env = environment();
  delete env.CAMOFOX_AUTH_MODE;
  assert.throws(() => loadConfig(env), /CAMOFOX_AUTH_MODE/);
});

test("refuse un navigateur exposé hors loopback", () => {
  const env = environment();
  env.CAMOFOX_URL = "http://192.168.1.20:9377";
  assert.throws(() => loadConfig(env), /loopback/);
});

test("refuse une clé faible", () => {
  const env = environment();
  Object.assign(env, { CAMOFOX_API_KEY: "a".repeat(40) });
  assert.throws(() => loadConfig(env), /suffisamment forte/);
});

test("signale les champs de périmètre manquants", { skip: RETAILER.scopeFields.length === 0 }, () => {
  const env = environment();
  delete env[RETAILER.scopeFields[0].env];
  assert.throws(() => loadConfig(env), new RegExp(RETAILER.scopeFields[0].env));
});
