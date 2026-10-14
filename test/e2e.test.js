import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const WS = await import("ws");

const SERVER_JS = fileURLToPath(new URL("../server.js", import.meta.url));
const MOCK_HOST = "127.0.0.1";

/* ------------------------------------------------------------------ *
 * 上流（Spotify 相当）のモック
 * ------------------------------------------------------------------ */

const HTML_PAGE = `<!DOCTYPE html><html lang="en"><head>
<meta charSet="utf-8"/><title>Spotify – Web Player</title>
<meta http-equiv="Content-Security-Policy" content="script-src 'self'">
<link rel="icon" href="https://open.spotifycdn.com/cdn/images/favicon32.png"/>
<link rel="stylesheet" href="https://encore.scdn.co/encore.css" integrity="sha384-AAAA" crossorigin="anonymous"/>
<script src="/static/js/vendor.js" crossorigin></script>
</head><body>
<img srcset="https://i.scdn.co/a.jpg 1x, https://i.scdn.co/b.jpg 2x" src="https://mosaic.scdn.co/m.jpg"/>
<a href="https://open.spotify.com/track/123">t</a>
<script src="https://open.spotifycdn.com/cdn/js/main.js"></script>
</body></html>`;

const JS_BUNDLE = [
  'var api="https://spclient.wg.spotify.com/bootstrap/v1";',
  'var img="https:\\/\\/i.scdn.co\\/image\\/abc";',
  'var ws="wss://gae2-dealer.g2.spotify.com/?token=1";',
  'var cdn="//open.spotifycdn.com/cdn/x.png";',
  'var ext="https://www.google.com/recaptcha/api.js";',
  'var evil="https://open.spotify.com.evil.com/x";',
  "var chunk=import('./chunk-42.js');",
].join("\n");

function makeMock() {
  const big = "x".repeat(200 * 1024);
  const hits = new Map();
  const bump = (k) => hits.set(k, (hits.get(k) || 0) + 1);

  const server = http.createServer((req, res) => {
    bump(p0(req.url));
    const url = new URL(req.url, `http://${MOCK_HOST}`);
    const p = url.pathname;

    if (p === "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "script-src 'self' https://open.spotifycdn.com; frame-ancestors 'self'",
        "x-frame-options": "DENY",
        "strict-transport-security": "max-age=31536000",
        "set-cookie": ["sp_dc0=AAA; Domain=.spotify.com; Path=/; Secure; HttpOnly", "sp_lid=BBB; Path=/"],
        etag: '"v1"',
      });
      return res.end(HTML_PAGE);
    }

    if (p === "/echo") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ headers: req.headers, method: req.method, url: req.url }));
    }

    // 同じ内容だが application/octet-stream で返す＝プロキシが本文を書き換えない。
    // 「上流に実際に届いたヘッダ」をそのまま検証したいときに使う。
    if (p === "/echo-raw") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(JSON.stringify({ headers: req.headers, method: req.method, url: req.url }));
    }

    if (p === "/redirect") {
      res.writeHead(302, { location: "https://accounts.spotify.com/login?continue=https%3A%2F%2Fopen.spotify.com%2F" });
      return res.end();
    }

    if (p === "/redirect-same-host") {
      // 既定の上流（＝このモック自身）へ戻す。素のパスになるはず
      res.writeHead(301, { location: `http://${req.headers.host}/collection/tracks` });
      return res.end();
    }

    if (p === "/redirect-other-host") {
      res.writeHead(302, { location: "https://open.spotify.com/collection/tracks" });
      return res.end();
    }

    if (p === "/bundle.js") {
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
      return res.end(JS_BUNDLE);
    }

    if (p === "/gzipped.js") {
      const gz = zlib.gzipSync(Buffer.from(JS_BUNDLE));
      res.writeHead(200, { "content-type": "application/javascript", "content-encoding": "gzip" });
      return res.end(gz);
    }

    // API レスポンス相当: 本文の JSON に Spotify の絶対 URL が入っている
    if (p === "/apijson") {
      res.writeHead(200, { "content-type": "application/json" });
      // JSON.stringify だと \/ エスケープ形が消えてしまうので、生テキストで返す
      // （実 API にはスラッシュをエスケープして返すものがある）
      const rawJson =
        '{"href":"https://api.spotify.com/v1/tracks/123",' +
        '"images":[{"url":"https://i.scdn.co/image/abc","w":640}],' +
        '"escaped":"https:\\/\\/spclient.wg.spotify.com\\/x",' +
        '"external":"https://example.com/keep"}';
      return res.end(rawJson);
    }

    if (p === "/binary") {
      const buf = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(buf.length) });
      return res.end(buf);
    }

    if (p === "/big-declared") {
      res.writeHead(200, { "content-type": "text/plain", "content-length": String(big.length) });
      return res.end(big);
    }

    if (p === "/big-chunked") {
      res.writeHead(200, { "content-type": "text/plain" }); // content-length なし = chunked
      for (let i = 0; i < 40; i++) res.write("y".repeat(5120));
      return res.end();
    }

    if (p === "/post" && req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ received: body.toString("utf8"), length: body.length, ct: req.headers["content-type"] }));
      });
      return;
    }

    if (p === "/cached.js") {
      res.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "public, max-age=31536000, immutable",
      });
      // gzip 閾値 (1KB) を超えるサイズにする
      return res.end((JS_BUNDLE + "\n").repeat(20));
    }

    if (p === "/cached-with-cookie.js") {
      res.writeHead(200, {
        "content-type": "application/javascript",
        "cache-control": "public, max-age=31536000",
        "set-cookie": "sid=1; Path=/",
      });
      return res.end(JS_BUNDLE);
    }

    if (p === "/nocache.js") {
      res.writeHead(200, {
        "content-type": "application/javascript",
        "cache-control": "no-store",
      });
      return res.end(JS_BUNDLE);
    }

    if (p === "/empty204") {
      res.writeHead(204);
      return res.end();
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("mock 404");
  });

  function p0(u) {
    return u.split("?")[0];
  }

  // WebSocket エコーサーバー
  const wss = new WS.WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (sock, req) => {
    sock.send(JSON.stringify({ hello: true, origin: req.headers.origin || null, cookie: req.headers.cookie || null }));
    sock.on("message", (data, isBinary) => sock.send(data, { binary: isBinary }));
  });

  return { server, wss, hits, hitCount: (k) => hits.get(k) || 0 };
}

