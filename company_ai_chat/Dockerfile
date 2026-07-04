# node:sqlite を使うため Node 22.5+ が必須。
# 依存パッケージはビルド時のnpm installを避けるため node_modules ごと
# リポジトリに含めている(社内ネットワークのSSL検査機器等でビルドサーバーからの
# npmレジストリ接続が失敗する環境でも問題なくビルドできるように)。
# ネイティブバイナリ依存(ビルド環境と実行環境でOS/libcが違うと動かない)は
# 意図的に避けている。PDF抽出に unpdf を使っているのもそのため
# (pdf-parseは@napi-rs/canvasというネイティブ依存を必須で持つため不採用)。
FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY node_modules ./node_modules
COPY server.js ./
COPY lib ./lib
COPY public ./public

ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/app/data

# SQLite DB と生成画像の保存先。Coolify 等では /app/data に
# 永続ボリュームをマウントすること(しないと再デプロイでデータが消える)。
RUN mkdir -p /app/data

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
