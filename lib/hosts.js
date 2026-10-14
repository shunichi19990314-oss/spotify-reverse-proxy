import { config } from "./config.js";

/**
 * ホスト名がプロキシ許可リストに含まれるか。
 * 許可ドメイン本体またはそのサブドメインのみ true を返す。
 *
 *   isProxyableHost("open.spotify.com")            -> true
 *   isProxyableHost("evil.com")                    -> false
 *   isProxyableHost("open.spotify.com.evil.com")   -> false
 *
 * 注意: ポートは含めずに呼ぶこと（parseHostPort() で分離してから渡す）。
 */
export function isProxyableHost(host) {
  if (typeof host !== "string" || host.length === 0 || host.length > 253) return false;
  const h = host.toLowerCase().replace(/\.$/, "");
  // userinfo やポート、パスを含まない素のホスト名だけを受け付ける
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(h)) return false;
  return config.allowDomains.some((d) => h === d || h.endsWith("." + d));
}

/** "host:port" を分解する。port が無ければ null */
export function parseHostPort(value) {
  const s = String(value || "").trim().toLowerCase().replace(/\.$/, "");
  const colon = s.lastIndexOf(":");
  if (colon === -1) return { host: s, port: null };
  const host = s.slice(0, colon);
  const port = s.slice(colon + 1);
  return { host, port: /^\d{1,5}$/.test(port) ? port : null };
}

/** host(+port) が許可対象か */
export function isProxyableTarget(value) {
  const { host, port } = parseHostPort(value);
  if (!host) return false;
  if (port === null && String(value).includes(":")) return false; // ":abc" のような不正形式
  return isProxyableHost(host);
}

/**
 * 受信パスを「上流ホスト + 上流パス + 検索部分」に分解する。
 *
 *   /__h/i.scdn.co/image/xxxx.jpg?a=1  -> { host:"i.scdn.co", port:null, path:"/image/xxxx.jpg", search:"?a=1", prefixed:true }
 *   /static/js/main.js                 -> { host:<default>,   ..., prefixed:false }
 *
 * 許可されていないホストの場合は { error } を返す。
 */
export function parseProxyTarget(rawUrl) {
  const qIndex = rawUrl.indexOf("?");
  const rawPath = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
  const search = qIndex === -1 ? "" : rawUrl.slice(qIndex);
  const { hostPrefix } = config;

  if (rawPath.startsWith(hostPrefix)) {
    const rest = rawPath.slice(hostPrefix.length);
    const slash = rest.indexOf("/");
    const rawHost = slash === -1 ? rest : rest.slice(0, slash);
    const path = slash === -1 ? "/" : rest.slice(slash);

    let hostSegment;
    try {
      hostSegment = decodeURIComponent(rawHost);
    } catch {
      return { error: "bad_host_encoding" };
    }

    const { host, port } = parseHostPort(hostSegment);
    if (!isProxyableHost(host) || (hostSegment.includes(":") && port === null)) {
      return { error: "host_not_allowed", host: hostSegment };
    }
    return { host, port, path, search, prefixed: true };
  }

  const { host, port } = parseHostPort(config.defaultUpstreamHost);
  if (!isProxyableHost(host)) return { error: "bad_default_host", host: config.defaultUpstreamHost };
  return { host, port, path: rawPath, search, prefixed: false };
}

/** 上流の絶対 URL を組み立てる */
export function buildUpstreamUrl(host, port, path, search) {
  const scheme = config.upstreamScheme;
  const defaultPort = scheme === "http" ? "80" : "443";
  const authority = port && port !== defaultPort ? `${host}:${port}` : host;
  return `${scheme}://${authority}${path}${search}`;
}

/** authority 文字列（host[:port]）を作る */
export function buildAuthority(host, port) {
  const scheme = config.upstreamScheme;
  const defaultPort = scheme === "http" ? "80" : "443";
  return port && port !== defaultPort ? `${host}:${port}` : host;
}

/**
 * 上流の絶対 URL を、このプロキシ上の **絶対 URL** へ変換する。
 * Location ヘッダの書き換えに使う。
 *
 * 絶対 URL で返すのは rewriteText() と同じ理由（アプリ側が base 無しで
 * `new URL()` しても壊れないようにするため）。
 *
 *   toProxyPath("https://accounts.spotify.com/l", "https://my.app")
 *     -> "https://my.app/__h/accounts.spotify.com/l"
 *   toProxyPath("https://open.spotify.com/collection", "https://my.app")
 *     -> "https://my.app/collection"   (デフォルトホストは素のパス)
 *   toProxyPath("https://example.com/")  -> null   (プロキシ対象外)
 */
export function toProxyPath(absoluteUrl, base = "") {
  const b = String(base || "").replace(/\/+$/, "");
  let u;
  try {
    u = new URL(absoluteUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  if (!isProxyableHost(host)) return null;

  const pathAndQuery = `${u.pathname}${u.search}`;
  const def = parseHostPort(config.defaultUpstreamHost);
  const upPort = u.port || null;
  const authority = buildAuthority(host, upPort);

  // デフォルト上流と同一 authority なら素のパス
  if (host === def.host && authority === buildAuthority(def.host, def.port)) return `${b}${pathAndQuery}`;
  return `${b}${config.hostPrefix}${authority}${pathAndQuery}`;
}
