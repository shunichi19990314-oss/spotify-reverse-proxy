/**
 * 実物の open.spotify.com に対するライブスモークテスト。
 * npm test のモック E2E と違い、本物の Spotify を相手に
 * 「書き換え漏れが無いこと」「アセットが実際に 200 で取れること」を確認する。
 *
 *   SPX_BASE=http://localhost:10000 node test/live-smoke.mjs
 *   SPX_BASE=https://your-app.onrender.com SPX_TOKEN=xxx node test/live-smoke.mjs
 *
 * ネットワークが必要なので `npm test` には含めていない（npm run verify で実行）。
 */
const B = (process.env.SPX_BASE || "http://localhost:10000").replace(/\/$/, "");
const TOKEN = process.env.SPX_TOKEN || "";
const H = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  "accept-encoding": "identity",
  ...(TOKEN ? { cookie: `spx_token=${TOKEN}` } : {}),
};

const chk = (label, ok) => console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
let pass = 0,
  fail = 0;
const check = (label, ok) => {
  ok ? pass++ : fail++;
  chk(label, ok);
};

console.log("=== 最終検証（実 open.spotify.com に対して）===");

const r = await fetch(B + "/", { headers: H });
const t = await r.text();

check(`GET / -> ${r.status}`, r.status === 200);
check(
  `上流の厳格な CSP を除去し frame-ancestors * のみ (= ${JSON.stringify(r.headers.get("content-security-policy"))})`,
  r.headers.get("content-security-policy") === "frame-ancestors *",
);
check("X-Frame-Options 除去", r.headers.get("x-frame-options") === null);
check("HSTS 除去", r.headers.get("strict-transport-security") === null);
check("ランタイムパッチを <head> 先頭に注入", t.includes('<script data-spx="runtime">'));
check("window.__SPX__ が定義されている", t.includes("window.__SPX__"));

const LEAK = /(?:https?|wss?):\\?\/\\?\/[a-z0-9.-]*(?:spotify\.com|scdn\.co|pscdn\.co|spotifycdn\.com|akamaized\.net)/gi;
const leaks = [...t.matchAll(LEAK)].map((m) => m[0]);
check(`Spotify 系絶対 URL の書き換え漏れ = 0（実測 ${leaks.length}）`, leaks.length === 0);
check("integrity 属性を除去", !t.includes("integrity="));
check("crossorigin 属性を除去", !/crossorigin/i.test(t));
check("meta CSP を除去", !/http-equiv="Content-Security-Policy"/i.test(t));

const nh = (t.match(/\/__h\//g) || []).length;
const nw = (t.match(/\/__w\//g) || []).length;
check(`/__h/ への書き換え ${nh} 箇所`, nh > 10);
check(`/__w/ への書き換え ${nw} 箇所`, nw > 0);

// 実在ページのサブページ
const sub = await fetch(B + "/playlist/37i9dQZEVXcJZyENOWUFo7", { headers: H });
const subt = await sub.text();
check(
  `プレイリストページ -> ${sub.status} / 書き換え ${(subt.match(/\/__h\//g) || []).length} 箇所`,
  sub.status === 200 && subt.includes("/__h/"),
);

// メインバンドルの書き換え漏れ
const js = (t.match(/"(\/__h\/[^"]+web-player\.[a-f0-9]+\.js)"/) || [])[1];
if (js) {
  const jr = await fetch(B + js, { headers: H });
  const jt = await jr.text();
  const jl = [...jt.matchAll(LEAK)].map((m) => m[0]);
  check(
    `メインバンドル ${(jt.length / 1024).toFixed(0)}KB -> ${jr.status} / 書き換え ${(jt.match(/\/__h\//g) || []).length} 箇所 / 漏れ ${jl.length}`,
    jr.status === 200 && jl.length === 0,
  );
  const jr2 = await fetch(B + js, { headers: H });
  await jr2.arrayBuffer();
  check(`2 回目はキャッシュ HIT (= ${jr2.headers.get("x-spx-cache")})`, jr2.headers.get("x-spx-cache") === "HIT");
}

// 静的アセット
for (const u of [
  "/__h/open.spotifycdn.com/cdn/images/favicon32.b64ecc03.png",
  "/__h/open.spotifycdn.com/cdn/build/web-player/web-player.53565b31.css",
]) {
  const rr = await fetch(B + u, { headers: H });
  await rr.arrayBuffer();
  check(`${u.split("/").pop().slice(0, 40)} -> ${rr.status}`, rr.status === 200);
}

// セキュリティ
const s1 = await fetch(B + "/__h/evil.com/x", { headers: H });
check("許可外ホスト /__h/evil.com -> 403", s1.status === 403);
const s2 = await fetch(B + "/__h/127.0.0.1:22/x", { headers: H });
check("SSRF 試行 /__h/127.0.0.1:22 -> 403", s2.status === 403);
const s3 = await fetch(B + "/__h/open.spotify.com.evil.com/x", { headers: H });
check("サブドメイン偽装 -> 403", s3.status === 403);
if (TOKEN) {
  const s4 = await fetch(B + "/", { headers: { "accept-encoding": "identity" } });
  check("トークン無し -> 401", s4.status === 401);
}
const s5 = await fetch(B + "/healthz");
check("/healthz は認証不要 -> 200", s5.status === 200);

const st = await (await fetch(B + "/__spx/stats", { headers: H })).json();
check(
  `キャッシュ稼働 entries=${st.cache.entries} ${(st.cache.bytes / 1024 / 1024).toFixed(1)}MB / RSS ${(st.memory.rss / 1024 / 1024).toFixed(0)}MB`,
  st.cache.enabled && st.cache.entries > 0,
);

console.log(`\n${B} -> ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
