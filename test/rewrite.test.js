import test from "node:test";
import assert from "node:assert/strict";

import {
  rewriteText,
  shouldRewrite,
  mediaType,
  stripIntegrityAndCors,
  stripMetaCsp,
  rewriteInlineBase64Scripts,
} from "../lib/rewrite.js";

test("https:// の絶対 URL を /__h/<host>/ に書き換える", () => {
  assert.equal(
    rewriteText('href="https://open.spotifycdn.com/cdn/images/favicon32.png"'),
    'href="/__h/open.spotifycdn.com/cdn/images/favicon32.png"',
  );
  assert.equal(rewriteText("https://i.scdn.co/image/abc"), "/__h/i.scdn.co/image/abc");
});

test("http:// も書き換える", () => {
  assert.equal(rewriteText("http://api.spotify.com/v1/me"), "/__h/api.spotify.com/v1/me");
});

test("プロトコル相対 URL //host を書き換える", () => {
  assert.equal(rewriteText('<img src="//i.scdn.co/a.png">'), '<img src="/__h/i.scdn.co/a.png">');
});

test("wss:// は /__w/ に書き換える", () => {
  assert.equal(
    rewriteText('new WebSocket("wss://gae2-dealer.g2.spotify.com/?token=x")'),
    'new WebSocket("/__w/gae2-dealer.g2.spotify.com/?token=x")',
  );
  assert.equal(rewriteText("ws://dealer.spotify.com/"), "/__w/dealer.spotify.com/");
});

test("JSON エスケープ形 https:\\/\\/host を書き換える", () => {
  const input = String.raw`{"url":"https:\/\/spclient.wg.spotify.com\/bootstrap\/v1"}`;
  const out = rewriteText(input);
  assert.ok(out.includes(String.raw`\/__h\/spclient.wg.spotify.com\/bootstrap\/v1`), out);
  assert.ok(!out.includes(String.raw`https:\/\/spclient`), out);
});

test("Unicode エスケープ形 \\u002F\\u002Fhost を書き換える", () => {
  const input = String.raw`"https:\u002F\u002Fapresolve.spotify.com\u002Fservice\u002Fresolve"`;
  const out = rewriteText(input);
  assert.ok(out.includes(String.raw`\u002F__h\u002Fapresolve.spotify.com`), out);
});

test("クエリ文字列とフラグメントを保持する", () => {
  assert.equal(
    rewriteText("https://open.spotify.com/track/xyz?si=abc#frag"),
    "/__h/open.spotify.com/track/xyz?si=abc#frag",
  );
});

test("許可されていないドメインは書き換えない", () => {
  assert.equal(rewriteText("https://www.google.com/recaptcha/api.js"), "https://www.google.com/recaptcha/api.js");
  assert.equal(rewriteText("https://example.com/x"), "https://example.com/x");
});

test("サブドメインを騙った長いホスト名を途中マッチしない", () => {
  // 途中マッチすると "open.spotify.com.evil.com" という
  // 攻撃者ドメインへ中継してしまうため、必ず不変であること
  assert.equal(rewriteText("https://open.spotify.com.evil.com/x"), "https://open.spotify.com.evil.com/x");
  assert.equal(rewriteText("https://notspotify.com/x"), "https://notspotify.com/x");
  assert.equal(rewriteText("https://evilscdn.co/x"), "https://evilscdn.co/x");
});

test("深いサブドメインも書き換える", () => {
  assert.equal(
    rewriteText("https://audio4-ak-spotify-com.akamaized.net/audio/abc"),
    "/__h/audio4-ak-spotify-com.akamaized.net/audio/abc",
  );
  assert.equal(rewriteText("https://gew1-spclient.spotify.com/x"), "/__h/gew1-spclient.spotify.com/x");
});

test("既にプロキシ済みのパスは二重書き換えしない", () => {
  const once = rewriteText("https://open.spotify.com/a");
  assert.equal(rewriteText(once), once);
});

