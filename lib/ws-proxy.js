import { config, log } from "./config.js";
import { isProxyableHost, parseHostPort, buildAuthority } from "./hosts.js";

/**
 * WebSocket リバースプロキシ。
 *
 * ブラウザ  --wss-->  このサーバ /__w/<host>/<path>  --wss-->  <host>/<path>
 *
 * Spotify のリアルタイム通信（dealer / spclient の long-lived connection）は
 * WebSocket なので、upgrade イベントを拾って双方向に中継する。
 */
export function attachWebSocketProxy(httpServer, deps) {
  const { WebSocket, WebSocketServer } = deps;
  if (!WebSocket || !WebSocketServer) {
    log.warn("ws パッケージが見つからないため WebSocket プロキシは無効です（npm install を実行してください）");
    return false;
  }

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 32 * 1024 * 1024 });

  httpServer.on("upgrade", (req, socket, head) => {
    let target;
    try {
      target = resolveUpgradeTarget(req.url);
    } catch (err) {
      log.warn("WS upgrade 拒否:", err.message, req.url);
      socket.write(`HTTP/1.1 403 Forbidden\r\n\r\n${err.message}\n`);
      socket.destroy();
      return;
    }
    if (!target) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (client) => {
      bridge(client, req, target, WebSocket);
    });
  });

  return true;
}

/** /__w/<host>/<path>?<query> -> { url, host }。対象外なら null / エラーで throw */
function resolveUpgradeTarget(rawUrl) {
  const prefix = config.wsPrefix;
  const qIndex = rawUrl.indexOf("?");
  const rawPath = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
  const search = qIndex === -1 ? "" : rawUrl.slice(qIndex);
  if (!rawPath.startsWith(prefix)) return null;

  const rest = rawPath.slice(prefix.length);
  const slash = rest.indexOf("/");
  const hostSegment = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? "/" : rest.slice(slash);

  let decoded;
  try {
    decoded = decodeURIComponent(hostSegment);
  } catch {
    throw new Error("bad host encoding");
  }
  const { host, port } = parseHostPort(decoded);
  if (!isProxyableHost(host) || (decoded.includes(":") && port === null)) {
    throw new Error(`host not allowed: ${decoded}`);
  }

  const scheme = config.upstreamScheme === "http" ? "ws" : "wss";
  const authority = buildAuthority(host, port);
  return { url: `${scheme}://${authority}${path}${search}`, host: authority };
}

function buildUpstreamWsHeaders(req, host) {
  const headers = {};
  const forward = ["cookie", "user-agent", "accept-language", "sec-websocket-extensions", "authorization"];
  for (const name of forward) {
    const v = req.headers[name];
    if (v) headers[name] = Array.isArray(v) ? v.join(", ") : v;
  }
  if (config.userAgent) headers["user-agent"] = config.userAgent;
  headers.origin = `${config.upstreamScheme}://${host}`;
  return headers;
}

function bridge(client, req, target, WebSocket) {
  const protocols = req.headers["sec-websocket-protocol"];
  const subProtocols = protocols ? protocols.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

  log.debug("WS bridge ->", target.url, subProtocols || "");

  const upstream = new WebSocket(target.url, subProtocols, {
    headers: buildUpstreamWsHeaders(req, target.host),
    perMessageDeflate: false,
    handshakeTimeout: 20_000,
    maxPayload: 32 * 1024 * 1024,
    skipUTF8Validation: true,
  });

  let open = false;
  const pending = [];
  const MAX_BUFFERED = 8 * 1024 * 1024;

  upstream.on("open", () => {
    open = true;
    for (const msg of pending.splice(0)) {
      safeSend(upstream, msg);
    }
  });

  upstream.on("error", (err) => {
    log.warn("WS upstream error:", target.url, err.message);
    closeQuietly(client, 1011, "upstream error");
  });

  upstream.on("close", (code, reason) => {
    closeQuietly(client, normalizeCode(code), reasonToString(reason));
  });

  upstream.on("message", (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(data, { binary: isBinary });
      } catch (err) {
        log.debug("WS client send failed:", err.message);
      }
    }
  });

  client.on("message", (data, isBinary) => {
    if (!open) {
      if (pending.length < 256) pending.push({ data, isBinary });
      return;
    }
    safeSend(upstream, { data, isBinary });
  });

  client.on("close", () => {
    closeQuietly(upstream, 1000, "client closed");
  });

  client.on("error", (err) => {
    log.debug("WS client error:", err.message);
    closeQuietly(upstream, 1011, "client error");
  });

  function safeSend(sock, { data, isBinary }) {
    if (sock.readyState !== WebSocket.OPEN) return;
    if (sock.bufferedAmount > MAX_BUFFERED) {
      log.warn("WS backpressure exceeded, closing:", target.url);
      closeQuietly(sock, 1013, "backpressure");
      return;
    }
    try {
      sock.send(data, { binary: isBinary });
    } catch (err) {
      log.debug("WS send failed:", err.message);
    }
  }
}

function closeQuietly(sock, code, reason) {
  try {
    if (sock.readyState === 0 || sock.readyState === 1) sock.close(code, reason);
    else sock.terminate?.();
  } catch {
    /* noop */
  }
}

function normalizeCode(code) {
  // 1005/1006 などは close フレームに載せられないので 1011 に寄せる
  return code >= 1000 && code <= 1015 && code !== 1005 && code !== 1006 ? code : 1011;
}

function reasonToString(reason) {
  if (!reason) return undefined;
  const s = Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason);
  return s.slice(0, 120) || undefined;
}