/* ------------------------------------------------------------------ *
 * プロキシ本体を子プロセスとして起動
 * ------------------------------------------------------------------ */

async function startProxy(mockPort, extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER_JS], {
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      UPSTREAM_SCHEME: "http",
      DEFAULT_UPSTREAM_HOST: `${MOCK_HOST}:${mockPort}`,
      PROXY_ALLOW_DOMAINS: `127.0.0.1,localhost,spotify.com,scdn.co,pscdn.co,spotifycdn.com,akamaized.net`,
      MAX_REWRITE_BYTES: "8192",
      LOG_LEVEL: "warn",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`proxy did not start.\nstdout: ${stdout}\nstderr: ${stderr}`)), 15_000);
    child.stdout.on("data", (d) => {
      const m = /SPX_READY (\d+)/.exec(String(d));
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`proxy exited early (code ${code}).\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
  });

  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    child,
    logs: () => ({ stdout, stderr }),
    async stop() {
      child.kill("SIGTERM");
      await once(child, "exit").catch(() => {});
    },
  };
}

/* ------------------------------------------------------------------ *
 * テスト本体
 * ------------------------------------------------------------------ */

let mock;
let mockPort;
let proxy;

before(async () => {
  mock = makeMock();
  await new Promise((r) => mock.server.listen(0, MOCK_HOST, r));
  mockPort = mock.server.address().port;
  proxy = await startProxy(mockPort);
});

after(async () => {
  await proxy?.stop();
  mock?.wss?.close();
  mock?.server?.close();
});

/** 書き換え後の URL は必ず自オリジンを含む絶対 URL になる（new URL() 対策） */
const abs = (path) => proxy.origin + path;
/** WebSocket は wss:// を維持する（https:// だと new WebSocket() が壊れる） */
const wsAbs = (path) => abs(path).replace(/^http:/, "ws:").replace(/^https:/, "wss:");

test("GET / は上流の HTML を返し、CSP/XFO/HSTS が除去される", async () => {
  const res = await fetch(`${proxy.origin}/`, { headers: { "accept-encoding": "identity" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-security-policy"), "frame-ancestors *"); // 自前の埋め込み許可のみ
  assert.equal(res.headers.get("x-frame-options"), null);
  assert.equal(res.headers.get("strict-transport-security"), null);
  const body = await res.text();
  assert.ok(body.includes("<title>Spotify – Web Player</title>"));
  assert.ok(!body.includes('http-equiv="Content-Security-Policy"'), "meta CSP が残っている");
});

test("HTML 内の絶対 URL が /__h/<host>/ に書き換わる", async () => {
  const res = await fetch(`${proxy.origin}/`, { headers: { "accept-encoding": "identity" } });
  const body = await res.text();
  assert.ok(body.includes(abs('/__h/open.spotifycdn.com/cdn/images/favicon32.png')), body);
  assert.ok(body.includes(abs('/__h/encore.scdn.co/encore.css')));
  assert.ok(body.includes(abs('/__h/open.spotifycdn.com/cdn/js/main.js')));
  // デフォルト上流と同一ホストは素のパス（ただし絶対 URL）
  assert.ok(body.includes(`href="${abs('/track/123')}"`) || body.includes(`href="${abs('/__h/open.spotify.com/track/123')}"`), body);
  assert.ok(!/"https:\/\/open\.spotifycdn\.com/.test(body), "書き換え漏れ");
  // ★ 回帰テスト: new URL(x) が壊れないよう、必ず絶対 URL であること
  //    （注入スクリプト自体は HP = "/__h/" という文字列を持つので除去してから検査）
  const withoutPatch = body.replace(/<script data-spx="runtime">[\s\S]*?<\/script>/, "");
  assert.ok(!withoutPatch.includes('"/__h/'), "ルート相対の /__h/ が残っているとアプリの new URL() が壊れる");
  assert.ok(!withoutPatch.includes("'/__h/"), "同上（シングルクォート）");
});

test("integrity / crossorigin が除去される", async () => {
  const res = await fetch(`${proxy.origin}/`, { headers: { "accept-encoding": "identity" } });
  const body = await res.text();
  assert.ok(!body.includes("integrity="), "integrity が残っている");
  assert.ok(!/crossorigin/i.test(body), "crossorigin が残っている");
  assert.ok(body.includes(abs('/__h/encore.scdn.co/encore.css')));
});

test("srcset が書き換わる", async () => {
  const res = await fetch(`${proxy.origin}/`, { headers: { "accept-encoding": "identity" } });
  const body = await res.text();
  assert.ok(body.includes(abs("/__h/i.scdn.co/a.jpg") + " 1x"), body);
  assert.ok(body.includes(abs("/__h/i.scdn.co/b.jpg") + " 2x"), body);
  assert.ok(body.includes(`src="${abs('/__h/mosaic.scdn.co/m.jpg')}"`), body);
});

test("ランタイムパッチが <head> 先頭に注入される", async () => {
  const res = await fetch(`${proxy.origin}/`, { headers: { "accept-encoding": "identity" } });
  const body = await res.text();
  const injected = body.indexOf('<script data-spx="runtime">');
  assert.ok(injected > -1, "注入スクリプトが無い");
  const firstVendor = body.indexOf('src="/static/js/vendor.js"');
  assert.ok(injected < firstVendor, "注入スクリプトが他のスクリプトより後になっている");
  assert.ok(body.includes("window.__SPX__"), "クライアントスクリプトの中身が無い");
  assert.ok(body.includes('"akamaized.net"'), "ドメインリストが注入されていない");
  assert.ok(!body.includes("__SPX_DOMAINS__"), "プレースホルダが未置換");
});

test("Set-Cookie が自オリジン用に書き換わる", async () => {
  const res = await fetch(`${proxy.origin}/`, { headers: { "accept-encoding": "identity" } });
  const cookies = res.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  for (const c of cookies) {
    assert.ok(!/domain=/i.test(c), `Domain= が残っている: ${c}`);
    assert.ok(/path=\//i.test(c), `Path=/ が無い: ${c}`);
    assert.ok(/samesite=none/i.test(c), `SameSite=None が無い: ${c}`);
    assert.ok(/;\s*secure/i.test(c), `Secure が無い: ${c}`);
  }
});

test("JS バンドル内の各種エスケープ形が書き換わる", async () => {
  const res = await fetch(`${proxy.origin}/bundle.js`, { headers: { "accept-encoding": "identity" } });
  assert.equal(res.headers.get("content-type"), "application/javascript; charset=utf-8");
  const body = await res.text();
  assert.ok(body.includes(`"${abs('/__h/spclient.wg.spotify.com/bootstrap/v1')}"`), body);
  // スラッシュエスケープ形: プレフィックス全体が \/ になる
  const escForm = abs("/__h/i.scdn.co/image/abc").replace(/\//g, "\\/");
  assert.ok(body.includes(`"${escForm}"`), body);
  assert.ok(body.includes(`"${wsAbs('/__w/gae2-dealer.g2.spotify.com/?token=1')}"`), body);
  assert.ok(body.includes(`"${abs('/__h/open.spotifycdn.com/cdn/x.png')}"`), body);
  // 対象外はそのまま
  assert.ok(body.includes("https://www.google.com/recaptcha/api.js"), body);
  assert.ok(body.includes("https://open.spotify.com.evil.com/x"), body);
  // 相対 import はそのまま（動的 import が /bundle.js 基準で解決される）
  assert.ok(body.includes("import('./chunk-42.js')"), body);
});

test("上流が gzip していても展開して書き換え、必要なら再圧縮する", async () => {
  const res = await fetch(`${proxy.origin}/gzipped.js`, { headers: { "accept-encoding": "gzip" } });
  assert.equal(res.status, 200);
  const text = await res.text(); // undici が gzip を透過展開する
  assert.ok(text.includes("/__h/spclient.wg.spotify.com/bootstrap/v1"), text.slice(0, 200));
});

test("gzip 非対応クライアントには無圧縮で返す", async () => {
  const res = await fetch(`${proxy.origin}/gzipped.js`, { headers: { "accept-encoding": "identity" } });
  const text = await res.text();
  assert.equal(res.headers.get("content-encoding"), null);
  assert.ok(text.includes("/__h/spclient.wg.spotify.com/bootstrap/v1"));
});

test("Location ヘッダを書き換える（他ホスト / 同一ホスト）", async () => {
  const r1 = await fetch(`${proxy.origin}/redirect`, { redirect: "manual" });
  assert.equal(r1.status, 302);
  assert.equal(r1.headers.get("location"), abs("/__h/accounts.spotify.com/login?continue=https%3A%2F%2Fopen.spotify.com%2F"));

  // 既定上流と同一ホスト -> 素のルート相対パス
  const r2 = await fetch(`${proxy.origin}/redirect-same-host`, { redirect: "manual" });
  assert.equal(r2.status, 301);
  assert.equal(r2.headers.get("location"), abs("/collection/tracks"));

  // 別の許可ホスト -> /__h/ 形式
  const r3 = await fetch(`${proxy.origin}/redirect-other-host`, { redirect: "manual" });
  assert.equal(r3.status, 302);
  assert.equal(r3.headers.get("location"), abs("/__h/open.spotify.com/collection/tracks"));
});

test("バイナリは素通し（書き換えない・壊さない）", async () => {
  const res = await fetch(`${proxy.origin}/binary`);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.length, 4096);
  assert.equal(buf[0], 0);
  assert.equal(buf[10], 10);
  assert.equal(buf[251], 0);
});

test("204 は本文なしで返る", async () => {
  const res = await fetch(`${proxy.origin}/empty204`);
  assert.equal(res.status, 204);
  assert.equal((await res.text()).length, 0);
});

test("上限超過（content-length あり）は素通しでストリーム", async () => {
  const res = await fetch(`${proxy.origin}/big-declared`);
  const text = await res.text();
  assert.equal(text.length, 200 * 1024);
  assert.equal(text, "x".repeat(200 * 1024));
});

test("上限超過（chunked）は素通しでストリーム", async () => {
  const res = await fetch(`${proxy.origin}/big-chunked`);
  const text = await res.text();
  assert.equal(text.length, 40 * 5120);
  assert.equal(text, "y".repeat(40 * 5120));
});

test("/__h/<host>/<path> で別ホストを明示的に叩ける", async () => {
  const res = await fetch(`${proxy.origin}/__h/${MOCK_HOST}:${mockPort}/bundle.js`, {
    headers: { "accept-encoding": "identity" },
  });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(body.includes(abs("/__h/spclient.wg.spotify.com/bootstrap/v1")));
});

test("Origin / Referer / sec-fetch-site が上流オリジンに付け替わっている", async () => {
  const res = await fetch(`${proxy.origin}/echo-raw`, {
    headers: { origin: proxy.origin, referer: `${proxy.origin}/collection`, "accept-encoding": "identity" },
  });
  const data = await res.json();
  assert.equal(data.headers.origin, `http://${MOCK_HOST}:${mockPort}`);
  assert.equal(data.headers.referer, `http://${MOCK_HOST}:${mockPort}/echo-raw`);
  assert.equal(data.headers["sec-fetch-site"], "same-origin");
  assert.equal(data.headers.host, `${MOCK_HOST}:${mockPort}`);
  assert.equal(data.headers["accept-language"], "ja,en-US;q=0.9,en;q=0.8");
  // pipelining 設定を間違えると undici が "close" を送り keep-alive が効かなくなる
  assert.equal(data.headers.connection, "keep-alive");
});

