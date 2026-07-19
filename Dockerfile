# 构建 Vite 前端产物。
FROM oven/bun:1.3.13 AS web-build

WORKDIR /app/web
ARG VITE_APP_MODE=self-hosted
ENV VITE_APP_MODE=$VITE_APP_MODE
COPY web/package.json web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --cache-dir=/root/.bun/install/cache
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY web ./
RUN bun run build

# 运行镜像：只启动静态前端，AI 请求由浏览器前台直连用户自己的接口。
FROM nginx:1.27-alpine AS self-hosted-base

COPY --from=web-build /app/web/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 3000

# 公众镜像：Nginx 是唯一公开入口，反代 Docker 私有网络中的 API。
FROM nginx:1.27-alpine AS public-web

COPY --from=web-build /app/web/dist /usr/share/nginx/html
COPY deploy/public/nginx/public.conf /etc/nginx/conf.d/default.conf
COPY deploy/public/nginx/cloudflare-trusted.conf /etc/nginx/includes/cloudflare-trusted.conf
COPY deploy/public/nginx/proxy-public.conf /etc/nginx/includes/proxy-public.conf
COPY deploy/public/nginx/security-headers.conf /etc/nginx/includes/security-headers.conf

EXPOSE 80

# 维护镜像：抓取第三方提示词封面并生成服务器本地提示词库。
FROM oven/bun:1.3.13 AS prompt-sync-dependencies

WORKDIR /app
COPY server/package.json server/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile --production --cache-dir=/root/.bun/install/cache

FROM oven/bun:1.3.13 AS prompt-sync

WORKDIR /app
ENV NODE_ENV=production
COPY --from=prompt-sync-dependencies /app/node_modules ./node_modules
COPY server/package.json server/bun.lock ./
COPY web/src/services/api/prompt-sources.ts ./web/src/services/api/prompt-sources.ts
COPY deploy/public/scripts/sync-prompt-library.ts ./deploy/public/scripts/sync-prompt-library.ts

CMD ["bun", "deploy/public/scripts/sync-prompt-library.ts"]

# 默认目标保持现有自部署静态前端行为。
FROM self-hosted-base AS self-hosted-web
