import http from "node:http";
import { Readable } from "node:stream";
import { once } from "node:events";
import { promisify } from "node:util";
import zlib from "node:zlib";

import { config, log } from "./lib/config.js";
import { parseProxyTarget, buildUpstreamUrl, buildAuthority, isProxyableHost } from "./lib/hosts.js";
import {
  shouldRewrite,
  mediaType,
  rewriteText,
  rewriteInlineBase64Scripts,
  stripIntegrityAndCors,
  stripMetaCsp,
} from "./lib/rewrite.js";
import { buildClientScript, buildDemoPage } from "./lib/client.js";
import { injectClientScript } from "./lib/inject.js";
import {
  buildUpstreamHeaders,
  sanitizeResponseHeaders,
  rewriteLocationHeader,
  rewriteSetCookies,
  extraResponseHeaders,
} from "./lib/headers.js";
import { attachWebSocketProxy } from "./lib/ws-proxy.js";
import { ResponseCache, parseCacheability } from "./lib/cache.js";

/* ------------------------------------------------------------------ *
 * HTTP クライアント（undici があればそれ、無ければ Node 標準の fetch）
 * ------------------------------------------------------------------ */

let fetchImpl = globalThis.fetch;
try {
  const undici = await import("undici");
  fetchImpl = undici.fetch;
  undici.setGlobalDispatcher(
    new undici.Agent({
      headersTimeout: config.upstreamTimeoutMs,
      bodyTimeout: 0, // 音声ストリームなどを途中で切らない
      connect: { timeout: 15_000 },
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 600_000,
      connections: 256,
      // pipelining: 0 だと undici が "connection: close" を送り keep-alive が無効化される。
      // 1 が「パイプラインしない keep-alive」で安全かつ最速。
      pipelining: 1,
    }),
  );
  log.info("undici を HTTP クライアントとして使用します");
} catch {
  log.warn("undici が見つからないため Node 標準の fetch を使います（npm install 推奨）");
}

let wsDeps = {};
try {
  wsDeps = await import("ws");
} catch {
  /* WebSocket プロキシは無効 */
}

const CLIENT_SCRIPT = buildClientScript();
const DEMO_PAGE = buildDemoPage();
const cache = new ResponseCache();
const gzipAsync = promisify(zlib.gzip);

/* ------------------------------------------------------------------ *
 * ユーティリティ
 * ------------------------------------------------------------------ */

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(buf.length),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(buf);
}

