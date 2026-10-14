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
  return /\+(json|xml)$/.test(t);
}

/* ------------------------------------------------------------------ *
 * ホストマッチ用正規表現
 * ------------------------------------------------------------------ */

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildHostSource(allowDomains) {
  const suffixes = allowDomains
    .map(escapeRegExp)
    .sort((a, b) => b.length - a.length)
    .join("|");
  // 末尾の否定先読みで "open.spotify.com.evil.com" のような
  // 長いホスト名の途中マッチ（＝任意ホストへの中継）を防ぐ。
  return `(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)*(?:${suffixes})(?![a-z0-9._-])`;
}

const HOST = buildHostSource(config.allowDomains);

/**
 * `blob:https://...` のような入れ子スキームの内側を書き換えないための固定長否定後読み。
 */
const NOT_NESTED = `(?<!blob:)(?<!data:)(?<!filesystem:)(?<!view-source:)(?<!javascript:)`;

/**
 * 書き換えルール。
 * 上流の HTML / CSS / JS / JSON には Spotify の URL が
 * 「生の形」「JSON エスケープ形 (\/\/)」「Unicode エスケープ形 (\u002F\u002F)」で現れる。
 *
 * `scheme: true` は URL のスキーム部分も消費する（＝置換結果にスキームを含める必要がある）ことを意味する。
 */
const RULES = [
  // --- 生 (raw) ---
  { re: new RegExp(`${NOT_NESTED}\\bwss?://(${HOST})`, "gi"), kind: "ws", esc: "raw" },
  { re: new RegExp(`${NOT_NESTED}\\bhttps?://(${HOST})`, "gi"), kind: "host", esc: "raw" },
  { re: new RegExp(`(?<![:/\\w.-])//(${HOST})`, "gi"), kind: "host", esc: "raw" },

  // --- JSON / JS 文字列内のスラッシュエスケープ: https:\/\/open.spotify.com ---
  { re: new RegExp(`${NOT_NESTED}\\bwss?:\\\\/\\\\/(${HOST})`, "gi"), kind: "ws", esc: "slash" },
  { re: new RegExp(`${NOT_NESTED}\\bhttps?:\\\\/\\\\/(${HOST})`, "gi"), kind: "host", esc: "slash" },
  { re: new RegExp(`(?<![:\\\\/\\w.-])\\\\/\\\\/(${HOST})`, "gi"), kind: "host", esc: "slash" },

  // --- Unicode エスケープ: https:\u002F\u002Fopen.spotify.com ---
  // スキームも一緒に消費しないと "https:" + 置換結果 で二重になってしまう
  { re: new RegExp(`${NOT_NESTED}(?:https?:)?\\\\+u002F\\\\+u002F(${HOST})`, "gi"), kind: "host", esc: "unicode" },
];

/**
 * 置換用のプレフィックス一式を作る。
 *
 * 重要: **必ず自オリジンを含む絶対 URL** を返すこと。
 * ルート相対（"/__h/..."）にすると、アプリ側が
 *   let u = "<書き換え後の値>", o = new URL(u).origin;
 * のように base 無しで `new URL()` した瞬間に
 *   TypeError: Failed to construct 'URL': Invalid URL
 * を投げて webpack モジュールの評価が失敗し、
 * Spotify のエラーバウンダリ（「エラーが発生したようです」）が出る。
 */
