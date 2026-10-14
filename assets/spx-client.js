/* eslint-disable */
/**
 * ブラウザ側ランタイムパッチ。
 * server が HTML の <head> 先頭にインライン注入する。
 *
 * 静的な文字列置換では捕捉できない「実行時に組み立てられる URL」
 * （apresolve が返すアクセスポイント、dealer の WebSocket 先など）を、
 * fetch / XHR / WebSocket / EventSource / sendBeacon / 要素属性の
 * レベルでこのプロキシのパスに付け替える。
 *
 * プレースホルダは server 起動時に実値へ置換される:
 *   __SPX_DOMAINS__     許可ドメイン配列 (JSON)
 *   __SPX_HOST_PREFIX__ 例: "/__h/"
 *   __SPX_WS_PREFIX__   例: "/__w/"
 *   __SPX_VERSION__     バージョン文字列
 */
(function () {
  "use strict";

  if (window.__SPX__) return;

  var DOMAINS = __SPX_DOMAINS__;
  var HP = "__SPX_HOST_PREFIX__";
  var WP = "__SPX_WS_PREFIX__";
  var VERSION = "__SPX_VERSION__";

  /* ---------------- URL 書き換え ---------------- */

  function hostAllowed(host) {
    if (!host) return false;
    var h = host.toLowerCase();
    for (var i = 0; i < DOMAINS.length; i++) {
      var d = DOMAINS[i];
      if (h === d) return true;
      if (h.length > d.length && h.charAt(h.length - d.length - 1) === "." && h.slice(-d.length) === d) return true;
    }
    return false;
  }

  var ABS = /^(?:([a-z][a-z0-9+.\-]*):)?\/\/([^\/?#]*)([\s\S]*)$/i;

  /**
   * 絶対 URL / プロトコル相対 URL を、このオリジン配下のプロキシパスに変換する。
   * 対象外（data:, blob:, 相対パス, 非 Spotify ドメイン）はそのまま返す。
   */
  function rewrite(url) {
    if (typeof url !== "string" || url.length === 0) return url;
    var c = url.charCodeAt(0);
    if (c === 47 /* / */) return url; // 既にルート相対
    var m = ABS.exec(url);
    if (!m) return url;

    var scheme = (m[1] || "").toLowerCase();
    var authority = m[2];
    var rest = m[3] || "";
    if (!authority) return url;

    var at = authority.lastIndexOf("@");
    var hostPort = at >= 0 ? authority.slice(at + 1) : authority;
    var host = hostPort.split(":")[0];
    if (!hostAllowed(host)) return url;

    var isWs = scheme === "ws" || scheme === "wss";
    var prefix = isWs ? WP : HP;
    if (rest.length && rest.charAt(0) !== "/") rest = "/" + rest;
    return prefix + authority + rest;
  }

  /** WebSocket 用の絶対 wss:// URL を作る */
  function rewriteWs(url) {
    var u = typeof url === "string" ? url : url instanceof URL ? String(url) : url;
    var r = rewrite(u);
    if (typeof r === "string" && r.charAt(0) === "/") {
      return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + r;
    }
    return r;
  }

  function rewriteSrcset(value) {
    if (typeof value !== "string" || !value) return value;
    return value
      .split(",")
      .map(function (part) {
        var t = part.trim().split(/\s+/);
        if (t.length && t[0]) t[0] = rewrite(t[0]);
        return t.join(" ");
      })
      .join(", ");
  }

  /* ---------------- fetch ---------------- */

  if (typeof window.fetch === "function") {
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        if (typeof input === "string") {
          input = rewrite(input);
        } else if (input instanceof URL) {
          input = rewrite(String(input));
        } else if (input && typeof input.url === "string") {
          var nu = rewrite(input.url);
          if (nu !== input.url) input = new Request(nu, input);
        }
        if (init && typeof init === "object" && typeof init.referrer === "string") {
          init = Object.assign({}, init, { referrer: rewrite(init.referrer) });
        }
      } catch (e) {
        /* 書き換え失敗時は元のまま送る */
      }
      return origFetch.call(this, input, init);
    };
  }

  /* ---------------- XMLHttpRequest ---------------- */

  try {
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        if (typeof url === "string") arguments[1] = rewrite(url);
        else if (url instanceof URL) arguments[1] = rewrite(String(url));
      } catch (e) {}
      return origOpen.apply(this, arguments);
    };
  } catch (e) {}

  /* ---------------- WebSocket ---------------- */

  try {
    var OrigWS = window.WebSocket;
    if (OrigWS) {
      var PatchedWS = function (url, protocols) {
        var target = url;
        try {
          target = rewriteWs(url);
        } catch (e) {}
        if (protocols === undefined) return new OrigWS(target);
        return new OrigWS(target, protocols);
      };
      PatchedWS.prototype = OrigWS.prototype;
      PatchedWS.CONNECTING = OrigWS.CONNECTING;
      PatchedWS.OPEN = OrigWS.OPEN;
      PatchedWS.CLOSING = OrigWS.CLOSING;
      PatchedWS.CLOSED = OrigWS.CLOSED;
      try {
        Object.defineProperty(PatchedWS, "name", { value: "WebSocket" });
      } catch (e) {}
      Object.defineProperty(window, "WebSocket", { value: PatchedWS, writable: true, configurable: true });
    }
  } catch (e) {}

  /* ---------------- EventSource ---------------- */

  try {
    var OrigES = window.EventSource;
    if (OrigES) {
      var PatchedES = function (url, opts) {
        var t = url;
        try {
          if (typeof t === "string") t = rewrite(t);
        } catch (e) {}
        return opts === undefined ? new OrigES(t) : new OrigES(t, opts);
      };
      PatchedES.prototype = OrigES.prototype;
      PatchedES.CONNECTING = OrigES.CONNECTING;
      PatchedES.OPEN = OrigES.OPEN;
      PatchedES.CLOSED = OrigES.CLOSED;
      Object.defineProperty(window, "EventSource", { value: PatchedES, writable: true, configurable: true });
    }
  } catch (e) {}

  /* ---------------- sendBeacon ---------------- */

  try {
    if (navigator.sendBeacon) {
      var origBeacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = function (url, data) {
        try {
          if (typeof url === "string") url = rewrite(url);
        } catch (e) {}
        return origBeacon(url, data);
      };
    }
  } catch (e) {}

  /* ---------------- window.open ---------------- */

  try {
    var origOpenWin = window.open;
    window.open = function (url, name, features) {
      try {
        if (typeof url === "string") url = rewrite(url);
      } catch (e) {}
      return origOpenWin.call(this, url, name, features);
    };
  } catch (e) {}

  /* ---------------- Service Worker 無効化 ---------------- */
  /*
   * Service Worker はスコープがこのオリジン配下に限定されるため、
   * 上流 (open.spotify.com) 前提のキャッシュ処理が壊れる。登録を止める。
   */
  try {
    if (navigator.serviceWorker) {
      var blocked = function () {
        return Promise.reject(new DOMException("Service workers are disabled by the reverse proxy.", "NotAllowedError"));
      };
      try {
        Object.defineProperty(navigator.serviceWorker, "register", { value: blocked, writable: true, configurable: true });
      } catch (e) {
        navigator.serviceWorker.register = blocked;
      }
    }
  } catch (e) {}

  /* ---------------- 要素プロパティ (src / href / poster ...) ---------------- */

  var ELEMENT_PROTOS = [
    "HTMLScriptElement",
    "HTMLImageElement",
    "HTMLMediaElement",
    "HTMLVideoElement",
    "HTMLAudioElement",
    "HTMLIFrameElement",
    "HTMLSourceElement",
    "HTMLTrackElement",
    "HTMLEmbedElement",
    "HTMLObjectElement",
    "HTMLAnchorElement",
    "HTMLLinkElement",
    "HTMLFormElement",
    "HTMLAreaElement",
    "HTMLInputElement",
  ];

  function patchUrlProperty(proto, prop, transform) {
    try {
      var d = Object.getOwnPropertyDescriptor(proto, prop);
      if (!d || !d.set || d.__spxPatched) return;
      var origSet = d.set;
      var origGet = d.get;
      Object.defineProperty(proto, prop, {
        configurable: true,
        enumerable: d.enumerable,
        get: origGet,
        set: function (v) {
          try {
            if (typeof v === "string" && v.indexOf("//") !== -1) v = transform(v);
          } catch (e) {}
          return origSet.call(this, v);
        },
      });
      Object.defineProperty(Object.getOwnPropertyDescriptor(proto, prop), "__spxPatched", { value: true });
    } catch (e) {}
  }

  ELEMENT_PROTOS.forEach(function (name) {
    var proto = window[name];
    if (!proto) return;
    ["src", "href", "poster", "action", "data", "background", "formAction"].forEach(function (prop) {
      patchUrlProperty(proto, prop, rewrite);
    });
    if (name === "HTMLImageElement" || name === "HTMLSourceElement") {
      patchUrlProperty(proto, "srcset", rewriteSrcset);
    }
  });

  /* ---------------- setAttribute ---------------- */

  var ATTRS = {
    src: 1,
    href: 1,
    poster: 1,
    action: 1,
    data: 1,
    background: 1,
    formaction: 1,
    value: 1,
    content: 1,
    "data-src": 1,
    "data-href": 1,
    "data-url": 1,
    "data-image": 1,
    "data-srcset": 1,
  };

  try {
    var origSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      try {
        if (typeof value === "string" && value.indexOf("//") !== -1) {
          var n = String(name).toLowerCase();
          if (ATTRS[n] || n.indexOf("data-") === 0) {
            value = n === "srcset" || n === "data-srcset" ? rewriteSrcset(value) : rewrite(value);
          }
        }
      } catch (e) {}
      return origSetAttribute.call(this, name, value);
    };
  } catch (e) {}

  /* ---------------- デバッグ用 ---------------- */

  window.__SPX__ = {
    version: VERSION,
    hostPrefix: HP,
    wsPrefix: WP,
    domains: DOMAINS,
    rewrite: rewrite,
    rewriteWs: rewriteWs,
  };
})();
