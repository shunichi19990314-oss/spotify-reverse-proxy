# 通常は不要（render.yaml は runtime: node を使う）。
# Docker ランタイムでデプロイしたい場合のみ使用する。
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# 依存関係を先にコピーしてレイヤーキャッシュを効かせる
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY server.js ./
COPY lib/ ./lib/
COPY assets/ ./assets/

# Render が PORT を注入する。ローカル実行用の既定値だけ持たせる
ENV PORT=10000
EXPOSE 10000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||10000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
CMD ["node", "server.js"]
