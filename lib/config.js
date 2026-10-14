/**
 * 環境変数から設定を組み立てる。
 * Render のダッシュボード（Environment タブ）または render.yaml で指定する。
 */

const env = process.env;

function bool(value, fallback = false) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function list(value, fallback) {
  if (!value) return fallback;
  return value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * プロキシを許可する登録可能ドメイン（registrable domain）の一覧。
 * これらのドメインおよび全サブドメインだけが中継される（＝オープンプロキシ化を防ぐ）。
 */
export const DEFAULT_ALLOW_DOMAINS = [
  "spotify.com",
  "scdn.co",
  "pscdn.co",
  "spotifycdn.com",
  "spotify.net",
  "spotilocal.com",
  "spotify.map.fastly.net",
  // 音声ストリーム / CDN 配信元
  "akamaized.net",
  "akamaihd.net",
  "cloudfront.net",
];

export const config = {
  port: Number(env.PORT || 10000),
  host: env.HOST || "0.0.0.0",

  /** デフォルトルート（`/` や `/static/...`）を中継する先ホスト */
  defaultUpstreamHost: (env.DEFAULT_UPSTREAM_HOST || "open.spotify.com").toLowerCase(),

  /** 上流への接続スキーム（通常 https。ローカル検証用のみ http） */
  upstreamScheme: (env.UPSTREAM_SCHEME || "https").toLowerCase() === "http" ? "http" : "https",

  /** URL スキーム */
  hostPrefix: env.HOST_PREFIX || "/__h/",
  wsPrefix: env.WS_PREFIX || "/__w/",
  controlPrefix: "/__spx/",

  /** プロキシ許可ドメイン */
  allowDomains: list(env.PROXY_ALLOW_DOMAINS, DEFAULT_ALLOW_DOMAINS),

  /** 本文を書き換える上限バイト数（これを超えたテキストは素通し） */
  maxRewriteBytes: Number(env.MAX_REWRITE_BYTES || 64 * 1024 * 1024),

  /** 書き換え済みレスポンスのインメモリ LRU キャッシュ上限（0 で無効化） */
  cacheMaxBytes: Number(env.CACHE_MAX_BYTES ?? 64 * 1024 * 1024),
  cacheMaxEntries: Number(env.CACHE_MAX_ENTRIES || 400),
  cacheMaxTtlSec: Number(env.CACHE_MAX_TTL_SEC || 3600),

  /**
   * 書き換え後の URL に埋め込む自オリジン（例 "https://my-app.up.railway.app"）。
   * 空ならリクエストの Host / x-forwarded-host / x-forwarded-proto から自動判定する。
   * 前面に別のプロキシがあり Host が実公開ドメインにならない場合のみ設定する。
   */
  publicBaseUrl: (env.PUBLIC_BASE_URL || "").replace(/\/+$/, ""),

  /** アップストリームのヘッダ受信タイムアウト (ms) */
  upstreamTimeoutMs: Number(env.UPSTREAM_TIMEOUT_MS || 30_000),

  /**
   * アクセス制限トークン。空なら誰でも利用可。
   * 公開 URL に置くと Spotify への踏み台にされるので、本番では設定を推奨。
   * 渡し方: ?token=XXX / Authorization: Bearer XXX / Cookie: spx_token=XXX
   */
  accessToken: env.ACCESS_TOKEN || "",

  /** iframe 埋め込みを許可するか（X-Frame-Options / frame-ancestors を制御） */
  allowEmbed: bool(env.ALLOW_EMBED, true),
  frameAncestors: env.FRAME_ANCESTORS || "*",

  /** CORS を許可するオリジン（カンマ区切り、`*` で全許可）。既定は無効 */
  corsOrigins: env.CORS_ORIGINS || "",

  /** ブラウザに送る User-Agent を固定するか（空ならクライアントの UA を転送） */
  userAgent: env.USER_AGENT || "",

  /** 上流へ送る Accept-Language */
  acceptLanguage: env.ACCEPT_LANGUAGE || "ja,en-US;q=0.9,en;q=0.8",

  logLevel: (env.LOG_LEVEL || "info").toLowerCase(),
  debugHeaders: bool(env.DEBUG_HEADERS, false),
};

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

export const log = {
  error: (...a) => console.error(new Date().toISOString(), "[error]", ...a),
  warn: (...a) => console.warn(new Date().toISOString(), "[warn]", ...a),
  info: (...a) => (LEVELS[config.logLevel] >= 2 ? console.log(new Date().toISOString(), "[info]", ...a) : undefined),
  debug: (...a) => (LEVELS[config.logLevel] >= 3 ? console.log(new Date().toISOString(), "[debug]", ...a) : undefined),
};
