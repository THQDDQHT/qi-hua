---
name: verify
summary: 运行公众前端与 API，观察公众生图改动的真实表面
---

# 运行时验证

## API（无 PostgreSQL 时）

使用不可连接的数据库即可观察 `/health/live`、`/health/ready` 和启动时回收失败的受控日志：

```bash
env PORT=33101 \
  DATABASE_URL='postgres://invalid:invalid@127.0.0.1:1/invalid?connect_timeout=1' \
  AI_BASE_URL='https://provider.invalid/v1' AI_API_KEY=placeholder AI_MODEL=placeholder \
  ANON_TOKEN_SECRET=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  IP_HASH_SECRET=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  IDEMPOTENCY_SECRET=cccccccccccccccccccccccccccccccc \
  PUBLIC_ORIGIN='http://127.0.0.1:34100' PUBLIC_GENERATION_ENABLED=false \
  UPSTREAM_TIMEOUT_MS=1000 RESERVATION_TTL_SECONDS=7 \
  bun --cwd server src/index.ts
```

观察：

```bash
curl -i http://127.0.0.1:33101/health/live
curl -i http://127.0.0.1:33101/health/ready
```

匿名 session、quota 和图片写接口需要真实 PostgreSQL 迁移，不能用上述降级启动完成端到端验证。

## Public Web

```bash
cd web
VITE_APP_MODE=public ./node_modules/.bin/vite --host 127.0.0.1 --port 34100
```

用浏览器访问 `/`，应跳转 `/image`。同时观察 `/image`、`/canvas`、`/assets`、`/manifest.webmanifest` 和 `/sw.js`。

Vite 开发服务器不会代理 `/api/*`；完整公众会话必须通过生产 Nginx 或另行配置同源代理。

## 部署脚本

脚本应可直接执行：

```bash
./deploy/public/scripts/check-public-config.sh
./deploy/public/scripts/check-public-log-safety.sh /path/to/log
PUBLIC_ORIGIN=https://example.test ./deploy/public/scripts/smoke-public.sh
```

`check-public-config.sh` 需要 `.env.public`、TLS 文件和 Docker。不要为了验证创建或提交真实生产密钥。