function errorPage(res, status, title, detail) {
  const body = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:14px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Hiragino Sans","Noto Sans JP",sans-serif;
background:#121212;color:#eaeaea;margin:0;padding:48px 20px}
.card{max-width:680px;margin:0 auto;background:#1e1e1e;border:1px solid #2e2e2e;border-radius:12px;padding:28px 30px}
h1{font-size:19px;margin:0 0 10px}code{background:#2a2a2a;padding:2px 6px;border-radius:4px;font-size:12.5px}
pre{background:#181818;border:1px solid #2a2a2a;border-radius:8px;padding:12px;overflow:auto;font-size:12px;color:#b3b3b3}
a{color:#1ed760}</style></head><body><div class="card">
<h1>${title}</h1><pre>${String(detail).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c])}</pre>
<p><a href="/">← Spotify Web Player に戻る</a></p></div></body></html>`;
  send(res, status, body, { "content-type": "text/html; charset=utf-8" });
}

/** ルーティング段で res.setHeader した認証 Cookie を writeHead 用に引き継ぐ */
function mergeSetHeaderCookies(res, pairs) {
  if (!res.getHeaderNames().includes("set-cookie")) return;
  for (const v of [].concat(res.getHeader("set-cookie") || [])) pairs.push(["set-cookie", v]);
}

/** 本文バッファを、クライアントの accept-encoding に応じて gzip / 生 で返す */
function endWithBuffer(res, status, pairs, raw, gz, useGzip) {
  if (useGzip && gz) {
    pairs.push(["content-encoding", "gzip"], ["vary", "Accept-Encoding"], ["content-length", String(gz.length)]);
    res.writeHead(status, pairs.flat());
    res.end(gz);
    return;
  }
  pairs.push(["content-length", String(raw.length)]);
  res.writeHead(status, pairs.flat());
  res.end(raw);
}

/**
 * 書き換え後の URL に埋め込む「自オリジン」を決定する。
 *
 * 絶対 URL で書き換える必要がある理由:
 * Spotify のバンドルには
 *   let dI = "<URL>", dk = new URL(dI).origin;
 * のような**モジュールトップレベルの new URL()** があり、
 * ルート相対 ("/__h/...") に書き換えると `TypeError: Invalid URL` で
 * webpack モジュールの評価自体が失敗し、アプリが
 * 「エラーが発生したようです」を出す。
 */
function getPublicBase(req) {
  if (config.publicBaseUrl) return config.publicBaseUrl.replace(/\/+$/, "");
  const fwdHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const host = fwdHost || String(req.headers.host || "").trim();
  if (!host) return "";
  return `${isSecureRequest(req) ? "https" : "http"}://${host}`;
}

/**
 * no-op Service Worker。
 * 上流の SW はスコープがこのオリジン配下に来ると壊れるので登録させたくないが、
 * register() を reject すると workbox-window が unhandled rejection を起こす。
 *  そこで「何もしない SW」を自前で配信して、登録自体は成功させる。
 */
const NOOP_SERVICE_WORKER = `/* no-op service worker served by spotify-reverse-proxy */
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", function () { /* passthrough */ });
self.addEventListener("message", function (e) {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});
`;

/** リクエストが HTTPS かどうか（Render / Railway は x-forwarded-proto を付ける） */
function isSecureRequest(req) {
  const xf = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  if (xf) return xf === "https";
  return false; // ローカルの http 直アクセス
}

/** gzip する価値があるか */
function wantsGzip(req) {
  const ae = String(req.headers["accept-encoding"] || "").toLowerCase();
  return ae.includes("gzip");
}

const COMPRESSIBLE = /^(text\/|application\/(javascript|json|xml|manifest)|image\/svg)/;

/* ------------------------------------------------------------------ *
 * アクセス制限
 * ------------------------------------------------------------------ */

function isAuthorized(req, url) {
  if (!config.accessToken) return true;

  const qIndex = url.indexOf("?");
  const query = qIndex === -1 ? "" : url.slice(qIndex + 1);
  const params = new URLSearchParams(query);
  const fromQuery = params.get("token");
  const authHeader = req.headers.authorization || "";
  const fromHeader = /^Bearer\s+(.+)$/i.test(authHeader) ? authHeader.replace(/^Bearer\s+/i, "") : "";
  const fromCookie = parseCookies(req.headers.cookie).spx_token || "";

  const token = fromQuery || fromHeader || fromCookie;
  return token === config.accessToken;
}

/* ------------------------------------------------------------------ *
 * プロキシ本体
 * ------------------------------------------------------------------ */

async function proxy(req, res, target) {
  const authority = buildAuthority(target.host, target.port);
  const upstreamUrl = buildUpstreamUrl(target.host, target.port, target.path, target.search);
  // 書き換え後の URL に埋め込む自オリジン（ホストごとに本文が変わるのでキャッシュキーにも含める）
  const base = getPublicBase(req);

  /* ---- キャッシュヒット（GET のみ）: 上流に問い合わせず即返す ---- */
  const cacheKey = req.method === "GET" ? `${base}|${upstreamUrl}` : null;
  if (cacheKey) {
    const hit = cache.get(cacheKey);
    if (hit) {
      const pairs = hit.headerPairs.slice();
      mergeSetHeaderCookies(res, pairs);
      pairs.push(["x-spx-cache", "HIT"]);
      return endWithBuffer(res, hit.status, pairs, hit.raw, hit.gz, wantsGzip(req));
    }
  }

  const controller = new AbortController();

  // ヘッダ受信タイムアウト（本文のストリーミングは制限しない）
  const timer = setTimeout(() => controller.abort(new Error("upstream timeout")), config.upstreamTimeoutMs);

  const hasBody = !["GET", "HEAD"].includes(req.method.toUpperCase());
  const init = {
    method: req.method,
    headers: buildUpstreamHeaders(req, authority, target.path),
    redirect: "manual",
    signal: controller.signal,
  };
  if (hasBody) {
    init.body = Readable.toWeb(req);
    init.duplex = "half";
  }

  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  let upstream;
  try {
    upstream = await fetchImpl(upstreamUrl, init);
  } catch (err) {
    clearTimeout(timer);
    if (res.headersSent || res.writableEnded) return res.destroy();
    log.warn(`upstream fetch failed: ${upstreamUrl} -> ${err.message}`);
    return errorPage(
      res,
      502,
      "上流サーバーに接続できませんでした",
      `target : ${upstreamUrl}\nerror  : ${err.name}: ${err.message}\n\n` +
        "考えられる原因:\n" +
        " - Render のアウトバウンド IP が Spotify 側 (Akamai) にブロックされている\n" +
        " - 上流の DNS 解決失敗 / タイムアウト\n" +
        " - ネットワークの一時的な不通",
    );
  }
  clearTimeout(timer);

  /* ---- レスポンスヘッダの組み立て ---- */
  const headerPairs = sanitizeResponseHeaders(upstream, base);

  const location = upstream.headers.get("location");
  if (location) {
    const rewritten = rewriteLocationHeader(location, base);
    if (rewritten) headerPairs.push(["location", rewritten]);
  }

  for (const cookie of rewriteSetCookies(upstream)) {
    headerPairs.push(["set-cookie", cookie]);
  }

  headerPairs.push(...extraResponseHeaders(req));
  if (config.debugHeaders) headerPairs.push(["x-spx-upstream", upstreamUrl]);

  const contentType = upstream.headers.get("content-type") || "";
  const isText = shouldRewrite(contentType);
  const isHtml = mediaType(contentType) === "text/html";
  const noBody =
    req.method === "HEAD" ||
    upstream.status === 204 ||
    upstream.status === 205 ||
    upstream.status === 304 ||
    (upstream.status >= 300 && upstream.status < 400);

  /* ---- 本文なし（リダイレクト / 204 など） ---- */
  if (noBody || !upstream.body) {
    res.writeHead(upstream.status, headerPairs.flat());
    res.end();
    upstream.body?.cancel?.();
    return;
  }

  const declaredLength = Number(upstream.headers.get("content-length") || 0);
  const tooLargeUpfront = isText && declaredLength > config.maxRewriteBytes;

  /* ---- バイナリ、および大きすぎるテキストはストリームで素通し ---- */
  if (!isText || tooLargeUpfront) {
    if (tooLargeUpfront) log.warn("content too large to rewrite, streaming raw:", upstreamUrl, declaredLength);
    res.writeHead(upstream.status, headerPairs.flat());
    const nodeStream = Readable.fromWeb(upstream.body);
    nodeStream.on("error", (err) => {
      log.debug("stream error:", upstreamUrl, err.message);
      res.destroy();
    });
    res.on("close", () => nodeStream.destroy());
    nodeStream.pipe(res);
    return;
  }

  /* ---- テキストは読み込んで書き換える ---- */
  const reader = upstream.body.getReader();
  const chunks = [];
  let total = 0;
  let overflow = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      chunks.push(Buffer.from(value));
      if (total > config.maxRewriteBytes) {
        overflow = true;
        break;
      }
    }
  } catch (err) {
    log.warn("body read error:", upstreamUrl, err.message);
    if (!res.headersSent) errorPage(res, 502, "上流レスポンスの読み込みに失敗しました", `${upstreamUrl}\n${err.message}`);
    else res.destroy();
    return;
  }

  /* ---- 読み込み中に上限を超えた: 書き換えを諦めて素通し ---- */
  if (overflow) {
    log.warn("body exceeded MAX_REWRITE_BYTES while reading, streaming raw:", upstreamUrl, total);
    res.writeHead(upstream.status, headerPairs.flat());
    try {
      res.write(Buffer.concat(chunks));
      for (;;) {
        if (res.writableNeedDrain) await once(res, "drain");
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } catch (err) {
      log.debug("overflow stream error:", err.message);
      res.destroy();
    }
    return;
  }

  let body = Buffer.concat(chunks).toString("utf8");

  if (isHtml) {
    body = stripMetaCsp(body);
    body = stripIntegrityAndCors(body);
    // base64 で埋め込まれた JSON（#appServerConfig / #__CDN_FILE_URLS__ など）を
    // デコードして書き換え、再エンコードする
    body = rewriteInlineBase64Scripts(body, base);
  }
  body = rewriteText(body, base);
  if (isHtml) {
    body = injectClientScript(body, CLIENT_SCRIPT);
  }

  const buf = Buffer.from(body, "utf8");

  // 本文を書き換えたので ETag / Last-Modified は無効化（キャッシュ不整合を防ぐ）
  const finalPairs = headerPairs.filter(([k]) => {
    const key = k.toLowerCase();
    return key !== "etag" && key !== "last-modified";
  });
  mergeSetHeaderCookies(res, finalPairs);

  /* ---- キャッシュ判定と圧縮 ---- */
  const hasSetCookie = finalPairs.some(([k]) => k.toLowerCase() === "set-cookie");
  const { cacheable, maxAgeSec } = parseCacheability(
    upstream.headers.get("cache-control"),
    upstream.status,
    hasSetCookie,
  );
  const willCache = Boolean(cacheKey) && cache.enabled && cacheable && buf.length <= config.cacheMaxBytes;

  const compressible = buf.length > 1024 && COMPRESSIBLE.test(mediaType(contentType) || "text/plain");
  let gz = null;
  if (compressible && (wantsGzip(req) || willCache)) {
    try {
      const candidate = await gzipAsync(buf, { level: 6 });
      if (candidate.length < buf.length) gz = candidate;
    } catch (err) {
      log.debug("gzip failed:", err.message);
    }
  }

  if (willCache) {
    cache.set(
      cacheKey,
      { status: upstream.status, headerPairs: finalPairs.slice(), raw: buf, gz, contentType },
      { size: buf.length + (gz ? gz.length : 0), maxAgeSec },
    );
  }

  finalPairs.push(["x-spx-cache", cache.enabled && cacheKey ? "MISS" : "BYPASS"]);
  endWithBuffer(res, upstream.status, finalPairs, buf, gz, wantsGzip(req));
}

/* ------------------------------------------------------------------ *
 * ルーティング
 * ------------------------------------------------------------------ */

function serverInfo() {
  return {
    service: "spotify-reverse-proxy",
    version: "1.0.0",
    defaultUpstreamHost: config.defaultUpstreamHost,
    hostPrefix: config.hostPrefix,
    wsPrefix: config.wsPrefix,
    allowDomains: config.allowDomains,
    auth: config.accessToken ? "enabled" : "disabled",
    embed: config.allowEmbed,
    routes: {
      "/": "open.spotify.com (Web Player)",
      "/<path>": "open.spotify.com/<path> (ルート相対 URL の受け皿)",
      "/__h/<host>/<path>": "指定ホストへのプロキシ（許可ドメインのみ）",
      "/__w/<host>/<path>": "WebSocket プロキシ",
      "/__spx/info": "この JSON",
      "/__spx/stats": "キャッシュ統計 / メモリ使用量",
      "/__spx/demo": "iframe 表示デモページ",
      "/__spx/sw.js": "no-op Service Worker（workbox の登録を成功させるため）",
      "/__spx/client.js": "注入されるランタイムパッチ",
      "/healthz": "Render ヘルスチェック",
    },
  };
}

const httpServer = http.createServer(async (req, res) => {
  const url = req.url || "/";
  const pathname = url.split("?")[0];

  // --- ヘルスチェック（認証不要。Render が叩く） ---
  if (pathname === "/healthz" || pathname === "/readyz") {
    return send(res, 200, "ok");
  }

  // --- アクセス制限 ---
  if (!isAuthorized(req, url)) {
    res.writeHead(401, { "content-type": "text/plain; charset=utf-8", "www-authenticate": 'Bearer realm="spx"' });
    return res.end(
      "401 Unauthorized\n\n" +
        "このプロキシには ACCESS_TOKEN が設定されています。\n" +
        "  ?token=XXXX を付ける / Authorization: Bearer XXXX を送る / Cookie spx_token=XXXX のいずれかで認証してください。\n",
    );
  }

  // token クエリで来た場合は Cookie に落として以降のリクエストを通す
  if (config.accessToken) {
    const q = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
    const token = new URLSearchParams(q).get("token");
    if (token === config.accessToken && !parseCookies(req.headers.cookie).spx_token) {
      // ローカル http では Secure を付けると Cookie が保存されないので出し分ける
      const secure = isSecureRequest(req);
      const sameSite = secure && config.allowEmbed ? "None" : "Lax";
      res.setHeader(
        "set-cookie",
        `spx_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=${sameSite}${secure ? "; Secure" : ""}`,
      );
    }
  }

  // --- 制御エンドポイント（認証後。設定情報の漏洩を防ぐ） ---
  if (pathname === `${config.controlPrefix}info`) {
    return send(res, 200, JSON.stringify(serverInfo(), null, 2), { "content-type": "application/json; charset=utf-8" });
  }
  if (pathname === `${config.controlPrefix}client.js`) {
    return send(res, 200, CLIENT_SCRIPT, { "content-type": "application/javascript; charset=utf-8" });
  }
  if (pathname === `${config.controlPrefix}sw.js`) {
    // Service-Worker-Allowed: / が無いと scope=/ での登録を拒否される
    return send(res, 200, NOOP_SERVICE_WORKER, {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-cache",
      "service-worker-allowed": "/",
    });
  }
  if (pathname === `${config.controlPrefix}demo`) {
    return send(res, 200, DEMO_PAGE, { "content-type": "text/html; charset=utf-8" });
  }
  if (pathname === `${config.controlPrefix}stats`) {
    return send(
      res,
      200,
      JSON.stringify({ cache: cache.stats, uptimeSec: Math.round(process.uptime()), memory: process.memoryUsage() }, null, 2),
      { "content-type": "application/json; charset=utf-8" },
    );
  }
  if (pathname === `${config.controlPrefix}cache` && req.method === "DELETE") {
    cache.clear();
    return send(res, 200, "cache cleared\n");
  }
  if (pathname === "/favicon.ico") {
    // 上流の favicon を取りに行く無駄を省く
    res.writeHead(204);
    return res.end();
  }

  // --- CORS プリフライト ---
  if (req.method === "OPTIONS" && req.headers["access-control-request-method"]) {
    const headers = extraResponseHeaders(req).flat();
    res.writeHead(204, ["access-control-max-age", "86400", ...headers]);
    return res.end();
  }

  // --- プロキシ ---
  const target = parseProxyTarget(url);
  if (!target) {
    return errorPage(
      res,
      403,
      "このホストはプロキシできません",
      `request : ${url}\n\nこのプロキシは許可されたドメイン（${config.allowDomains.join(", ")}）と\nそのサブドメインだけを対象にしています。`,
    );
  }
  if (target.error === "host_not_allowed") {
    return errorPage(
      res,
      403,
      "このホストはプロキシできません",
      `host    : ${target.host}\nrequest : ${url}\n\n許可ドメイン: ${config.allowDomains.join(", ")}\n追加するには環境変数 PROXY_ALLOW_DOMAINS を設定してください。`,
    );
  }
  if (target.error) {
    return errorPage(res, 400, "リクエストを解釈できません", `request : ${url}\nerror   : ${target.error}`);
  }

  log.debug(`${req.method} ${url} -> https://${target.host}${target.path}${target.search}`);

  try {
    await proxy(req, res, target);
  } catch (err) {
    log.error("proxy handler error:", err);
    if (!res.headersSent) errorPage(res, 500, "プロキシ処理中にエラーが発生しました", `${err.stack || err.message}`);
    else res.destroy();
  }
});

httpServer.headersTimeout = 60_000;
httpServer.requestTimeout = 0; // 大きなアップロード / 長時間リクエストを許容
httpServer.keepAliveTimeout = 65_000;
httpServer.maxRequestsPerSocket = 0;

const wsEnabled = attachWebSocketProxy(httpServer, wsDeps);

httpServer.listen(config.port, config.host, () => {
  const addr = httpServer.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : config.port;
  log.info(`spotify-reverse-proxy listening on http://${config.host}:${actualPort}`);
  log.info(`default upstream : ${config.upstreamScheme}://${config.defaultUpstreamHost}/`);
  log.info(`host prefix      : ${config.hostPrefix}<host>/<path>`);
  log.info(`websocket proxy  : ${wsEnabled ? `enabled (${config.wsPrefix}<host>/<path>)` : "DISABLED"}`);
  log.info(`auth             : ${config.accessToken ? "enabled" : "disabled"}`);
  if (!isProxyableHost(config.defaultUpstreamHost.split(":")[0])) {
    log.error(`DEFAULT_UPSTREAM_HOST (${config.defaultUpstreamHost}) が許可ドメインに含まれていません！`);
  }
  // PaaS が公開ドメインを環境変数で教えてくれるので、アクセス先をログに出す
  const publicUrl = (() => {
    // Railway: RAILWAY_PUBLIC_DOMAIN (スキーム無し) / Render: RENDER_EXTERNAL_URL (完全 URL)
    if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
    if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL.replace(/\/$/, "");
    if (process.env.FLY_APP_NAME) return `https://${process.env.FLY_APP_NAME}.fly.dev`;
    return "";
  })();
  if (publicUrl) {
    log.info(`public URL       : ${publicUrl}`);
    log.info(`  -> ${publicUrl}/            (Spotify Web Player)`);
    log.info(`  -> ${publicUrl}/__spx/demo  (iframe 表示デモ)`);
    log.info(`  -> ${publicUrl}/__spx/info  (設定)`);
    if (process.env.RAILWAY_ENVIRONMENT) {
      log.info(`railway env      : ${process.env.RAILWAY_ENVIRONMENT}`);
    }
  }
  if (!config.accessToken && publicUrl) {
    log.error("ACCESS_TOKEN が未設定です。公開 URL は誰でも使える Spotify へのオープンプロキシになります。必ず設定してください。");
  }

  // 親プロセス（テスト / オーケストレータ）向けの準備完了シグナル
  process.stdout.write(`SPX_READY ${actualPort}\n`);
  if (process.send) process.send({ event: "ready", port: actualPort });
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    log.info(`${sig} received, shutting down`);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8_000).unref();
  });
}
