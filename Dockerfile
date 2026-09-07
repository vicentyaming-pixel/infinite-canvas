# 构建 Vite 前端产物。
FROM oven/bun:1.3.13 AS web-build

WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --cache-dir=/root/.bun/install/cache
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY web ./
RUN bun run build

# 安装可选的对象存储网关依赖。
FROM node:22-alpine AS server-deps

WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# 运行镜像：Node 同时提供静态前端与 S3 兼容对象存储网关。
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY --from=web-build /app/web/dist ./web/dist
COPY --from=server-deps /app/server/node_modules ./server/node_modules
COPY server/package.json server/index.mjs ./server/

EXPOSE 3000

CMD ["node", "server/index.mjs"]
