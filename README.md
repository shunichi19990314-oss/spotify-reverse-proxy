# spotify-reverse-proxy

**Render / Railway にそのままデプロイできる、Spotify Web Player (`open.spotify.com`) を自ドメイン経由で表示するリバースプロキシ**です。

HTML / CSS / JS / JSON の本文中にある Spotify 系絶対 URL をプロキシ自身のパスへ書き換え、さらにブラウザ側でも `fetch` / `XHR` / `WebSocket` / 要素属性をランタイムパッチするため、実行時に組み立てられる URL（アクセスポイントや dealer の接続先）も取りこぼしません。

依存パッケージは本番 **`undici` と `ws` の 2 つだけ**。フレームワーク不使用の素の Node.js 実装です。

| プラットフォーム | 設定ファイル | 状態 |
|---|---|---|
| **Render** | `render.yaml`（Blueprint） | ✅ 同梱・すぐデプロイ可 |
| **Railway** | `Dockerfile` 自動検出 / `.railway/railway.ts`（IaC） | ✅ 同梱・すぐデプロイ可 |
| **その他 Docker 対応 PaaS** | `Dockerfile` | ✅ Fly.io / Cloud Run / ECS など |

> **Node のバージョン**: Node 20 は **2026-04-30 に EOL** を迎えたため、デプロイ先は **Node 22 LTS (Jod)** に固定してあります（`Dockerfile` / `.node-version` / `render.yaml`）。コード自体は Node 20.11 以上で動作し、テストも Node 20 で通しています。

---

## 1. 先に読むこと：できること / できないこと

このプロキシは「Spotify の Web Player を別オリジンで動かす」ものです。技術的な制約を正直に書いておきます。

| | 状態 | 補足 |
|---|---|---|
| ページの表示・レイアウト・CSS・フォント | ✅ 動作 | 実測で全アセット 200 OK |
| 画像・アートワーク・アイコン | ✅ 動作 | `/__h/i.scdn.co/...` 等へ書き換え |
| JS バンドル / 動的 import / マニフェスト | ✅ 動作 | 4.3MB のバンドルも書き換え漏れゼロ |
| 検索・閲覧などの API 呼び出し | 🟡 概ね動作 | `Origin` / `Referer` を上流オリジンに付け替えてある |
| WebSocket（dealer / リアルタイム更新） | 🟡 中継は実装済み | 接続先のトークン取得が通ることが前提 |
| **ログイン（accounts.spotify.com）** | ❌ 高確率で失敗 | Spotify 側が `redirect_uri` とオリジンを厳格に検査する |
| **楽曲の再生（Widevine DRM）** | ❌ 高確率で失敗 | ライセンスサーバーがオリジンを検査する。`encrypted-media` は許可してあるが origin 検証は回避不能 |
| Spotify Connect / デスクトップ連携 | ❌ 不可 | `spotilocal.com` はローカルマシン宛のためプロキシ経由では届かない |

> **PaaS による差**: Render の無料プランは 15 分でスリープしますが、Railway にはスリープがありません（代わりに恒久無料枠が無く、$5 クレジットのトライアル後は Hobby $5/月）。常時稼働させたいなら Railway、無料で試すだけなら Render が向いています。