test("API レスポンス JSON 内の Spotify URL が絶対 URL に書き換わる", async () => {
  const res = await fetch(`${proxy.origin}/apijson`, { headers: { "accept-encoding": "identity" } });
  const text = await res.text();
  assert.ok(text.includes(abs("/__h/api.spotify.com/v1/tracks/123")), text);
  assert.ok(text.includes(abs("/__h/i.scdn.co/image/abc")), text);
  // スラッシュエスケープ形（\/）も同じく絶対 URL になる
  const escAbs = abs("/__h/spclient.wg.spotify.com/x").replace(/\//g, "\\/");
  assert.ok(text.includes(escAbs), `${escAbs} が見つからない: ${text}`);
  // 対象外ドメインはそのまま
  assert.ok(text.includes("https://example.com/keep"), text);
  // JSON として壊れていないこと
  const parsed = JSON.parse(text);
  assert.equal(new URL(parsed.images[0].url).origin, proxy.origin, "new URL() で壊れない絶対 URL であること");
});

test("冪等性: 自オリジン付きの URL は二度書き換えない", async () => {
  // この E2E では PROXY_ALLOW_DOMAINS に 127.0.0.1 を含めている（＝自ホスト）。
  // それでも /__h/127.0.0.1:PORT/__h/... のような二重ネストが起きてはいけない。
  const res = await fetch(`${proxy.origin}/echo`, { headers: { "accept-encoding": "identity" } });
  const text = await res.text();
  assert.ok(!text.includes("__h/127.0.0.1"), `二重ネストしている: ${text.slice(0, 300)}`);
  assert.ok(!text.includes(`${proxy.origin}${proxy.origin}`), text.slice(0, 300));
});

test("Cookie が上流に転送される", async () => {
  const res = await fetch(`${proxy.origin}/echo-raw`, { headers: { cookie: "sp_dc0=AAA; foo=bar" } });
  const data = await res.json();
  assert.equal(data.headers.cookie, "sp_dc0=AAA; foo=bar");
});

test("POST ボディが壊れずに届く", async () => {
  const payload = JSON.stringify({ hello: "世界", n: 42 });
  const res = await fetch(`${proxy.origin}/post`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
  });
  const data = await res.json();
  assert.equal(data.received, payload);
  assert.equal(data.length, Buffer.byteLength(payload));
  assert.equal(data.ct, "application/json");
});

