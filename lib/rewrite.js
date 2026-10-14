import { config } from "./config.js";

/* ------------------------------------------------------------------ *
 * 書き換え対象コンテンツタイプ
 * ------------------------------------------------------------------ */

const REWRITABLE_TYPES = new Set([
  "text/html",
  "text/css",
  "text/plain",
  "text/javascript",
  "text/ecmascript",
  "text/xml",
  "application/javascript",
  "application/x-javascript",
  "application/ecmascript",
  "application/json",
  "application/xml",
  "application/manifest+json",
  "application/rss+xml",
  "application/atom+xml",
  "application/ld+json",
  "image/svg+xml",
]);

/** Content-Type から media type だけ取り出す */
export function mediaType(contentType) {
  if (!contentType) return "";
  return contentType.split(";")[0].trim().toLowerCase();
}

/** 本文を文字列として書き換えるべきかどうか */
export function shouldRewrite(contentType) {
  const t = mediaType(contentType);
  if (!t) return false;
  if (REWRITABLE_TYPES.has(t)) return true;
  // application/vnd.api+json 等の "+json" / "+xml" サフィックス
  return /\+(json|xml)$/.test(t);
}

/* ------------------------------------------------------------------ *
 * ホストマッチ用正規表現
 * ------------------------------------------------------------------ */

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 許可ドメイン一覧からホスト部分の正規表現ソースを作る */
function buildHostSource(allowDomains) {
  const suffixes = allowDomains
    .map(escapeRegExp)
    // 長いものを先に試す（spotify.map.fastly.net が fastly.net より優先されるように）
    .sort((a, b) => b.length - a.length)
    .join("|");
  // ラベル列 + 登録可能ドメイン。
  // 末尾の否定先読みで "open.spotify.com.evil.com" のような
  // 長いホスト名の途中マッチ（＝任意ホストへの中継）を防ぐ。
  return `(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)*(?:${suffixes})(?![a-z0-9._-])`;
}

const HOST = buildHostSource(config.allowDomains);

/**
 * `blob:https://...` / `data:text/html,https://...` のような
 * 入れ子スキームの内側を書き換えないための固定長否定後読み。
 * （可変長後読みより高速で、ブラウザ互換性の心配もない）
 */
const NOT_NESTED = `(?<!blob:)(?<!data:)(?<!filesystem:)(?<!view-source:)(?<!javascript:)`;

/**
 * 書き換えルール。
 * 上流の HTML / CSS / JS / JSON には Spotify の URL が
 * 「生の形」「JSON エスケープ形 (\/\/)」 「Unicode エスケープ形 (\u002F)」で現れるため、
 * 区切り文字ごとにルールを用意する。
 */
const RULES = [
  // --- 生 (raw) ---
  { re: new RegExp(`${NOT_NESTED}\\bwss?://(${HOST})`, "gi"), out: config.wsPrefix, esc: "raw" },
  { re: new RegExp(`${NOT_NESTED}\\bhttps?://(${HOST})`, "gi"), out: config.hostPrefix, esc: "raw" },
  { re: new RegExp(`(?<![:/\\w.-])//(${HOST})`, "gi"), out: config.hostPrefix, esc: "raw" },

  // --- JSON / JS 文字列内のエスケープ: https:\/\/open.spotify.com ---
  { re: new RegExp(`${NOT_NESTED}\\bwss?:\\\\/\\\\/(${HOST})`, "gi"), out: config.wsPrefix, esc: "slash" },
  { re: new RegExp(`${NOT_NESTED}\\bhttps?:\\\\/\\\\/(${HOST})`, "gi"), out: config.hostPrefix, esc: "slash" },
  { re: new RegExp(`(?<![:\\\\/\\w.-])\\\\/\\\\/(${HOST})`, "gi"), out: config.hostPrefix, esc: "slash" },

  // --- Unicode エスケープ: https:\u002F\u002Fopen.spotify.com ---
  { re: new RegExp(`${NOT_NESTED}\\\\+u002F\\\\+u002F(${HOST})`, "gi"), out: config.hostPrefix, esc: "unicode" },
];

/** エスケープ形式に合わせて出力プレフィックスを整形する */
function formatPrefix(prefix, esc) {
  if (esc === "slash") return prefix.replace(/\//g, "\\/");
  if (esc === "unicode") return "\\u002F" + prefix.slice(1).replace(/\//g, "\\u002F");
  return prefix;
}

/**
 * テキスト本文中の Spotify 系絶対 URL を、このプロキシのパスに書き換える。
 *
 *   https://i.scdn.co/image/abc      ->  /__h/i.scdn.co/image/abc
 *   https:\/\/spclient.wg.spotify.com ->  \/__h\/spclient.wg.spotify.com
 *   wss://gae2-dealer.g2.spotify.com  ->  /__w/gae2-dealer.g2.spotify.com
 *
 * 相対 URL / ルート相対 URL はそのまま（デフォルトルートが
 * open.spotify.com に落ちるため書き換える必要がない）。
 */
export function rewriteText(text) {
  if (!text) return text;
  let out = text;
  for (const rule of RULES) {
    const prefix = formatPrefix(rule.out, rule.esc);
    out = out.replace(rule.re, (_m, host) => prefix + host);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * HTML 専用の前処理
 * ------------------------------------------------------------------ */

/**
 * Subresource Integrity と crossorigin を除去する。
 * 本文を書き換えると integrity ハッシュが一致しなくなり全リソースが読めなくなる。
 * crossorigin は同一オリジン配信では不要なうえ CORS 要求を発生させてしまう。
 * 値なし（ブール属性）の `crossorigin` にも対応。
 */
export function stripIntegrityAndCors(html) {
  const VALUE = String.raw`(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))`;
  const re = new RegExp(
    String.raw`\s+(?:integrity${VALUE}|crossorigin${VALUE}?(?=[\s/>]))`,
    "gi",
  );
  return html.replace(re, "");
}

/** <meta http-equiv="Content-Security-Policy"> を除去する */
export function stripMetaCsp(html) {
  return html.replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, "");
}

/** srcset 属性値（"url 1x, url 2x" 形式）を書き換える */
export function rewriteSrcset(value) {
  return value
    .split(",")
    .map((part) => {
      const tokens = part.trim().split(/\s+/);
      if (tokens.length && tokens[0]) tokens[0] = rewriteText(tokens[0]);
      return tokens.join(" ");
    })
    .filter(Boolean)
    .join(", ");
}

/** HTML 属性（src/href/srcset/...）を直接書き換える。実行時パッチの保険。 */
export function rewriteHtmlAttributes(html) {
  return html.replace(
    /\s(src|href|action|poster|data|srcset|content|value|data-src|data-href|data-url|data-image|formaction|background)\s*=\s*("([^"]*)"|'([^']*)')/gi,
    (match, attr, _quoted, dq, sq) => {
      const raw = dq !== undefined ? dq : sq;
      if (raw === undefined) return match;
      const name = attr.toLowerCase();
      const next = name === "srcset" ? rewriteSrcset(raw) : rewriteText(raw);
      if (next === raw) return match;
      const quote = dq !== undefined ? '"' : "'";
      return ` ${attr}=${quote}${next}${quote}`;
    },
  );
}
