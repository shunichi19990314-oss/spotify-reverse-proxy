import { defineRailway, github, preserve, project, service } from "railway/iac";

/**
 * Railway Infrastructure as Code
 * ==============================
 *
 * 注意: `railway.json` / `railway.toml`（Config as Code）は **非推奨** で、
 * 新規サービスでは利用できず、既存サービスも 2026-12-01 に読まれなくなる。
 * 後継がこの `.railway/railway.ts`（Infrastructure as Code）。
 *
 * 使い方:
 *   npm install                       # devDependencies の railway SDK が入る
 *   npm install -g @railway/cli       # CLI（初回のみ）
 *   railway login
 *   railway link                      # プロジェクト / 環境を紐づけ
 *   npm run railway:plan              # 差分の確認（安全・読み取り専用）
 *   npm run railway:apply             # 確認後に適用
 *
 * ビルダーについて:
 *   リポジトリ直下に Dockerfile があるため、Railway は **自動的に Dockerfile ビルダー**を使う。
 *   （公式: "Railway will always build with a Dockerfile if it finds one."）
 *   IaC には builder を指定するフィールドが無いので、Railpack に切り替えたい場合は
 *   ダッシュボードの Service Settings -> Build -> Builder で変更する。
 *   その場合は `.node-version`（= 22）が Node バージョンの解決に使える。
 *
 * シークレットについて:
 *   ACCESS_TOKEN は preserve() にしてある＝**値はこのファイルに書かず、Railway 側の値を維持する**。
 *   初回は以下いずれかで設定すること:
 *     railway variables --set "ACCESS_TOKEN=$(openssl rand -hex 32)"
 *     または ダッシュボードの Variables タブで手動入力
 */
export default defineRailway((ctx) => {
  const prod = ctx.environment === "production";

  const proxy = service("spotify-reverse-proxy", {
    // このリポジトリの main ブランチをデプロイ元にする
    source: github("shunichi19990314-oss/spotify-reverse-proxy", { branch: "main" }),

    // Dockerfile ビルダーでは build コマンドは不要（Dockerfile 内で npm ci する）。
    // Railpack に切り替えた場合も package.json の build スクリプトが無いので省略でよい。
    start: "node server.js",

    // /healthz は認証不要（ACCESS_TOKEN を設定していても 200 を返す）
    healthcheck: "/healthz",
    healthcheckTimeout: 120,

    replicas: 1,

    env: {
      NODE_ENV: "production",
      LOG_LEVEL: prod ? "info" : "debug",

      // ---- プロキシ先 ----
      DEFAULT_UPSTREAM_HOST: "open.spotify.com",
      HOST_PREFIX: "/__h/",
      WS_PREFIX: "/__w/",
      UPSTREAM_TIMEOUT_MS: "30000",
      MAX_REWRITE_BYTES: "67108864", // 64MB

      // ---- キャッシュ ----
      // Railway の下位プランは 0.5GB RAM なので Render より控えめにする
      CACHE_MAX_BYTES: "52428800", // 50MB
      CACHE_MAX_ENTRIES: "250",
      CACHE_MAX_TTL_SEC: "3600",

      // ---- 埋め込み / CORS ----
      ALLOW_EMBED: "true",
      FRAME_ANCESTORS: "*",
      CORS_ORIGINS: "",
      USER_AGENT: "",
      ACCEPT_LANGUAGE: "ja,en-US;q=0.9,en;q=0.8",

      // ---- シークレット（値は Railway 側で管理。ソースに書かない）----
      // 空のままデプロイすると誰でも使えるオープンプロキシになるため必ず設定すること。
      ACCESS_TOKEN: preserve(),
    },
  });

  return project("spotify-reverse-proxy", {
    resources: [proxy],
  });
});