test("許可外ホストは 403", async () => {
  const res = await fetch(`${proxy.origin}/__h/evil.com/x`);
  assert.equal(res.status, 403);
  const body = await res.text();
  assert.ok(body.includes("evil.com"), body);
});

test("サブドメイン偽装ホストは 403", async () => {
  const res = await fetch(`${proxy.origin}/__h/127.0.0.1.evil.com/x`);
  assert.equal(res.status, 403);
});

test("no-op Service Worker を配信する（workbox の unhandled rejection 防止）", async () => {
  const res = await fetch(`${proxy.origin}/__spx/sw.js`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("service-worker-allowed"), "/", "scope=/ にはこのヘッダが必要");
  assert.match(res.headers.get("content-type"), /javascript/);
  const body = await res.text();
  assert.ok(body.includes("skipWaiting"), body);
  assert.ok(body.includes("fetch"), "fetch ハンドラ（passthrough）があること");
});

test("/healthz は常に認証不要、/__spx/* は設定を漏らさない", async () => {
  const h = await fetch(`${proxy.origin}/healthz`);
  assert.equal(h.status, 200);
  assert.equal(await h.text(), "ok");

  const i = await fetch(`${proxy.origin}/__spx/info`);
  assert.equal(i.status, 200);
  const info = await i.json();
  assert.equal(info.defaultUpstreamHost, `${MOCK_HOST}:${mockPort}`);
  assert.equal(info.hostPrefix, "/__h/");
  assert.equal(info.wsPrefix, "/__w/");
});

