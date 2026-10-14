# .railway/

Railway の **Infrastructure as Code**（IaC）ディレクトリです。

| ファイル | 役割 |
|---|---|
| `railway.ts` | サービス・環境変数・ヘルスチェックの定義（唯一の編集対象） |
| `README.md` | この説明 |

## 前提

`railway.json` / `railway.toml`（旧 Config as Code）は**非推奨**です。
新規サービスでは利用できず、既存サービスも **2026-12-01** に読まれなくなります。
このディレクトリが後継です。

## セットアップ

```bash
npm install                       # devDependencies の railway SDK が入る
npm install -g @railway/cli       # CLI（初回のみ）

railway login                     # ブラウザが開いて認証
railway link                      # プロジェクトと環境をこのディレクトリに紐づけ
```

## 運用

```bash
npm run railway:plan     # 差分をプレビュー（読み取り専用・安全）
npm run railway:apply    # 確認しながら適用
npm run railway:pull     # Railway 側の現在の設定を railway.ts に取り込む

railway variables --set "ACCESS_TOKEN=$(openssl rand -hex 32)"
railway up               # ローカルのコードを直接デプロイ（IaC を経由しない手早い方法）
railway domain           # 公開ドメイン（xxxx.up.railway.app）を生成
railway logs             # ログを tail
```

## 注意

- **`railway.ts` にシークレットの値を書かないでください。** `ACCESS_TOKEN` は `preserve()`（＝Railway 側の既存値を維持）にしてあります。初回は `railway variables --set` かダッシュボードで設定します。
- `railway config apply` は破壊的変更（サービスや変数の削除）を伴う場合、`--yes` だけでは実行されず `--confirm-destructive` も必要です。
- 1 つのリポジトリに複数のサービスがある場合は `export const partial = "spotify-proxy";` を追加して partial 化できます。
- `railway config plan --detailed-exit-code` で CI のドリフト検知に使えます（差分なし=0, 差分あり=2）。