> **現実的な使いどころ**
> - 自ドメイン配下で Web Player の UI を表示・調査する（フロントエンド研究、UI 解析、スクレイピングの土台）
> - iframe 埋め込みが `X-Frame-Options` / CSP で塞がれている環境で、自前の配信に置き換える
> - リージョンやネットワーク制限で `open.spotify.com` に直接届かない環境からの閲覧
>
> **ログインして再生する用途には向きません。** それが必要なら [Spotify Web API](https://developer.spotify.com/documentation/web-api) を使うべきで、そのための CORS 回避プロキシとして本プロジェクトを流用することもできます（`DEFAULT_UPSTREAM_HOST=api.spotify.com`）。

---

## 2. アーキテクチャ

```
                    ┌──────────────────────────────────────────────┐
                    │  Render  https://your-app.onrender.com       │
                    │                                              │
  ブラウザ  ───────► │  /                    ──► open.spotify.com/  │
                    │  /static/js/x.js      ──► open.spotify.com/… │
                    │  /__h/i.scdn.co/a.jpg ──► i.scdn.co/a.jpg    │
                    │  /__w/gew1-dealer…    ══► wss://gew1-dealer… │
                    │                                              │
                    │   ┌────────────┐  ┌───────────┐  ┌─────────┐ │
                    │   │ 本文書き換え │  │ ヘッダ衛生 │  │ LRU缓存 │ │
                    │   └────────────┘  └───────────┘  └─────────┘ │
                    └──────────────────────────────────────────────┘
```

### URL スキーム

| パス | 中継先 |
|---|---|
| `/` , `/search` , `/static/js/x.js` | `open.spotify.com` の同じパス（**デフォルトルート**） |
| `/__h/<host>/<path>` | `https://<host>/<path>` |
| `/__w/<host>/<path>` | `wss://<host>/<path>`（WebSocket） |

デフォルトルートを `open.spotify.com` に落としてあるのがポイントで、これにより上流 HTML 内の**ルート相対 URL（`/static/...`）を一切書き換えずに**動かせます。書き換えるのは絶対 URL だけなので、巨大な JS バンドルでも置換箇所が最小限で済みます。

### 書き換えルール

上流の HTML/CSS/JS/JSON には Spotify の URL が 3 通りの形で現れるため、それぞれに対応しています。

```js
// 1. 生
"https://i.scdn.co/image/abc"        ->  "/__h/i.scdn.co/image/abc"
"//encore.scdn.co/encore.css"        ->  "/__h/encore.scdn.co/encore.css"
"wss://gae2-dealer.g2.spotify.com/"  ->  "/__w/gae2-dealer.g2.spotify.com/"

// 2. JSON / JS 文字列内のスラッシュエスケープ
"https:\/\/spclient.wg.spotify.com\/x"  ->  "\/__h\/spclient.wg.spotify.com\/x"

// 3. Unicode エスケープ
"https:\u002F\u002Fapresolve.spotify.com"  ->  "\u002F__h\u002Fapresolve.spotify.com"
```

同時に以下も行います。

- `Content-Security-Policy` / `X-Frame-Options` / `HSTS` / `CORP` / `COOP` / `Permissions-Policy` ヘッダの除去
- `<meta http-equiv="Content-Security-Policy">` の除去
- `integrity` / `crossorigin` 属性の除去（本文を書き換えると SRI ハッシュが必ず不一致になるため）
- `srcset` 属性のカンマ区切り各 URL の書き換え
- `Set-Cookie` の `Domain=` 除去・`Path=/` 化・`SameSite=None; Secure` 化・`__Host-` / `__Secure-` プレフィックス剥がし
- `Location` リダイレクト先の書き換え
- `Link` ヘッダ（preload 等）の書き換え
- リクエストの `Origin` / `Referer` / `Sec-Fetch-Site` を**上流オリジン**に付け替え（Spotify API のオリジン検査対策）

### セキュリティ

`/__h/<host>/` は任意ホストを指定できてしまうため、**許可ドメインとそのサブドメイン以外への中継は 403 で拒否**します。

```
/__h/i.scdn.co/a.png              -> 200（許可）
/__h/evil.com/x                   -> 403
/__h/open.spotify.com.evil.com/x  -> 403  ← 正規表現の否定先読みで途中マッチを防止
/__h/127.0.0.1/x                  -> 403  ← SSRF 防止
```

書き換え用のホスト正規表現には末尾に `(?![a-z0-9._-])` の否定先読みを入れてあり、`open.spotify.com.evil.com` のような**サブドメイン偽装の途中マッチ**を構造的に防いでいます（ユニットテストで担保）。

---

## 3. クイックスタート（ローカル）

```bash
npm install
npm start
# -> http://localhost:10000/
```

```bash
npm run dev     # node --watch で自動再起動
npm test        # 65 件のユニット / E2E テスト（モック上流。ネットワーク不要）

# 実物の open.spotify.com を相手にしたライブ検証（デプロイ後の確認に便利）
SPX_BASE=http://localhost:10000 npm run verify
SPX_BASE=https://your-app.onrender.com SPX_TOKEN=<ACCESS_TOKEN> npm run verify
```

動作確認:

```bash
curl -s http://localhost:10000/healthz          # ok
curl -s http://localhost:10000/__spx/info | jq  # 設定とルート一覧
curl -s http://localhost:10000/__spx/stats | jq # キャッシュ統計
open  http://localhost:10000/__spx/demo         # iframe 表示デモ

# ACCESS_TOKEN を設定した場合は ?token= を付ける
ACCESS_TOKEN=secret npm start
open "http://localhost:10000/__spx/demo?token=secret"
```

---

## 4. デプロイ

### 4-A. Render

#### Blueprint（おすすめ・`render.yaml` 同梱）

1. このディレクトリを GitHub / GitLab リポジトリに push する
   ```bash
   git init && git add -A && git commit -m "spotify reverse proxy"
   git remote add origin git@github.com:<you>/<repo>.git
   git push -u origin main
   ```
2. Render ダッシュボード → **New +** → **Blueprint** → リポジトリを選択
3. `render.yaml` が自動認識され、設定済みの Web Service が作成される
   - Runtime: **Node**（`Dockerfile` は使わない）
   - Build: `npm ci --omit=dev`
   - Health Check: `/healthz`
   - `ACCESS_TOKEN` は **Generate** で自動生成される
4. デプロイ完了後、`https://<your-app>.onrender.com/` を開く

#### 手動で作る場合

| 項目 | 値 |
|---|---|
| Environment | **Node** |
| Region | Singapore（日本から最短） |
| Plan | Free |
| Build Command | `npm ci --omit=dev` |
| Start Command | `node server.js` |
| Health Check Path | `/healthz` |
| Env | `NODE_VERSION=22.23.3` / `ACCESS_TOKEN=<長い乱数>` |

> **無料プランは 15 分無通信でスリープ**し、再開に 30〜60 秒かかります。常時稼働させるなら Starter プラン以上が必要です。

---

### 4-B. Railway

> ⚠️ **`railway.json` / `railway.toml`（Config as Code）は使っていません。**
> 公式に**非推奨**で、**新規サービスでは利用できず**、既存サービスも **2026-12-01** に読まれなくなります。
> 後継の **Infrastructure as Code**（`.railway/railway.ts`）を同梱してあります。

#### 方法 1: ダッシュボード（一番簡単・設定ファイル不要）

リポジトリ直下に `Dockerfile` があるので、**Railway は自動的に Dockerfile ビルダーを使います**（公式仕様）。

1. [railway.com](https://railway.com) → **New Project** → **Deploy from GitHub Repo**
2. リポジトリを選択 → 自動でビルドが走る
3. サービスの **Settings → Networking → Generate Domain** で公開 URL を発行
4. **Variables** タブで以下を設定
   ```
   ACCESS_TOKEN=<openssl rand -hex 32 の出力>
   ```
5. **Settings → Deploy → Healthcheck Path** に `/healthz` を設定
6. `https://<app>.up.railway.app/` を開く

`PORT` は Railway が自動注入するので**設定しない**でください（本アプリは `process.env.PORT` を読みます）。

#### 方法 2: Railway CLI（`railway up`）

```bash
npm install -g @railway/cli
railway login

cd spotify-reverse-proxy
railway init                              # プロジェクト作成（名前: spotify-reverse-proxy）
railway variables --set "ACCESS_TOKEN=$(openssl rand -hex 32)"
railway variables --set "LOG_LEVEL=info"
railway up                                # ローカルのコードをそのままビルド＆デプロイ
railway domain                            # 公開ドメインを発行
railway logs                              # ログを tail
```

#### 方法 3: Infrastructure as Code（`.railway/railway.ts`）

環境変数・ヘルスチェック・レプリカ数まで含めてコードで再現可能にする方法です。

```bash
npm install                     # devDependencies の railway SDK が入る
npm install -g @railway/cli     # 初回のみ

railway login
railway link                    # プロジェクト / 環境をこのディレクトリに紐づけ

npm run railway:plan            # 差分プレビュー（読み取り専用・安全）
npm run railway:apply           # 確認しながら適用
npm run railway:pull            # 逆に Railway 側の現状を railway.ts に取り込む
```

`.railway/railway.ts` の要点:

```ts
const proxy = service("spotify-reverse-proxy", {
  source: github("<owner>/<repo>", { branch: "main" }),
  start: "node server.js",
  healthcheck: "/healthz",        // 認証不要なので ACCESS_TOKEN 設定後も 200
  healthcheckTimeout: 120,
  replicas: 1,
  env: {
    NODE_ENV: "production",
    LOG_LEVEL: prod ? "info" : "debug",   // 環境ごとに分岐
    CACHE_MAX_BYTES: "52428800",          // 0.5GB RAM プラン向けに 50MB
    ACCESS_TOKEN: preserve(),             // ★ 値はソースに書かず Railway 側を維持
    // ...
  },
});
```

**`ACCESS_TOKEN` は `preserve()`** にしてあるので、シークレットが Git に入りません。初回は以下で設定してください。

```bash
railway variables --set "ACCESS_TOKEN=$(openssl rand -hex 32)"
```

> `.railway/railway.ts` の `source: github(...)` は **あなたのリポジトリに書き換えて**ください。
> 検証用に `test/railway-iac.test.js` でグラフ生成をチェックしています（`npm test` に含まれます）。

#### Railway の料金（2026 年時点）

- 恒久的な無料枠は**ありません**。**30 日間のトライアルに $5 クレジット**が付与され、以降は **Hobby $5/月**（$5 の利用クレジット込み）
- 下位プランは **1 vCPU / 0.5GB RAM / サービス**。本アプリは実測 RSS 100〜130MB なので余裕があります
- Render と違い**アイドルスリープが無い**ので、常時稼働させたいなら Railway の方が素直です
- 詳細は [railway.com/pricing](https://railway.com/pricing)

#### Railway 特有の注意

| 項目 | 内容 |
|---|---|
| `PORT` | 自動注入。**`.env` や Variables で固定しないこと** |
| 待ち受け | `0.0.0.0` 必須（本アプリの既定値） |
| 公開ドメイン | 自動では付かない。**Generate Domain** か `railway domain` が必要 |
| ヘルスチェック | Dockerfile の `HEALTHCHECK` は無視される。`healthcheckPath` / `healthcheck: "/healthz"` で指定 |
| ビルダー | `Dockerfile` があれば常にそれが使われる。Railpack に変えたい場合はダッシュボードの Service Settings → Build で切替（`.node-version` = 22 が参照されます） |
| 起動ログ | `RAILWAY_PUBLIC_DOMAIN` を検出してアクセス先 URL を自動出力します |

---

### 4-C. Docker（Fly.io / Cloud Run など）

```bash
docker build -t spotify-reverse-proxy .
docker run --rm -p 10000:10000 \
  -e ACCESS_TOKEN=$(openssl rand -hex 32) \
  spotify-reverse-proxy
# -> http://localhost:10000/
```

イメージは `node:22-alpine` ベースで、`server.js` / `lib/` / `assets/` / 本番依存のみを含みます（devDependencies と test は `.dockerignore` で除外）。非 root（`USER node`）で起動します。

---

### デプロイ後の確認

```bash
BASE=https://<your-app>.onrender.com        # または https://<app>.up.railway.app
TOKEN=<ACCESS_TOKEN>

curl -s $BASE/healthz                                        # ok（認証不要）
curl -s "$BASE/__spx/info?token=$TOKEN" | jq .routes         # ルート一覧
curl -s "$BASE/__spx/stats?token=$TOKEN" | jq .cache         # キャッシュ統計
curl -sI "$BASE/?token=$TOKEN" | grep -i '^set-cookie'       # 認証 Cookie が付く

# 22 項目のライブ検証
SPX_BASE=$BASE SPX_TOKEN=$TOKEN npm run verify
```

ブラウザで `$BASE/__spx/demo?token=$TOKEN` を開くと、iframe 表示デモページがそのまま使えます。

---

## 5. 環境変数

すべて省略可能（既定値で `open.spotify.com` へのプロキシとして動きます）。

| 変数 | 既定値 | 説明 |
|---|---|---|
| `PORT` | `10000` | 待ち受けポート。**Render が自動注入するので設定不要** |
| `HOST` | `0.0.0.0` | 待ち受けアドレス |
| `LOG_LEVEL` | `info` | `error` / `warn` / `info` / `debug` |
| `DEBUG_HEADERS` | `false` | `true` で `x-spx-upstream` ヘッダを付与（デバッグ用） |
| `DEFAULT_UPSTREAM_HOST` | `open.spotify.com` | デフォルトルートの中継先。`api.spotify.com` にすれば API プロキシになる |
| `UPSTREAM_SCHEME` | `https` | `http` はローカル検証用 |
| `HOST_PREFIX` | `/__h/` | ホスト指定プロキシのパスプレフィックス |
| `WS_PREFIX` | `/__w/` | WebSocket プロキシのパスプレフィックス |
| `UPSTREAM_TIMEOUT_MS` | `30000` | 上流の**ヘッダ受信**タイムアウト（本文のストリーミングは制限しない） |
| `MAX_REWRITE_BYTES` | `67108864` | これを超えるテキストは書き換えず素通し |
| `PROXY_ALLOW_DOMAINS` | Spotify 系 9 ドメイン | カンマ区切り。中継を許可する登録可能ドメイン |
| `CACHE_MAX_BYTES` | `67108864` | 書き換え済みレスポンスの LRU キャッシュ上限。**0 で無効化** |
| `CACHE_MAX_ENTRIES` | `300` | キャッシュ最大エントリ数 |
| `CACHE_MAX_TTL_SEC` | `3600` | キャッシュ TTL の上限（上流の `max-age` がこれより短ければそちらを優先） |
| `ACCESS_TOKEN` | *(空)* | **空だと完全公開プロキシになる。** 公開 URL では必ず設定すること |
| `ALLOW_EMBED` | `true` | `false` で iframe 埋め込み禁止（Cookie が `SameSite=Lax` になる） |
| `FRAME_ANCESTORS` | `*` | 埋め込みを許可するオリジン。例 `https://example.com` |
| `CORS_ORIGINS` | *(空)* | カンマ区切り or `*`。別オリジンのフロントから叩く場合のみ |
| `USER_AGENT` | *(空)* | 空なら利用者のブラウザ UA をそのまま転送 |
| `ACCEPT_LANGUAGE` | `ja,en-US;q=0.9,en;q=0.8` | 上流へ送る Accept-Language |

### `ACCESS_TOKEN` の渡し方（3 通り）

```bash
# 1. クエリ（初回は Set-Cookie: spx_token=... が返るので以降は自動）
open "https://<your-app>.onrender.com/?token=YOUR_TOKEN"

# 2. Authorization ヘッダ
curl -H "Authorization: Bearer YOUR_TOKEN" https://<your-app>.onrender.com/

# 3. Cookie
curl -H "Cookie: spx_token=YOUR_TOKEN" https://<your-app>.onrender.com/
```

`/healthz` だけは認証不要です（Render のヘルスチェックが 401 で止まらないようにするため）。`/__spx/*` は設定内容を返すので **`ACCESS_TOKEN` 設定時は認証が必要**です。

---

## 6. エンドポイント

| パス | 説明 |
|---|---|
| `/` , `/<path>` | `open.spotify.com` を中継 |
| `/__h/<host>/<path>` | 指定ホストを中継（許可ドメインのみ） |
| `/__w/<host>/<path>` | WebSocket を中継 |
| `/__spx/info` | 現在の設定・ルート一覧（JSON） |
| `/__spx/stats` | キャッシュ統計・メモリ使用量（JSON） |
| `/__spx/demo` | iframe 表示デモページ |
| `/__spx/client.js` | 注入されるランタイムパッチのソース |
| `DELETE /__spx/cache` | キャッシュをクリア |
| `/healthz` | ヘルスチェック（`ok`） |

---

## 7. 実測（このリポジトリのコードで計測）

`open.spotify.com` のトップページを本プロキシ経由で読み込んだ結果：

```
GET /            -> 200  text/html  176,065 bytes
  CSP            : frame-ancestors *        ← 上流の厳格な CSP は除去、自前の埋め込み許可のみ
  X-Frame-Options: (removed)
  /__h/ 出現数   : 36        /__w/ 出現数: 3
  書き換え漏れ   : 0         integrity 残: 0   crossorigin 残: 0

実アセット 19 件 -> 全て 200 OK
  （web-player.css / *.js x4 / フォント woff2 x4 / favicon x3 / manifest.json
    / ロケール ja.json / opensearch.xml）

最大 JS バンドル web-player.1eb7daa6.js (4,350 KB)
  /__h/ 出現: 95    書き換え漏れ(raw): 0    書き換え漏れ(escaped): 0

CSS 内 url() 参照 40 件 -> 39 OK（残 1 件は url(#fragment) で実リクエストではない）
manifest.json の start_url / icons -> 正しく /__h/... に書き換え済み
```

### 性能

```
アセット 8 件 (7.0MB) 一括ロード:
  1回目 (cold) : 639 ms   HIT=0  MISS=8
  2回目 (warm) : 132 ms   HIT=8  MISS=0   ← 4.8 倍高速
  3回目 (warm) :  98 ms   HIT=8  MISS=0   ← 6.5 倍高速

gzip 圧縮  : 4.35 MB -> 1.22 MB（72% 削減、非同期 gzip なのでイベントループをブロックしない）
メモリ     : RSS 125 MB / ヒープ 32 MB（キャッシュ 9.1 MB 保持時）
並列       : HTML 20 並列 574 ms / 50 並列 1,625 ms
書き換え   : 2.4 MB のテキストを約 60 ms
```

---

## 8. 仕組みの詳細

### 静的書き換え（サーバ側）

`lib/rewrite.js` が 7 本の正規表現で本文を置換します。許可ドメインからホスト正規表現を動的生成するため、`PROXY_ALLOW_DOMAINS` を変えるだけで対象ドメインを増減できます。

```js
// ラベル列 + 登録可能ドメイン + 否定先読み
(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*(?:spotify\.com|scdn\.co|...)(?![a-z0-9._-])
```

### ランタイムパッチ（ブラウザ側）

`assets/spx-client.js` を `<head>` の**先頭**にインライン注入します（他のどのスクリプトよりも先に実行される必要があるため）。以下をフックします。

- `window.fetch` — 文字列 / `URL` / `Request` のすべての形に対応
- `XMLHttpRequest.prototype.open`
- `window.WebSocket` — `wss://dealer...` を `wss://自オリジン/__w/dealer...` に
- `window.EventSource`
- `navigator.sendBeacon`
- `window.open`
- `Element.prototype.setAttribute` — `src` / `href` / `poster` / `srcset` / `data-*` など
- `HTMLScriptElement.src` ほか 15 種の要素プロパティの setter
- `navigator.serviceWorker.register` — **無効化**（スコープがこのオリジン配下になり上流前提のキャッシュが壊れるため）

これがあることで、`apresolve.spotify.com` が返す JSON 内のアクセスポイント URL のように**実行時に初めて分かる URL** もプロキシ経由に載せられます。

### WebSocket

`/__w/<host>/<path>` への HTTP Upgrade を横取りし、`ws` で上流に接続して双方向に中継します。Open 前に届いたクライアントメッセージは最大 256 件バッファし、`bufferedAmount` が 8MB を超えたらバックプレッシャとして切断します。

### キャッシュ

`lib/cache.js` の LRU。上流の `Cache-Control` に従い、以下は保存しません。

- `no-store` / `no-cache` / `must-revalidate`
- `Set-Cookie` を含むレスポンス（利用者間で混ざるため）
- 200 以外、GET 以外

Spotify のハッシュ付き静的アセットは `public, max-age=31536000, immutable` なので確実にヒットします。gzip 済みバイト列も一緒に保持するため、2 回目以降は圧縮 CPU コストもゼロです。ヒット状況は `x-spx-cache: HIT|MISS|BYPASS` ヘッダと `/__spx/stats` で確認できます。

---

## 9. トラブルシューティング

### ページが真っ白

1. ブラウザの DevTools → Network で **4xx / 5xx のリソース**を探す
2. その URL が `/__h/<許可外ホスト>/...` なら `PROXY_ALLOW_DOMAINS` にドメインを追加
3. `x-spx-upstream` を見たい場合は `DEBUG_HEADERS=true`
4. Console に `Refused to ...` 系の CSP エラーが出ていれば、上流が `<meta>` で CSP を再注入していないか確認（`stripMetaCsp` で除去しています）

### 502「上流サーバーに接続できませんでした」

- **PaaS のアウトバウンド IP が Akamai にブロックされている**可能性があります。Render なら `region` を変える（`oregon` / `frankfurt` / `ohio`）、Railway ならリージョンを変えて試してください
  - 実測では Render / Railway どちらの IP 帯からも `open.spotify.com` に到達できていますが、データセンター IP 全般に対する Spotify 側の方針は変わり得ます
- `USER_AGENT` に実在のブラウザ UA を固定すると通ることがあります
- 上流の障害・レート制限の可能性もあるので、直接 `https://open.spotify.com/` に到達できるかも確認

### 再生できない

想定内です。Widevine のライセンスサーバーがオリジンを検査するため、`open.spotify.com` 以外からは許可されません。回避手段はありません。

### ログインできない

`accounts.spotify.com` の OAuth は `redirect_uri` のホワイトリスト検査があるため、プロキシオリジンへのリダイレクトは拒否されます。

### iframe で表示できない

- `ALLOW_EMBED=true`（既定）であることを確認
- `FRAME_ANCESTORS` が埋め込み元オリジンを許可しているか（既定 `*`）
- **親ページ側**の CSP に `frame-src` 制限があると埋め込めません
- `ACCESS_TOKEN` を使っている場合、iframe 内ではサードパーティ Cookie が送られないため、親ページと同じオリジンから埋め込むか `?token=` を iframe の URL に直接付けてください

### 重い / 遅い

- `/__spx/stats` で `hitRate` を確認。低い場合は `CACHE_MAX_BYTES` を増やす
- `LOG_LEVEL=debug` は大量にログを出すので本番では `info` に
- 無料プランのスリープ復帰は 30〜60 秒かかります

---

## 10. プロジェクト構成

```
spotify-reverse-proxy/
├── server.js               # HTTP サーバ / ルーティング / プロキシ本体
├── lib/
│   ├── config.js           # 環境変数の読み込みとロガー
│   ├── hosts.js            # ホスト許可判定・パス分解・URL 変換
│   ├── rewrite.js          # 本文の URL 書き換え（HTML/CSS/JS/JSON）
│   ├── headers.js          # リクエスト/レスポンスヘッダの衛生と書き換え
│   ├── inject.js           # HTML へのランタイムパッチ注入
│   ├── client.js           # クライアントスクリプト / デモページの読み込み
│   ├── cache.js            # 書き換え済みレスポンスの LRU キャッシュ
│   └── ws-proxy.js         # WebSocket リバースプロキシ
├── assets/
│   ├── spx-client.js       # ブラウザに注入するランタイムパッチ
│   └── demo.html           # /__spx/demo の iframe デモページ
├── test/
│   ├── rewrite.test.js     # 書き換えロジック（サブドメイン偽装防止を含む）
│   ├── hosts.test.js       # ホスト許可 / パス分解
│   ├── headers.test.js     # ヘッダ衛生 / Set-Cookie / Location
│   ├── e2e.test.js         # モック上流 + 実サーバ起動の結合テスト
│   └── railway-iac.test.js # .railway/railway.ts のグラフ検証 / Node バージョン検査
├── scripts/
│   └── live-smoke.mjs      # 実 Spotify に対するライブ検証（npm run verify）
├── .railway/
│   ├── railway.ts          # Railway Infrastructure as Code（IaC）
│   └── README.md           # IaC の使い方
├── render.yaml             # Render Blueprint
├── Dockerfile              # Railway / Fly.io / Cloud Run 用（Railway は自動検出）
├── .dockerignore
├── .node-version           # 22（Railpack / Nixpacks / fnm / mise 用）
├── .nvmrc                  # 22
├── .env.example            # 環境変数サンプル
└── package.json
```

### テスト

```bash
npm test
# tests 71 / pass 71 / fail 0

npm run verify   # 実 Spotify を相手としたライブ検証（要ネットワーク）
# 22 PASS / 0 FAIL
```

- **Railway IaC**: `.railway/railway.ts` を実際に `railway/iac` SDK で評価し、service / healthcheck / startCommand / `preserve()` を検証。あわせて「非推奨の `railway.json` を置いていないこと」「Dockerfile と `.node-version` と `render.yaml` が EOL の Node 20 を指していないこと」も検査する
- **ユニット**: 書き換え（生 / エスケープ / Unicode / CSS / srcset / 入れ子スキーム / サブドメイン偽装）、ホスト許可判定、ヘッダ衛生、Set-Cookie 書き換え
- **E2E**: モック上流サーバを立て、実サーバを子プロセスで起動。HTML 書き換え・CSP 除去・ランタイムパッチ注入位置・JS バンドルのエスケープ形・Location・Set-Cookie・バイナリ素通し・上限超過ストリーム・gzip・POST ボディ・**WebSocket 双方向中継**・403 拒否・キャッシュ HIT/MISS・`ACCESS_TOKEN` 認証を通す
- **性能スモーク**: 2.4MB のテキスト書き換えが 15 秒以内

---

## 11. 法的・規約上の注意

- 本コードはリバースプロキシの**技術的実装例**です。Spotify の [利用規約](https://www.spotify.com/legal/end-user-agreement/) は自動アクセス・改変・再配信を制限している可能性があり、**本プロキシの利用が規約違反にあたる場合があります**。
- Spotify のロゴ・楽曲・メタデータの再配信には権利上の制限があります。**公開サービスとして第三者に提供しないでください。**
- `ACCESS_TOKEN` を設定しない場合、あなたの Render インスタンスは**誰でも使える Spotify へのオープンプロキシ**になります。滥用されれば IP ブロックや Render の利用規約違反（アカウント停止）につながります。**公開 URL に置く場合は必ず `ACCESS_TOKEN` を設定してください。**
- 学習・検証・個人利用の範囲にとどめ、自己責任で使用してください。

---

## 12. 発展（アイデア）

- `DEFAULT_UPSTREAM_HOST=api.spotify.com` + `CORS_ORIGINS` で **Spotify Web API の CORS 回避プロキシ**として使う
- `assets/spx-client.js` に `document.title` / OG メタの差し替えを追加して、見た目を変えたプレイヤーにする
- `lib/cache.js` を Redis（Render の Key Value）に差し替えて複数インスタンスでキャッシュを共有する
- `/__h/<host>/<path>` の応答をディスクに永続化して、オフライン閲覧用のミラーを作る

---

## License

MIT