test("WebSocket が /__w/ 経由で双方向に中継される", async () => {
  const url = `ws://127.0.0.1:${proxy.port}/__w/${MOCK_HOST}:${mockPort}/ws`;
  const sock = new WS.WebSocket(url);

  const [greeting] = await once(sock, "message");
  const hello = JSON.parse(greeting.toString());
  assert.equal(hello.hello, true);
  assert.equal(hello.origin, `http://${MOCK_HOST}:${mockPort}`);

  const echoP = once(sock, "message");
  sock.send("ping- pong");
  const [echoed] = await echoP;
  assert.equal(echoed.toString(), "ping- pong");

  // バイナリ
  const binP = once(sock, "message");
  sock.send(Buffer.from([1, 2, 3, 250]));
  const [bin] = await binP;
  assert.deepEqual([...Buffer.from(bin)], [1, 2, 3, 250]);

  sock.close();
  await once(sock, "close").catch(() => {});
});

test("許可外ホストへの WebSocket upgrade は拒否される", async () => {
  const url = `ws://127.0.0.1:${proxy.port}/__w/evil.com/ws`;
  const sock = new WS.WebSocket(url);
  const err = await once(sock, "error").then((e) => e[0]).catch((e) => e);
  assert.ok(err, "エラーにならない");
  sock.terminate?.();
});

