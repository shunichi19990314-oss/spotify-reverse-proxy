# Render / Railway / Fly.io / Cloud Run など、Docker 対応の PaaS 共通。
#
#  - Render : render.yaml が runtime: node を使うため既定では使われない（任意）
#  - Railway: リポジトリ直下に Dockerfile があると **常にこれを使ってビルドされる**
#             （公式仕様。railway.json で builder を指定する必要はない）
#
# Node 20 は 2026-04-30 に EOL のため、Node 22 LTS (Jod) を使う。
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# 依存関係を先にコピーしてレイヤーキャッシュを効かせる。
# devDependencies（railway SDK など）は本番イメージに入れない。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 実行に必要なファイルだけコピー
COPY server.js ./
COPY lib/ ./lib/
COPY assets/ ./assets/

# PORT は PaaS が実行時に注入する（Railway / Render とも）。
# 以下の既定値はローカルで `docker run -p 10000:10000` する用。
ENV PORT=10000
EXPOSE 10000

# Railway は独自の HTTP ヘルスチェック（healthcheckPath=/healthz）を使うので
# この HEALTHCHECK は docker run / compose 用。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||10000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
CMD ["node", "server.js"]
