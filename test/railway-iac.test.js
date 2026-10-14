import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * .railway/railway.ts（Infrastructure as Code）の検証。
 *
 * railway.ts は型注釈を使っていないので構文はそのまま ES module として評価できる。
 * プロジェクト直下に一時 .mjs として複製してから import する
 * （bare specifier "railway/iac" の解決には node_modules が必要）。
 *
 * railway SDK（devDependency）が入っていない環境ではスキップする。
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const IAC_TS = new URL("../.railway/railway.ts", import.meta.url);
const TMP_MJS = fileURLToPath(new URL("../.railway/__iac-check.mjs", import.meta.url));

let sdkAvailable = true;
try {
  await import("railway/iac");
} catch {
  sdkAvailable = false;
}

test(".railway/railway.ts が正しいグラフを生成する", { skip: !sdkAvailable && "railway SDK 未インストール（npm install で有効化）" }, async (t) => {
  const src = readFileSync(IAC_TS, "utf8");

  // 型注釈を持ち込んでいないことの確認（持っていると Node 20 では評価できない）
  assert.ok(!/:\s*(string|number|boolean)\b/.test(src), "型注釈が含まれていると .mjs として評価できません");

  writeFileSync(TMP_MJS, src);
  t.after(() => rmSync(TMP_MJS, { force: true }));

  const mod = await import(TMP_MJS);
  assert.equal(typeof mod.default, "function", "defineRailway(fn) の default export が無い");

  const ctx = {
    command: "plan",
    projectId: "test-project",
    projectName: "spotify-reverse-proxy",
    environmentId: "test-env",
    environment: "production",
    environmentName: "production",
    isEnvironment: (n) => n === "production",
    shared: {},
  };

  const graph = mod.default(ctx);

  // --- プロジェクト ---
  assert.equal(graph.name, "spotify-reverse-proxy");
  assert.equal(graph.resources.length, 1, "リソースは service 1 つのはず");

  const svc = graph.resources[0];
  assert.equal(svc.type, "service");
  assert.equal(svc.kind, "github");
  assert.equal(svc.name, "spotify-reverse-proxy");
  // CLI がリソースを識別するためのアドレス
  assert.equal(svc.address, "service.spotify-reverse-proxy");

  // --- ソース（GitHub リポジトリ）---
  assert.equal(svc.source.type, "github");
  assert.match(svc.source.repo, /^[^/\s]+\/[^/\s]+$/, "owner/repo 形式であること");
  assert.equal(svc.source.branch, "main");

  // --- デプロイ設定 ---
  assert.equal(svc.deploy.startCommand, "node server.js");
  assert.equal(svc.deploy.healthcheckPath, "/healthz");
  assert.ok(svc.deploy.healthcheckTimeout >= 30, "healthcheckTimeout が短すぎる");
  assert.equal(svc.deploy.numReplicas, 1);

  // --- 環境変数 ---
  const v = svc.variables;
  assert.equal(v.NODE_ENV.value, "production");
  assert.equal(v.DEFAULT_UPSTREAM_HOST.value, "open.spotify.com");
  assert.equal(v.HOST_PREFIX.value, "/__h/");
  assert.equal(v.WS_PREFIX.value, "/__w/");

  // ACCESS_TOKEN は preserve()（＝ソースに値を書かない）でなければならない
  assert.equal(v.ACCESS_TOKEN.type, "preserve", "ACCESS_TOKEN の実値を railway.ts に書かないでください");

  // リテラル値の中にシークレットらしき文字列が紛れていないこと
  for (const [key, def] of Object.entries(v)) {
    if (def.type !== "literal") continue;
    assert.ok(
      !/^(ghp_|gho_|github_pat_|xox[baprs]-|AKIA)/.test(String(def.value)),
      `${key} にシークレットらしきリテラルが含まれています`,
    );
  }

  // --- 環境ごとの分岐 ---
  const devGraph = mod.default({ ...ctx, environment: "development", environmentName: "development", isEnvironment: (n) => n === "development" });
  assert.equal(devGraph.resources[0].variables.LOG_LEVEL.value, "debug");
  assert.equal(v.LOG_LEVEL.value, "info", "production では info であること");

  // --- SDK のヘルパーで構築されたリソースであること ---
  // （service() / github() / preserve() を直接呼んでいれば address と type が付く）
  assert.equal(graph.resources[0].type, "service");
  assert.ok(
    Object.values(v).some((def) => def.type === "preserve"),
    "preserve() を使った変数が 1 つも無い（シークレットを直書きしていないか？）",
  );
});

test("railway.json / railway.toml（非推奨の Config as Code）を置いていない", () => {
  // 新規サービスでは Config as Code を使えず、2026-12-01 に完全に読まれなくなる。
  // 紛らわしいので置かない方針。
  for (const f of ["railway.json", "railway.toml"]) {
    assert.throws(() => readFileSync(new URL(`../${f}`, import.meta.url)), { code: "ENOENT" }, `${f} が存在します（非推奨）`);
  }
});

test("Railway / Render の PORT 注入に対応している（0.0.0.0 待ち受け）", () => {
  const src = readFileSync(new URL("../lib/config.js", import.meta.url), "utf8");
  assert.match(src, /const env = process\.env/, "process.env を参照していない");
  assert.match(src, /env\.PORT/, "PORT 環境変数を読んでいない（PaaS が注入する）");
  assert.match(src, /0\.0\.0\.0/, "既定の待ち受けが 0.0.0.0 でない（コンテナ外から届かない）");

  // 起動ログに公開 URL を出す（RAILWAY_PUBLIC_DOMAIN / RENDER_EXTERNAL_URL）
  const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /RAILWAY_PUBLIC_DOMAIN/, "Railway の公開ドメインをログに出していない");
  assert.match(server, /RENDER_EXTERNAL_URL/, "Render の公開 URL をログに出していない");
});

test("Dockerfile が Node 22 LTS 以上を使う（Node 20 は 2026-04-30 EOL）", () => {
  const src = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  const m = /^FROM\s+node:(\d+)/m.exec(src);
  assert.ok(m, "Dockerfile に FROM node:<major> が見つからない");
  assert.ok(Number(m[1]) >= 22, `Node ${m[1]} は EOL です。22 以上を使ってください`);
});

test(".node-version が 22 以上（Railpack / Nixpacks 用）", () => {
  const v = readFileSync(new URL("../.node-version", import.meta.url), "utf8").trim();
  assert.ok(Number(v) >= 22, `.node-version = ${v}`);
});

test("render.yaml の NODE_VERSION が 22 以上", () => {
  const src = readFileSync(new URL("../render.yaml", import.meta.url), "utf8");
  const m = /NODE_VERSION\s*\n\s*value:\s*"?(\d+)/.exec(src);
  assert.ok(m, "render.yaml に NODE_VERSION が見つからない");
  assert.ok(Number(m[1]) >= 22, `NODE_VERSION=${m[1]} は EOL です`);
});
