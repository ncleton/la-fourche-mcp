import assert from "node:assert/strict";
import test from "node:test";
import { startLoginServer } from "../client/onboarding.js";
import { RETAILER } from "../client/retailer.js";
import type { ShopClient } from "../client/shop.js";

test("le wizard écoute sur loopback et expose les deux parcours", async () => {
  const targets: Array<string | undefined> = [];
  const status = { connected: false, ready: true, account_connected: false, manual_action: "Connexion manuelle requise." };
  const fakeClient = {
    async connect(target?: string) { targets.push(target); return status; },
    async sessionStatus() { return status; },
  } as unknown as ShopClient;
  const flow = await startLoginServer(fakeClient);
  try {
    const url = new URL(flow.url);
    assert.equal(url.hostname, "127.0.0.1");
    assert.match(url.pathname, /^\/[0-9a-f]{64}$/);
    const response = await fetch(flow.url);
    const html = await response.text();
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(html, /J’ai un compte — me connecter/);
    assert.ok(html.includes(`Créer un compte ${RETAILER.label}`.replace(/&/g, "&amp;")));
    assert.doesNotMatch(html, /<input[^>]+type=["']password/i);
    const creation = await fetch(`${flow.url}/create-account`, { redirect: "manual" });
    assert.equal(creation.status, 302);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(targets, ["create_account"]);
    const wrongToken = await fetch(`http://127.0.0.1:${url.port}/deadbeef/connect`, { redirect: "manual" });
    assert.equal(wrongToken.status, 404);
  } finally { await flow.close(); }
});