test("キャッシュ: immutable なアセットは 2 回目以降 HIT して上流を叩かない", async () => {
  const before = mock.hitCount("/cached.js");

  const r1 = await fetch(`${proxy.origin}/cached.js`, { headers: { "accept-encoding": "identity" } });
  assert.equal(r1.status, 200);
  assert.equal(r1.headers.get("x-spx-cache"), "MISS");
  const b1 = await r1.text();
  assert.ok(b1.includes("/__h/spclient.wg.spotify.com/bootstrap/v1"));
  assert.equal(mock.hitCount("/cached.js"), before + 1);

  const r2 = await fetch(`${proxy.origin}/cached.js`, { headers: { "accept-encoding": "identity" } });
  assert.equal(r2.status, 200);
  assert.equal(r2.headers.get("x-spx-cache"), "HIT");
  assert.equal(await r2.text(), b1);
  assert.equal(mock.hitCount("/cached.js"), before + 1, "キャッシュ HIT なのに上流を叩いている");

  // gzip 版も同じキャッシュエントリから返る
  const r3 = await fetch(`${proxy.origin}/cached.js`, { headers: { "accept-encoding": "gzip" } });
  assert.equal(r3.headers.get("x-spx-cache"), "HIT");
  assert.equal(r3.headers.get("content-encoding"), "gzip");
  // undici の fetch は content-encoding: gzip を透過的に展開するので text() で比較できる
  assert.equal(await r3.text(), b1);
  assert.equal(mock.hitCount("/cached.js"), before + 1);
});

