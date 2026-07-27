import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function request(path = "/", accept = "text/html") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${path}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: { accept },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the public Pack catalog", async () => {
  const response = await request();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>AART Pack Library<\/title>/i);
  assert.match(html, /Reuse work that/);
  assert.match(html, /already works/);
  assert.match(html, /What do you want to automate\?/);
  assert.match(html, /Browser Checks/);
  assert.match(html, /Install is not trust/);
  assert.match(html, /Registry preview/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("server-renders an individual Pack detail route", async () => {
  const response = await request("/packs/browser-checks");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /aart-pack-browser-checks/);
  assert.match(html, /Included Blocks/);
  assert.match(html, /aart pack add browser-checks --version 1\.4\.0/);
  assert.match(html, /CONTENT SEAL/);
  assert.match(html, /Install is not trust/);
});

test("returns a real 404 for an unknown Pack detail route", async () => {
  const response = await request("/packs/not-a-real-pack");
  assert.equal(response.status, 404);
  const html = await response.text();
  assert.doesNotMatch(html, /Explore the library/);
});

test("preview index exposes the canonical versioned Pack document and public CLI/MCP route", async () => {
  const raw = await readFile(new URL("../data/aart-pack-index.json", import.meta.url), "utf8");
  const index = JSON.parse(raw);
  assert.equal(index.schemaVersion, 1);
  assert.equal(index.mode, "preview");
  assert.ok(index.packs.length >= 6);
  assert.ok(index.packs.every((pack) => pack.npmPackageName.startsWith("aart-pack-")));
  assert.ok(index.packs.every((pack) => pack.categories.length > 0));
  assert.ok(index.packs.every((pack) => /^sha256:[a-f0-9]{64}$/.test(pack.contentHash)));

  const response = await request("/aart-pack-index.json", "application/json");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/i);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(await response.json(), index);
});
