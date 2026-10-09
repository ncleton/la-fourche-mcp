import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RETAILER } from "../client/retailer.js";
import { ShopClient } from "../client/shop.js";
import { createServer } from "../mcp/server.js";
import { createShop, expected, productUrl } from "./fixtures.js";

async function connected() {
  const shop = createShop();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(new ShopClient(shop.config, undefined, shop.browser));
  const client = new Client({ name: `${RETAILER.id}-mcp-test`, version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { shop, server, client };
}

test("le serveur répond avec le SDK MCP officiel", async () => {
  const { server, client } = await connected();
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), [`connect_${RETAILER.slug}`, "session_status", "search_products", "get_product", "get_cart", "add_to_cart", "remove_from_cart"]);
    const response = await client.callTool({ name: "search_products", arguments: { query: expected.query, limit: 3 } });
    assert.equal(response.isError, undefined);
    assert.ok((response.structuredContent as { products: unknown[] }).products.length >= 1);
    const prompts = await client.listPrompts();
    assert.deepEqual(prompts.prompts.map((prompt) => prompt.name), [`onboard_${RETAILER.slug}`]);
    const session = await client.callTool({ name: "session_status", arguments: {} });
    assert.deepEqual((session.structuredContent as { fulfillment: string[] }).fulfillment, [...RETAILER.fulfillment]);
  } finally { await client.close(); await server.close(); }
});

test("le MCP prévisualise puis confirme une mutation liée au panier", async () => {
  const { shop, server, client } = await connected();
  try {
    const preview = await client.callTool({ name: "add_to_cart", arguments: { product_url: productUrl, quantity: 1 } });
    assert.equal(preview.isError, undefined);
    const token = (preview.structuredContent as { confirmation_token: string }).confirmation_token;
    assert.match(token, /^[0-9a-f-]{36}$/i);
    assert.equal(shop.cartQuantity(), 0, "La prévisualisation ne modifie jamais le panier.");
    const applied = await client.callTool({ name: "add_to_cart", arguments: { product_url: productUrl, quantity: 1, confirmation_token: token } });
    assert.equal(applied.isError, undefined);
    assert.equal(shop.cartQuantity(), 1);
    const replay = await client.callTool({ name: "add_to_cart", arguments: { product_url: productUrl, quantity: 1, confirmation_token: token } });
    assert.equal(replay.isError, true, "Un jeton ne se rejoue jamais.");
    assert.equal(shop.cartQuantity(), 1);
    const removePreview = await client.callTool({ name: "remove_from_cart", arguments: { product_id: expected.productId, quantity: 1 } });
    const removeToken = (removePreview.structuredContent as { confirmation_token: string }).confirmation_token;
    const removed = await client.callTool({ name: "remove_from_cart", arguments: { product_id: expected.productId, quantity: 1, confirmation_token: removeToken } });
    assert.equal(removed.isError, undefined);
    assert.equal(shop.cartQuantity(), 0);
  } finally { await client.close(); await server.close(); }
});

test("un jeton est refusé si le panier a changé depuis la prévisualisation", async () => {
  const { shop, server, client } = await connected();
  try {
    const preview = await client.callTool({ name: "add_to_cart", arguments: { product_url: productUrl, quantity: 1 } });
    const token = (preview.structuredContent as { confirmation_token: string }).confirmation_token;
    shop.setCartQuantity(3);
    const refused = await client.callTool({ name: "add_to_cart", arguments: { product_url: productUrl, quantity: 1, confirmation_token: token } });
    assert.equal(refused.isError, true);
    assert.equal(shop.cartQuantity(), 3);
  } finally { await client.close(); await server.close(); }
});
