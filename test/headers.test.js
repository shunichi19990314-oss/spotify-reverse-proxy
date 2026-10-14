import test from "node:test";
import assert from "node:assert/strict";

import {
  buildUpstreamHeaders,
  sanitizeResponseHeaders,
  rewriteLocationHeader,
  rewriteSetCookies,
} from "../lib/headers.js";

function fakeReq(headers = {}) {
  return { method: "GET", headers };
}

function makeResponse(headers) {
  const h = new Headers();
  for (const [k, v] of headers) h.append(k, v);
  return new Response(null, { status: 200, headers: h });
}

test("buildUpstreamHeaders: Origin / Referer / sec-fetch-site を上流オリジンに付け替える", () => {
  const h = buildUpstreamHeaders(
    fakeReq({
      host: "my-proxy.onrender.com",
      origin: "https://my-proxy.onrender.com",
      referer: "https://my-proxy.onrender.com/collection",
      cookie: "sp_dc0=ABC; sp_key=XYZ",
      "user-agent": "Mozilla/5.0 Test",
      "accept-encoding": "gzip, deflate, br",
      "content-length": "0",
      connection: "keep-alive",
    }),
    "open.spotify.com",
    "/collection",
  );

  assert.equal(h.get("origin"), "https://open.spotify.com");
  assert.equal(h.get("referer"), "https://open.spotify.com/collection");
  assert.equal(h.get("sec-fetch-site"), "same-origin");
  assert.equal(h.get("cookie"), "sp_dc0=ABC; sp_key=XYZ");
  assert.equal(h.get("user-agent"), "Mozilla/5.0 Test");
  // undici に任せる / 上流が誤解するヘッダは落とす
  assert.equal(h.get("host"), null);
  assert.equal(h.get("accept-encoding"), null);
  assert.equal(h.get("content-length"), null);
  assert.equal(h.get("connection"), null);
});

test("sanitizeResponseHeaders: CSP / XFO / HSTS / content-encoding を除去", () => {
  const res = makeResponse([
    ["content-type", "text/html; charset=utf-8"],
    ["content-security-policy", "script-src 'self'"],
    ["content-security-policy-report-only", "default-src 'self'"],
    ["x-frame-options", "DENY"],
    ["strict-transport-security", "max-age=31536000"],
    ["cross-origin-resource-policy", "same-origin"],
    ["cross-origin-opener-policy", "same-origin"],
    ["permissions-policy", "encrypted-media=()"],
    ["content-encoding", "gzip"],
    ["content-length", "999"],
    ["transfer-encoding", "chunked"],
    ["server", "envoy"],
    ["cache-control", "private, max-age=0"],
    ["etag", '"abc"'],
  ]);

  const keys = sanitizeResponseHeaders(res).map(([k]) => k.toLowerCase());
  for (const banned of [
    "content-security-policy",
    "content-security-policy-report-only",
    "x-frame-options",
    "strict-transport-security",
    "cross-origin-resource-policy",
    "cross-origin-opener-policy",
    "permissions-policy",
    "content-encoding",
    "content-length",
    "transfer-encoding",
    "server",
  ]) {
    assert.ok(!keys.includes(banned), `${banned} が残っている`);
  }
  assert.ok(keys.includes("content-type"));
  assert.ok(keys.includes("cache-control"));
  assert.ok(keys.includes("etag"));
});

test("sanitizeResponseHeaders: link ヘッダは書き換えて残す", () => {
  const res = makeResponse([["link", '<https://open.spotifycdn.com/a.js>; rel=preload; as=script']]);
  const pairs = sanitizeResponseHeaders(res);
  const link = pairs.find(([k]) => k.toLowerCase() === "link");
  assert.ok(link, "link ヘッダが消えている");
  assert.equal(link[1], "</__h/open.spotifycdn.com/a.js>; rel=preload; as=script");
});

test("rewriteLocationHeader", () => {
  assert.equal(rewriteLocationHeader("https://accounts.spotify.com/login?x=1"), "/__h/accounts.spotify.com/login?x=1");
  assert.equal(rewriteLocationHeader("https://open.spotify.com/premium"), "/premium");
  assert.equal(rewriteLocationHeader("//i.scdn.co/a.png"), "/__h/i.scdn.co/a.png");
  assert.equal(rewriteLocationHeader("/relative/path"), "/relative/path");
  assert.equal(rewriteLocationHeader("https://example.com/x"), "https://example.com/x");
});

test("rewriteSetCookies: Domain 除去 / Path=/ / SameSite=None; Secure", () => {
  const res = makeResponse([
    ["set-cookie", "sp_dc0=AAA; Domain=.spotify.com; Path=/; Secure; HttpOnly; SameSite=Lax"],
    ["set-cookie", "__Host-sp_lid=BBB; Path=/account; Max-Age=3600"],
    ["set-cookie", "__Secure-token=CCC; Domain=open.spotify.com; Path=/; Expires=Wed, 09 Jun 2021 10:18:14 GMT"],
  ]);

  const out = rewriteSetCookies(res);
  assert.equal(out.length, 3);

  assert.equal(out[0], "sp_dc0=AAA; Path=/; Secure; HttpOnly; SameSite=None");
  assert.equal(out[0].toLowerCase().split("secure").length - 1, 1, "Secure が重複している");
  // __Host- プレフィックスは要件（Domain 無し / Path=/ / Secure）と衝突するため剥がす
  assert.ok(out[1].startsWith("sp_lid=BBB;"), out[1]);
  assert.ok(out[1].includes("Path=/"), out[1]);
  assert.ok(out[1].includes("Max-Age=3600"), out[1]);
  assert.ok(out[1].includes("SameSite=None"), out[1]);
  assert.ok(out[1].includes("Secure"), out[1]);
  assert.ok(out[2].startsWith("token=CCC;"), out[2]);
  assert.ok(!out[2].toLowerCase().includes("domain="), out[2]);
  assert.ok(out[2].includes("Expires=Wed, 09 Jun 2021 10:18:14 GMT"), out[2]);
});

test("rewriteSetCookies: Domain= の値に ; が含まれても壊れない", () => {
  const res = makeResponse([["set-cookie", 'a="x;y"; Domain=.spotify.com; Path=/']]);
  const out = rewriteSetCookies(res);
  assert.equal(out.length, 1);
  assert.ok(!out[0].toLowerCase().includes("domain="), out[0]);
});

test("rewriteSetCookies: Cookie が無ければ空配列", () => {
  assert.deepEqual(rewriteSetCookies(makeResponse([["content-type", "text/plain"]])), []);
});