test("data: / blob: / 相対 URL は不変", () => {
  assert.equal(rewriteText("data:image/png;base64,AAAA"), "data:image/png;base64,AAAA");
  assert.equal(rewriteText("blob:https://open.spotify.com/uuid"), "blob:https://open.spotify.com/uuid");
  assert.equal(rewriteText("/static/js/main.js"), "/static/js/main.js");
  assert.equal(rewriteText("static/js/main.js"), "static/js/main.js");
});

test("CSS url() 内を書き換える", () => {
  assert.equal(
    rewriteText(".a{background:url(https://encore.scdn.co/fonts/abc.woff2)}"),
    ".a{background:url(/__h/encore.scdn.co/fonts/abc.woff2)}",
  );
});

test("shouldRewrite / mediaType", () => {
  assert.equal(mediaType("text/html; charset=utf-8"), "text/html");
  assert.ok(shouldRewrite("text/html; charset=utf-8"));
  assert.ok(shouldRewrite("application/javascript"));
  assert.ok(shouldRewrite("application/vnd.api+json"));
  assert.ok(shouldRewrite("image/svg+xml"));
  assert.ok(!shouldRewrite("application/octet-stream"));
  assert.ok(!shouldRewrite("font/woff2"));
  assert.ok(!shouldRewrite("audio/mpeg"));
  assert.ok(!shouldRewrite("application/wasm"));
  assert.ok(!shouldRewrite(""));
});

test("stripIntegrityAndCors が integrity と crossorigin を除去する", () => {
  const html =
    '<script src="/a.js" integrity="sha384-xxx" crossorigin="anonymous"></script>' +
    "<link rel='stylesheet' href='/b.css' crossorigin />" +
    '<script src="/c.js" crossorigin></script>';
  const out = stripIntegrityAndCors(html);
  assert.ok(!out.includes("integrity"), out);
  assert.ok(!out.includes("crossorigin"), out);
  assert.ok(out.includes('src="/a.js"'), out);
  assert.ok(out.includes("href='/b.css'"), out);
});

test("stripMetaCsp が meta CSP を除去する", () => {
  const html =
    '<head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'"><meta charset="utf-8"></head>';
  const out = stripMetaCsp(html);
  assert.ok(!out.includes("Content-Security-Policy"), out);
  assert.ok(out.includes('<meta charset="utf-8">'), out);
});

test("base 指定時は自オリジンを含む絶対 URL になる（new URL() 破壊の防止）", () => {
  const B = "https://spx.up.railway.app";
  // 実障害の再現: Spotify のバンドルには
  //   let dI = "<url>", dk = new URL(dI).origin;
  // というモジュールトップレベルの new URL() があり、
  // ルート相対に書き換えると TypeError でモジュール評価が失敗する。
  const out = rewriteText('"https://open.spotifycdn.com/cdn/templates/display.html"', B);
  assert.equal(out, '"https://spx.up.railway.app/__h/open.spotifycdn.com/cdn/templates/display.html"');
  const value = JSON.parse(out);
  assert.equal(new URL(value).origin, B, "new URL() で origin を取り出せること");
});

test("wss:// は wss:// のまま（https:// にすると new WebSocket() が壊れる）", () => {
  const B = "https://spx.up.railway.app";
  assert.equal(
    rewriteText('new WebSocket("wss://gae2-dealer.g2.spotify.com/?t=1")', B),
    'new WebSocket("wss://spx.up.railway.app/__w/gae2-dealer.g2.spotify.com/?t=1")',
  );
  assert.equal(
    rewriteText('"ws://dealer.spotify.com/x"', B),
    '"wss://spx.up.railway.app/__w/dealer.spotify.com/x"',
    "http ベースのプロキシでは ws -> wss に昇格させる",
  );
  assert.equal(
    rewriteText(String.raw`"wss:\/\/dealer.spotify.com\/x"`, B),
    String.raw`"wss:\/\/spx.up.railway.app\/__w\/dealer.spotify.com\/x"`,
  );
});