function buildPrefixes(base) {
  const b = String(base || "").replace(/\/+$/, "");
  const hp = `${b}${config.hostPrefix}`;
  // WebSocket は wss:// のままにすること。https:// にしてしまうと
  // `new WebSocket(<文字列>)` に渡した瞬間に SyntaxError になる。
  const wsBase = /^https:/i.test(b) ? b.replace(/^https:/i, "wss:") : b.replace(/^http:/i, "ws:");
  const wp = `${wsBase}${config.wsPrefix}`;
  const esc = {
    raw: (s) => s,
    slash: (s) => s.replace(/\//g, "\\/"),
    unicode: (s) => s.replace(/\//g, "\\u002F"),
  };
  return {
    host: { raw: esc.raw(hp), slash: esc.slash(hp), unicode: esc.unicode(hp) },
    ws: { raw: esc.raw(wp), slash: esc.slash(wp), unicode: esc.unicode(wp) },
  };
}

/**
 * 置換マーカー。
 *
 * ルールを素朴に順次適用すると、**前のルールの出力を後のルールが再び書き換えてしまう**。
 * 実例: `wss://dealer.spotify.com` を `/__w/dealer.spotify.com` にした直後、
 * https?:// ルールが自オリジン（PROXY_ALLOW_DOMAINS に含まれる場合）を拾って
 * `http://self/__h/self/__w/dealer...` のように二重にネストする。
 * 本文に現れ得ない \u0000 を挟んだマーカーで一旦置き、最後にまとめて実プレフィックスへ
 * 変換することで、これを構造的に防ぐ（かつパス数も 1 回で済む）。
 */
const MARK = "\u0000";
const MARK_RE = new RegExp(`${MARK}(host|ws)(raw|slash|unicode)${MARK}`, "g");

/**
 * テキスト本文中の Spotify 系絶対 URL を、このプロキシの絶対 URL に書き換える。
 *
 *   rewriteText('x="https://i.scdn.co/a"', "https://my.app")
 *     -> 'x="https://my.app/__h/i.scdn.co/a"'
 *
 * @param {string} text
 * @param {string} base 自オリジン（例 "https://my-app.up.railway.app"）。
 *                      空文字だとルート相対になるが、上記の理由で**使うべきでない**。
 */
export function rewriteText(text, base = "") {
  if (!text) return text;

  // 冪等性ガード: 既に自オリジン付きで書き換えた URL を再び書き換えない。
  // （PROXY_ALLOW_DOMAINS に自ホストを含めた構成で二重ネストするのを防ぐ）
  let selfHost = "";
  try {
    selfHost = base ? new URL(base).hostname.toLowerCase() : "";
  } catch {
    selfHost = "";
  }

  let out = text;
  let marked = false;
  for (const rule of RULES) {
    out = out.replace(rule.re, (m, host) => {
      if (selfHost && host.toLowerCase() === selfHost) return m;
      marked = true;
      return `${MARK}${rule.kind}${rule.esc}${MARK}${host}`;
    });
  }
  if (!marked) return text;

  const P = buildPrefixes(base);
  return out.replace(MARK_RE, (_m, kind, esc) => P[kind][esc]);
}

/* ------------------------------------------------------------------ *
 * HTML 専用の前処理
 * ------------------------------------------------------------------ */

/**
 * Subresource Integrity と crossorigin を除去する。
 * 本文を書き換えると integrity ハッシュが必ず不一致になる。
 * crossorigin は同一オリジン配信では不要なうえ CORS 要求を発生させてしまう。
 */
export function stripIntegrityAndCors(html) {
  const VALUE = String.raw`(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))`;
  const re = new RegExp(String.raw`\s+(?:integrity${VALUE}|crossorigin${VALUE}?(?=[\s/>]))`, "gi");
  return html.replace(re, "");
}

/** <meta http-equiv="Content-Security-Policy"> を除去する */
export function stripMetaCsp(html) {
  return html.replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, "");
}

/**
 * `<script type="text/plain">BASE64</script>` の中身を展開して URL を書き換え、再エンコードする。
 *
 * Spotify の Web Player は HTML に base64 の JSON を埋め込んでいる:
 *   #appServerConfig   起動時コンフィグ
 *   #__CDN_FILE_URLS__ 982 件ほどの CDN アセット絶対 URL マップ
 *   #featureFlags / #remoteConfig / #seoExperiments
 * 素のテキスト置換では base64 の中を見られないため、ここでデコードして書き換える。
 */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export function rewriteInlineBase64Scripts(html, base) {
  if (!html || !html.includes("text/plain")) return html;
  return html.replace(
    /(<script\b[^>]*type=["']text\/plain["'][^>]*>)([^<]*)(<\/script>)/gi,
    (match, open, inner, close) => {
      const clean = inner.trim();
      if (clean.length < 8 || !BASE64_RE.test(clean)) return match;

      const buf = Buffer.from(clean, "base64");
      const decoded = buf.toString("utf8");
      // base64 として妥当でも、UTF-8 テキストでなければ触らない
      if (decoded.includes("\uFFFD")) return match;
      // 正準形と一致しない（＝base64 ではない）場合は触らない
      if (buf.toString("base64").replace(/=+$/, "") !== clean.replace(/=+$/, "")) return match;

      const rewritten = rewriteText(decoded, base);
      if (rewritten === decoded) return match;
      return open + Buffer.from(rewritten, "utf8").toString("base64") + close;
    },
  );
}

/*
 * 注: 以前は rewriteHtmlAttributes() で HTML 属性を個別にも書き換えていたが、
 * rewriteText() が srcset を含むすべての属性値を正しく処理するため冗長だった。
 * さらに「絶対 URL で出力する」方式に変更したあとは、2 回目のパスが
 * 1 回目の出力（自オリジン付き絶対 URL）を再び拾って二重ネストさせる
 * バグの原因になったため削除した。書き換えは必ず 1 パスのみ行うこと。
 */
