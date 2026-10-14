import { config } from "./config.js";
import { toProxyPath } from "./hosts.js";
import { rewriteText } from "./rewrite.js";

/* ------------------------------------------------------------------ *
 * リクエスト（クライアント -> 上流）
 * ------------------------------------------------------------------ */

/** 上流にそのまま渡すと壊れるヘッダ */
const DROP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding", // undici が設定する。二重指定でデコード不能になるのを防ぐ
  "keep-alive",
  "proxy-connection",
  "upgrade",
  "origin", // 下で上流オリジンに書き換える
  "referer", // 下で上流オリジンに書き換える
]);

/**
 * 上流へ送るヘッダを構築する。
 *  - Origin / Referer をこのプロキシのオリジンから上流オリジンへ付け替える
 *    （Spotify の API は Origin を見るため、素通しだと CORS / 403 になる）
 *  - Cookie はこのオリジン宛のものをそのまま転送する
 *
 * @param {string} authority 上流の host[:port]
 */
export function buildUpstreamHeaders(req, authority, targetPath) {
  const headers = new Headers();
  const upstreamOrigin = `${config.upstreamScheme}://${authority}`;

  for (const [name, value] of Object.entries(req.headers)) {
    const key = name.toLowerCase();
    if (DROP_REQUEST_HEADERS.has(key)) continue;
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) {
      headers.append(name, v);
    }
  }

  // UA: 固定指定があればそれ、無ければクライアントのもの（既にコピー済み）
  if (config.userAgent) headers.set("user-agent", config.userAgent);
  if (!headers.has("user-agent")) {
    headers.set(
      "user-agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    );
  }

  headers.set("accept-language", config.acceptLanguage);
  headers.set("origin", upstreamOrigin);
  headers.set("referer", `${upstreamOrigin}${targetPath}`);
  headers.set("sec-fetch-site", "same-origin");

  return headers;
}

/* ------------------------------------------------------------------ *
 * レスポンス（上流 -> クライアント）
 * ------------------------------------------------------------------ */

/**
 * クライアントに返すと問題を起こすヘッダ。
 *  - CSP / X-Frame-Options / CORP 系: そのままだと書き換え後のページが動かなくなる
 *  - content-encoding / content-length: undici が解凍済み & 書き換えで長さが変わる
 *  - permissions-policy: encrypted-media 等を制限される可能性があるため落とす
 */
const DROP_RESPONSE_HEADERS = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "strict-transport-security",
  "public-key-pins",
  "public-key-pins-report-only",
  "expect-ct",
  "x-frame-options",
  "cross-origin-opener-policy",
  "cross-origin-opener-policy-report-only",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "permissions-policy",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "alt-svc",
  "nel",
  "report-to",
  "timing-allow-origin",
  "server",
  "via",
  "set-cookie", // rewriteSetCookie() で別途処理
  "location", // rewriteLocationHeader() で別途処理
  // 注意: "link" は落とさない。sanitizeResponseHeaders() 内で rewriteText() して残す
]);

/**
 * 上流レスポンスヘッダを [name, value] の配列に変換する（writeHead にそのまま渡せる形）。
 */
export function sanitizeResponseHeaders(upstreamRes) {
  const out = [];
  for (const [name, value] of upstreamRes.headers.entries()) {
    const key = name.toLowerCase();
    if (DROP_RESPONSE_HEADERS.has(key)) continue;
    if (key === "link") {
      out.push([name, rewriteText(value)]);
      continue;
    }
    out.push([name, value]);
  }
  return out;
}

/**
 * Location ヘッダをこのプロキシのパスに書き換える。
 * プロキシ対象外のドメインへ向かうリダイレクトはそのまま返す。
 */
export function rewriteLocationHeader(value) {
  if (!value) return value;
  if (/^(https?:)?\/\//i.test(value)) {
    const rewritten = toProxyPath(value.startsWith("//") ? `https:${value}` : value);
    if (rewritten) return rewritten;
    return value;
  }
  // 相対 / ルート相対リダイレクトはそのまま
  return value;
}

/**
 * Set-Cookie をこのオリジンで有効になるように書き換える。
 *  - Domain= を除去（プロキシのオリジンに紐づける）
 *  - Path= をルートに（/__h/... 配下でも送られるように）
 *  - iframe 埋め込みでも機能するよう SameSite=None; Secure に
 *  - __Host- / __Secure- プレフィックスは要件と衝突するため剥がす
 */
export function rewriteSetCookies(upstreamRes) {
  let raw;
  try {
    raw = upstreamRes.headers.getSetCookie ? upstreamRes.headers.getSetCookie() : [];
  } catch {
    raw = [];
  }
  if (!raw || raw.length === 0) {
    const single = upstreamRes.headers.get("set-cookie");
    raw = single ? [single] : [];
  }

  const out = [];
  for (const cookie of raw) {
    if (!cookie) continue;
    const parts = cookie
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 0) continue;

    // 名前=値 部分を整形
    let nameValue = parts[0];
    nameValue = nameValue.replace(/^__Host-/i, "").replace(/^__Secure-/i, "");
    parts[0] = nameValue;

    const kept = [parts[0]];
    let hasSecure = false;
    for (const part of parts.slice(1)) {
      const lower = part.toLowerCase();
      if (lower.startsWith("domain=")) continue; // 破棄
      if (lower.startsWith("samesite")) continue; // 後で付け直す
      if (lower.startsWith("path=")) {
        kept.push("Path=/");
        continue;
      }
      if (lower === "secure") hasSecure = true;
      kept.push(part);
    }
    const lowerKept = kept.map((p) => p.toLowerCase());
    if (!lowerKept.includes("path=/")) kept.push("Path=/");
    kept.push(`SameSite=${config.allowEmbed ? "None" : "Lax"}`);
    // iframe 埋め込みでは SameSite=None に Secure が必須
    if (config.allowEmbed) hasSecure = true;
    if (hasSecure && !lowerKept.includes("secure")) kept.push("Secure");

    out.push(kept.join("; "));
  }
  return out;
}

/**
 * このプロキシ自身が付けるヘッダ（CORS / フレーム許可など）。
 */
export function extraResponseHeaders(req) {
  const out = [];
  const origin = req.headers.origin;

  if (config.corsOrigins) {
    const allowed = config.corsOrigins.split(",").map((s) => s.trim());
    if (allowed.includes("*") || (origin && allowed.includes(origin))) {
      out.push(["access-control-allow-origin", origin && !allowed.includes("*") ? origin : "*"]);
      out.push(["access-control-allow-credentials", "true"]);
      out.push(["access-control-allow-headers", "*"]);
      out.push(["access-control-allow-methods", "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS"]);
      out.push(["access-control-max-age", "86400"]);
    }
  }

  if (config.allowEmbed && config.frameAncestors) {
    out.push(["content-security-policy", `frame-ancestors ${config.frameAncestors}`]);
  }

  return out;
}