test("エスケープ形でも自オリジン込みの絶対 URL になる", () => {
  const B = "https://spx.up.railway.app";
  assert.equal(
    rewriteText(String.raw`"https:\/\/spclient.wg.spotify.com\/bootstrap\/v1"`, B),
    String.raw`"https:\/\/spx.up.railway.app\/__h\/spclient.wg.spotify.com\/bootstrap\/v1"`,
  );
  assert.equal(
    rewriteText(String.raw`"https:\u002F\u002Fapresolve.spotify.com\u002Fy"`, B),
    String.raw`"https:\u002F\u002Fspx.up.railway.app\u002F__h\u002Fapresolve.spotify.com\u002Fy"`,
  );
});

test("冪等性: 書き換え結果を再度 rewriteText しても変化しない", () => {
  const B = "https://spx.up.railway.app";
  const once = rewriteText("https://i.scdn.co/a.png", B);
  assert.equal(rewriteText(once, B), once);
  // 自ホストを許可リストに含めた構成でも二重ネストしない
  const twice = rewriteText(rewriteText("https://i.scdn.co/a.png", B), B);
  assert.ok(!twice.includes("__h/spx.up.railway.app"), `二重ネスト: ${twice}`);
});

test("rewriteInlineBase64Scripts: base64 埋め込み JSON 内の URL も書き換える", () => {
  const B = "https://spx.up.railway.app";
  const payload = JSON.stringify({
    "a.js": "https://open.spotifycdn.com/cdn/a.js",
    "b.png": "https://i.scdn.co/b.png",
    ext: "https://example.com/keep",
  });
  const b64 = Buffer.from(payload, "utf8").toString("base64");
  const html = `<script id="__CDN_FILE_URLS__" type="text/plain">${b64}</script>`;

  const out = rewriteInlineBase64Scripts(html, B);
  assert.ok(out.includes("text/plain"), out);

  const newB64 = /type="text\/plain">([^<]*)<\/script>/.exec(out)[1];
  const decoded = JSON.parse(Buffer.from(newB64, "base64").toString("utf8"));
  assert.equal(decoded["a.js"], `${B}/__h/open.spotifycdn.com/cdn/a.js`);
  assert.equal(decoded["b.png"], `${B}/__h/i.scdn.co/b.png`);
  assert.equal(decoded.ext, "https://example.com/keep", "対象外ドメインは維持");
  // new URL() で壊れない
  assert.equal(new URL(decoded["a.js"]).origin, B);
});

test("rewriteInlineBase64Scripts: base64 でない / バイナリっぽい中身は触らない", () => {
  const B = "https://spx.up.railway.app";
  const notB64 = '<script type="text/plain">hello world!!</script>';
  assert.equal(rewriteInlineBase64Scripts(notB64, B), notB64);

  const empty = '<script type="text/plain"></script>';
  assert.equal(rewriteInlineBase64Scripts(empty, B), empty);

  // 書き換え対象 URL を含まなければ再エンコードもしない（バイト完全一致）
  const stable = Buffer.from(JSON.stringify({ a: 1 }), "utf8").toString("base64");
  const html = `<script type="text/plain">${stable}</script>`;
  assert.equal(rewriteInlineBase64Scripts(html, B), html);
});

test("大きな JS バンドルでも破綻しない（性能スモーク）", () => {
  const chunk =
    'var a="https://spclient.wg.spotify.com/api";var b="https:\\/\\/i.scdn.co\\/x.png";var c="//encore.scdn.co/y";';
  const big = chunk.repeat(20_000); // 約 2.4MB
  const t0 = Date.now();
  const out = rewriteText(big);
  const ms = Date.now() - t0;
  assert.ok(!out.includes("https://spclient"), "raw https が残っている");
  assert.ok(!out.includes(String.raw`https:\/\/i.scdn.co`), "escaped https が残っている");
  assert.ok(out.includes("/__h/spclient.wg.spotify.com/api"));
  assert.ok(ms < 15_000, `書き換えが遅すぎる: ${ms}ms`);
});
