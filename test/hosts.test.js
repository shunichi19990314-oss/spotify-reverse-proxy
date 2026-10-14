import test from "node:test";
import assert from "node:assert/strict";

import {
  isProxyableHost,
  parseHostPort,
  parseProxyTarget,
  buildUpstreamUrl,
  buildAuthority,
  toProxyPath,
} from "../lib/hosts.js";

test("isProxyableHost: 許可ドメインとサブドメイン", () => {
  assert.ok(isProxyableHost("open.spotify.com"));
  assert.ok(isProxyableHost("spclient.wg.spotify.com"));
  assert.ok(isProxyableHost("i.scdn.co"));
  assert.ok(isProxyableHost("open.spotifycdn.com"));
  assert.ok(isProxyableHost("audio4-ak-spotify-com.akamaized.net"));
  assert.ok(isProxyableHost("spotify.com"));
});

test("isProxyableHost: 許可外・不正なホストを拒否", () => {
  assert.ok(!isProxyableHost("evil.com"));
  assert.ok(!isProxyableHost("open.spotify.com.evil.com"));
  assert.ok(!isProxyableHost("notspotify.com"));
  assert.ok(!isProxyableHost("spotify.com.evil"));
  assert.ok(!isProxyableHost(""));
  assert.ok(!isProxyableHost("open.spotify.com:443")); // ポートは分離してから渡す
  assert.ok(!isProxyableHost("user:pass@open.spotify.com"));
  assert.ok(!isProxyableHost("open.spotify.com/x"));
  assert.ok(!isProxyableHost(null));
  assert.ok(!isProxyableHost(undefined));
  assert.ok(!isProxyableHost("a".repeat(300)));
});

test("parseHostPort", () => {
  assert.deepEqual(parseHostPort("open.spotify.com"), { host: "open.spotify.com", port: null });
  assert.deepEqual(parseHostPort("localhost:3001"), { host: "localhost", port: "3001" });
  assert.deepEqual(parseHostPort("127.0.0.1:8080"), { host: "127.0.0.1", port: "8080" });
  assert.deepEqual(parseHostPort("open.spotify.com:abc"), { host: "open.spotify.com", port: null });
});

test("parseProxyTarget: デフォルトルートは open.spotify.com へ", () => {
  const t = parseProxyTarget("/");
  assert.equal(t.host, "open.spotify.com");
  assert.equal(t.path, "/");
  assert.equal(t.prefixed, false);

  const t2 = parseProxyTarget("/static/js/main.js?v=1");
  assert.equal(t2.host, "open.spotify.com");
  assert.equal(t2.path, "/static/js/main.js");
  assert.equal(t2.search, "?v=1");
});

test("parseProxyTarget: /__h/<host>/<path>", () => {
  const t = parseProxyTarget("/__h/i.scdn.co/image/abc?x=1");
  assert.equal(t.host, "i.scdn.co");
  assert.equal(t.path, "/image/abc");
  assert.equal(t.search, "?x=1");
  assert.equal(t.prefixed, true);

  assert.equal(parseProxyTarget("/__h/api.spotify.com").path, "/");
  assert.equal(parseProxyTarget("/__h/api.spotify.com/").path, "/");
});

test("parseProxyTarget: 許可外ホストは host_not_allowed", () => {
  assert.equal(parseProxyTarget("/__h/evil.com/x").error, "host_not_allowed");
  assert.equal(parseProxyTarget("/__h/open.spotify.com.evil.com/x").error, "host_not_allowed");
  assert.equal(parseProxyTarget("/__h/localhost/x").error, "host_not_allowed");
});

test("parseProxyTarget: パス内のホストにポートを含められる", () => {
  const t = parseProxyTarget("/__h/localhost:3001/x");
  // localhost は既定の許可リストに無いので拒否される
  assert.equal(t.error, "host_not_allowed");
});

test("buildUpstreamUrl / buildAuthority", () => {
  assert.equal(buildUpstreamUrl("open.spotify.com", null, "/", ""), "https://open.spotify.com/");
  assert.equal(buildUpstreamUrl("open.spotify.com", "443", "/a", "?b=1"), "https://open.spotify.com/a?b=1");
  assert.equal(buildAuthority("open.spotify.com", null), "open.spotify.com");
  assert.equal(buildAuthority("open.spotify.com", "443"), "open.spotify.com");
});

test("toProxyPath: Location ヘッダの書き換え", () => {
  assert.equal(toProxyPath("https://open.spotify.com/collection"), "/collection");
  assert.equal(toProxyPath("https://accounts.spotify.com/login?x=1"), "/__h/accounts.spotify.com/login?x=1");
  assert.equal(toProxyPath("https://i.scdn.co/a.png"), "/__h/i.scdn.co/a.png");
  assert.equal(toProxyPath("https://example.com/x"), null);
  assert.equal(toProxyPath("not-a-url"), null);
});