test("キャッシュ: no-store は保存されない", async () => {
  const before = mock.hitCount("/nocache.js");
  const r1 = await fetch(`${proxy.origin}/nocache.js`, { headers: { "accept-encoding": "identity" } });
  assert.equal(r1.headers.get("x-spx-cache"), "MISS");
  await r1.text();
  const r2 = await fetch(`${proxy.origin}/nocache.js`, { headers: { "accept-encoding": "identity" } });
  assert.equal(r2.headers.get("x-spx-cache"), "MISS");
  await r2.text();
  assert.equal(mock.hitCount("/nocache.js"), before + 2);
});

test("キャッシュ: Set-Cookie を含むレスポンスは保存されない", async () => {
  const before = mock.hitCount("/cached-with-cookie.js");
  for (let i = 0; i < 2; i++) {
    const r = await fetch(`${proxy.origin}/cached-with-cookie.js`, { headers: { "accept-encoding": "identity" } });
    assert.equal(r.headers.get("x-spx-cache"), "MISS");
    assert.ok(r.headers.getSetCookie().length > 0);
    await r.text();
  }
  assert.equal(mock.hitCount("/cached-with-cookie.js"), before + 2);
});

test("キャッシュ: POST はキャッシュされない", async () => {
  const before = mock.hitCount("/post");
  for (let i = 0; i < 2; i++) {
    const r = await fetch(`${proxy.origin}/post`, { method: "POST", body: "abc" });
    assert.equal((await r.json()).received, "abc");
  }
  assert.equal(mock.hitCount("/post"), before + 2);
});

test("/__spx/stats でキャッシュ統計が見える", async () => {
  const res = await fetch(`${proxy.origin}/__spx/stats`);
  assert.equal(res.status, 200);
  const stats = await res.json();
  assert.equal(stats.cache.enabled, true);
  assert.ok(stats.cache.entries >= 1, JSON.stringify(stats.cache));
  assert.ok(stats.cache.hits >= 1);
  assert.ok(stats.cache.bytes > 0);
  assert.ok(typeof stats.uptimeSec === "number");
});

/* ------------------------------------------------------------------ *
 * アクセス制限 (ACCESS_TOKEN)
 * ------------------------------------------------------------------ */

test("ACCESS_TOKEN 設定時は未認証を 401 で弾き、token で通す", async (t) => {
  const secured = await startProxy(mockPort, { ACCESS_TOKEN: "s3cret", LOG_LEVEL: "error" });
  t.after(() => secured.stop());

  const denied = await fetch(`${secured.origin}/`, { headers: { "accept-encoding": "identity" } });
  assert.equal(denied.status, 401);

  // ヘルスチェックは認証不要（Render が叩くため）
  assert.equal((await fetch(`${secured.origin}/healthz`)).status, 200);

  // /__spx/* は設定を漏らすので認証必須
  for (const path of ["/__spx/info", "/__spx/stats", "/__spx/demo", "/__spx/client.js"]) {
    assert.equal((await fetch(`${secured.origin}${path}`)).status, 401, `${path} が認証なしで通った`);
    assert.equal((await fetch(`${secured.origin}${path}?token=s3cret`)).status, 200, `${path} が token 付きで通らない`);
  }

  // クエリで認証 -> Set-Cookie が返る
  const viaQuery = await fetch(`${secured.origin}/bundle.js?token=s3cret`, { headers: { "accept-encoding": "identity" } });
  assert.equal(viaQuery.status, 200);
  const cookies = viaQuery.headers.getSetCookie();
  assert.ok(cookies.some((c) => c.startsWith("spx_token=s3cret;")), JSON.stringify(cookies));
  assert.ok((await viaQuery.text()).includes("/__h/spclient.wg.spotify.com/bootstrap/v1"));

  // Cookie で認証
  const viaCookie = await fetch(`${secured.origin}/bundle.js`, {
    headers: { cookie: "spx_token=s3cret", "accept-encoding": "identity" },
  });
  assert.equal(viaCookie.status, 200);

  // Bearer で認証
  const viaBearer = await fetch(`${secured.origin}/bundle.js`, {
    headers: { authorization: "Bearer s3cret", "accept-encoding": "identity" },
  });
  assert.equal(viaBearer.status, 200);

  // 間違い token
  assert.equal((await fetch(`${secured.origin}/bundle.js?token=nope`)).status, 401);
});
