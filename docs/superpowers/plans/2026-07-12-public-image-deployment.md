# 公众生图部署与上线加固实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在自有服务器上通过 Cloudflare、Nginx、Bun 接口服务和现有 PostgreSQL 安全部署公众免费生图版本，并提供可快速关闭生成的止损流程。

**Architecture:** Cloudflare 是唯一公网入口；防火墙只允许 Cloudflare 地址段访问 Nginx。Nginx 提供静态网页、恢复真实来源地址、限制 `/api/images/*` 的短时频率，并反向代理到仅在 Docker 内部网络监听的 Bun 服务；接口服务连接服务器已有 PostgreSQL，不在本项目重复创建数据库。

**Tech Stack:** Docker Compose、Nginx、Bun、PostgreSQL、Cloudflare、Shell。

## Global Constraints

- 生产环境不创建新的 PostgreSQL 容器，必须使用已有数据库和独立数据库账号。
- `api` 容器不映射公网端口，只有 `web` 暴露站点端口。
- 源站必须先限制为 Cloudflare 流量，再信任 `CF-Connecting-IP`。
- 图片接口平均每个来源地址每分钟 5 次，允许 2 次瞬时突发，超限返回 429。
- Nginx 请求体上限覆盖 20MB 参考图总量并预留表单开销，上游读取超时大于接口服务 180 秒超时。
- 不设置全站每日图片总量上限，不添加 `GLOBAL_DAILY_LIMIT`。
- 必须可通过修改运行时环境变量 `PUBLIC_GENERATION_ENABLED=false` 并重启 api 立即止损。
- 日志不得包含 Cookie、提示词、图片、上游密钥和明文网络地址。
- 上线顺序固定为：关闭生成、备份数据库、迁移、启动接口、就绪检查、启动网页、内部验证、开放流量、开启生成。
- 不执行前端或服务端构建验证；只验证容器配置、Nginx 配置、迁移和运行时健康状态。

---

## File Map

```text
Dockerfile                                      公众/自部署前端构建参数
nginx.conf                                      静态站点、反代和频率限制
docker-compose.yml                              web/api 双服务生产拓扑
docker-compose.local.yml                        本地双服务拓扑
.env.public.example                             非敏感生产变量模板
deploy/cloudflare-real-ip.conf                  Cloudflare 地址段的 Nginx real_ip 配置
deploy/update-cloudflare-ips.sh                  从官方地址列表生成配置
deploy/migrate.sh                               显式执行数据库迁移
deploy/smoke-test.sh                            健康、会话和关闭开关冒烟检查
docs/content/docs/overview/public-deployment.mdx 公众部署说明
docs/content/docs/support/security.mdx          公众模式安全边界
```

### Task 1: web/api 双容器拓扑

**Files:**
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `docker-compose.local.yml`
- Create: `.env.public.example`
- Test: `deploy/tests/compose-config.sh`

**Interfaces:**
- Consumes: `server/Dockerfile`、`/health/live`、`/health/ready`。
- Produces: `web` 与 `api` 服务名和内部 `api:3001` 地址。

- [ ] **Step 1: 写 Compose 配置断言**

```sh
#!/bin/sh
set -eu
config="$(docker compose --env-file .env.public.example config)"
printf '%s' "$config" | grep -q 'api:'
printf '%s' "$config" | grep -q 'web:'
if printf '%s' "$config" | grep -A20 'api:' | grep -q 'published:'; then
  echo 'api must not publish a host port' >&2
  exit 1
fi
if printf '%s' "$config" | grep -q 'postgres:'; then
  echo 'production compose must reuse external PostgreSQL' >&2
  exit 1
fi
```

- [ ] **Step 2: 运行断言确认失败**

Run: `sh deploy/tests/compose-config.sh`

Expected: FAIL，当前 Compose 只有 `app`。

- [ ] **Step 3: 改造 Compose**

`web` 从根 Dockerfile 构建并传入 `VITE_APP_MODE=public`，依赖 `api` 就绪；只映射 `${PUBLIC_PORT:-3000}:3000`。`api` 从 `server/Dockerfile` 构建，通过 `env_file` 读取环境变量，不设置 host port，加入同一私有网络并使用只读文件系统和临时 `/tmp`。

`.env.public.example` 包含完整变量名但使用不可运行的示例值；不得包含真实密钥。数据库 URL 指向已有 PostgreSQL，Compose 不定义数据库服务。

- [ ] **Step 4: 运行配置断言并提交**

Run: `sh deploy/tests/compose-config.sh`

Expected: PASS，web/api 存在、api 无公开端口、没有 postgres 服务。

```bash
git add Dockerfile docker-compose.yml docker-compose.local.yml .env.public.example deploy/tests/compose-config.sh
git commit -m "feat(deploy): 增加公众版双容器拓扑"
```

### Task 2: Cloudflare 真实地址配置生成

**Files:**
- Create: `deploy/update-cloudflare-ips.sh`
- Create: `deploy/cloudflare-real-ip.conf`
- Test: `deploy/tests/cloudflare-real-ip.sh`

**Interfaces:**
- Produces: Nginx 可 include 的 `set_real_ip_from` 列表和 `real_ip_header CF-Connecting-IP`。

- [ ] **Step 1: 写配置格式测试**

```sh
#!/bin/sh
set -eu
file=deploy/cloudflare-real-ip.conf
grep -q '^set_real_ip_from ' "$file"
grep -q '^real_ip_header CF-Connecting-IP;' "$file"
grep -q '^real_ip_recursive on;' "$file"
if grep -Ev '^(set_real_ip_from [0-9a-fA-F.:/]+;|real_ip_header CF-Connecting-IP;|real_ip_recursive on;|#.*|)$' "$file"; then
  echo 'unexpected directive in Cloudflare real IP config' >&2
  exit 1
fi
```

- [ ] **Step 2: 运行测试确认失败**

Run: `sh deploy/tests/cloudflare-real-ip.sh`

Expected: FAIL，配置文件不存在。

- [ ] **Step 3: 编写确定性更新脚本**

脚本分别读取 `https://www.cloudflare.com/ips-v4` 和 `https://www.cloudflare.com/ips-v6`，验证每行只包含 CIDR，排序去重，写入临时文件，通过格式测试后原子替换目标文件。网络失败或返回空列表时保持旧文件不变。

生成内容格式：

```nginx
# Generated from Cloudflare official IP lists.
set_real_ip_from 173.245.48.0/20;
real_ip_header CF-Connecting-IP;
real_ip_recursive on;
```

实际文件必须包含官方列表中的全部 IPv4 和 IPv6 网段，不能只保留示例网段。

- [ ] **Step 4: 生成、测试并提交**

Run: `sh deploy/update-cloudflare-ips.sh`

Run: `sh deploy/tests/cloudflare-real-ip.sh`

Expected: PASS，配置包含非空 IPv4/IPv6 列表。

```bash
git add deploy/update-cloudflare-ips.sh deploy/cloudflare-real-ip.conf deploy/tests/cloudflare-real-ip.sh
git commit -m "chore(deploy): 维护 Cloudflare 源地址列表"
```

### Task 3: Nginx 反向代理、请求体与频率限制

**Files:**
- Modify: `nginx.conf`
- Modify: `Dockerfile`
- Test: `deploy/tests/nginx-config.sh`

**Interfaces:**
- Consumes: `api:3001`、Cloudflare real_ip include。
- Produces: `/api`、`/health` 反代和 SPA fallback。

- [ ] **Step 1: 写静态配置断言**

测试必须找到：

```text
limit_req_zone $binary_remote_addr zone=image_api:10m rate=5r/m;
limit_req_status 429;
client_max_body_size 22m;
proxy_read_timeout 190s;
location ~ ^/api/images/(generations|edits)$
location /api/
location /health/
try_files $uri $uri/ /index.html;
```

- [ ] **Step 2: 运行测试确认失败**

Run: `sh deploy/tests/nginx-config.sh`

Expected: FAIL，当前 Nginx 没有反代和限流。

- [ ] **Step 3: 配置 Nginx**

在 http include 作用域设置：

```nginx
include /etc/nginx/cloudflare-real-ip.conf;
limit_req_zone $binary_remote_addr zone=image_api:10m rate=5r/m;
limit_req_status 429;
```

图片写接口使用 `limit_req zone=image_api burst=2 nodelay`。所有 API 传递 `Host`、`X-Forwarded-Proto`、`CF-Connecting-IP` 和 `Cf-Ray`，关闭缓存，读取超时 190 秒。静态资源可长缓存，`index.html` 不长缓存。增加与现有 data/blob 图片兼容的内容安全策略，不能阻止 IndexedDB Blob 预览。

- [ ] **Step 4: 在官方 Nginx 镜像验证语法**

Run: `docker run --rm -v "$PWD/nginx.conf:/etc/nginx/conf.d/default.conf:ro" -v "$PWD/deploy/cloudflare-real-ip.conf:/etc/nginx/cloudflare-real-ip.conf:ro" nginx:1.27-alpine nginx -t`

Expected: `syntax is ok` 和 `test is successful`。

- [ ] **Step 5: 提交 Nginx 配置**

```bash
git add nginx.conf Dockerfile deploy/tests/nginx-config.sh
git commit -m "feat(deploy): 增加生图接口反代和限流"
```

### Task 4: 显式迁移和安全上线脚本

**Files:**
- Create: `deploy/migrate.sh`
- Create: `deploy/smoke-test.sh`
- Test: `deploy/tests/deploy-scripts.sh`

**Interfaces:**
- Produces: 可重复执行的迁移命令和不消费图片额度的冒烟检查。

- [ ] **Step 1: 写 Shell 静态测试**

使用 `sh -n` 检查两个脚本；断言迁移脚本调用 `docker compose run --rm api bun src/db/migrate.ts`；断言冒烟脚本只访问 `/health/live`、`/health/ready`、`/api/session`，不访问图片写接口。

- [ ] **Step 2: 运行测试确认失败**

Run: `sh deploy/tests/deploy-scripts.sh`

Expected: FAIL，脚本不存在。

- [ ] **Step 3: 实现脚本**

`migrate.sh` 要求 `PUBLIC_GENERATION_ENABLED=false`，否则拒绝执行；脚本只负责调用项目迁移并在失败时立即退出。数据库备份由部署文档列为迁移前的独立强制步骤，使用服务器现有 PostgreSQL 容器的备份命令，不在项目脚本中猜测数据库镜像版本或备份目录。

`smoke-test.sh` 接受站点根地址，逐项验证 live=200、ready=200、session=200 且响应包含 `mode=public`、`limit=10`、`remaining`。使用 Cookie 文件保持同一匿名会话，结束后删除临时文件。

- [ ] **Step 4: 运行静态测试并提交**

Run: `sh deploy/tests/deploy-scripts.sh`

Expected: PASS，脚本语法和端点边界正确。

```bash
git add deploy/migrate.sh deploy/smoke-test.sh deploy/tests/deploy-scripts.sh
git commit -m "chore(deploy): 增加迁移和冒烟脚本"
```

### Task 5: Cloudflare 与源站保护操作清单

**Files:**
- Create: `docs/content/docs/overview/public-deployment.mdx`
- Modify: `docs/content/docs/overview/meta.json`
- Modify: `docs/content/docs/support/security.mdx`

- [ ] **Step 1: 写部署前置条件**

文档明确要求 Cloudflare 代理状态开启、全程严格 TLS、源站证书、80/443 防火墙仅允许 Cloudflare 官方地址段、SSH 和 PostgreSQL 不对公网开放、数据库使用最小权限账号。

- [ ] **Step 2: 写生产变量和密钥轮换**

逐项解释 `.env.public.example`，强调 `ANON_TOKEN_SECRET` 轮换会让所有匿名设备获得新凭证，`IP_HASH_SECRET` 轮换会重置当日地址关联，`AI_API_KEY` 轮换不应重新构建前端。

- [ ] **Step 3: 写上线与回滚顺序**

上线步骤必须逐条列出：

```text
1. PUBLIC_GENERATION_ENABLED=false
2. 数据库备份
3. 执行迁移
4. 启动 api 并检查 ready
5. 启动 web
6. 执行 smoke-test
7. 内部生成 1 张并核对额度
8. 开放 Cloudflare 流量
9. PUBLIC_GENERATION_ENABLED=true
```

回滚优先关闭生成，再回滚 web；只要迁移是向后兼容增加表，就不删除表和数据。

- [ ] **Step 4: 提交部署文档**

```bash
git add docs/content/docs/overview/public-deployment.mdx docs/content/docs/overview/meta.json docs/content/docs/support/security.mdx
git commit -m "docs(deploy): 增加公众生图部署说明"
```

### Task 6: 日志、告警与止损验证

**Files:**
- Modify: `server/src/index.ts`
- Modify: `server/src/services/generation-service.ts`
- Create: `deploy/check-logs.sh`
- Test: `server/tests/public-logging.test.ts`
- Test: `deploy/tests/log-safety.sh`

**Interfaces:**
- Produces: JSON 行日志字段 `requestId`、`clientId`、`ipHashPrefix`、`cfRay`、`durationMs`、`requestedCount`、`successCount`、`errorCode`。

- [ ] **Step 1: 写日志脱敏测试**

生成一次带已知提示词、Cookie、明文地址和假密钥的请求，断言日志包含请求号和错误码，不包含四个敏感原文。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && bun test tests/public-logging.test.ts`

Expected: FAIL，当前没有约束后的结构化日志。

- [ ] **Step 3: 实现结构化日志和检查脚本**

日志中的 `clientId` 使用内部 UUID，`ipHashPrefix` 只取当日摘要前 12 个十六进制字符。错误对象只输出错误码和受控消息。`check-logs.sh` 汇总最近一小时请求量、成功图片数、失败率、429 数量和上游超时，不打印提示词。

告警阈值首期固定为：15 分钟请求量超过平时人工设定基线的 3 倍、失败率超过 30%、连续 5 次上游超时、上游余额低于运营设定值。余额阈值放在监控配置，不进入前端。

- [ ] **Step 4: 验证关闭开关**

在测试环境设置 `PUBLIC_GENERATION_ENABLED=false`，重启 api，确认 `/api/session` 可用、图片写接口返回 503 和 `PUBLIC_GENERATION_OFF`、供应商模拟器调用次数为 0。

- [ ] **Step 5: 运行测试并提交**

Run: `cd server && bun test tests/public-logging.test.ts`

Run: `sh deploy/tests/log-safety.sh`

Expected: PASS，日志无敏感原文，关闭开关不调用上游。

```bash
git add server/src/index.ts server/src/services/generation-service.ts server/tests/public-logging.test.ts deploy/check-logs.sh deploy/tests/log-safety.sh
git commit -m "feat(ops): 增加公众生图日志和止损检查"
```

### Task 7: 最终配置验证和试运行记录

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/content/docs/progress/todo.mdx`
- Modify: `docs/content/docs/progress/pending-test.mdx`
- Modify: `docs/index.md`

- [ ] **Step 1: 运行全部部署静态验证**

Run: `sh deploy/tests/compose-config.sh && sh deploy/tests/cloudflare-real-ip.sh && sh deploy/tests/nginx-config.sh && sh deploy/tests/deploy-scripts.sh && sh deploy/tests/log-safety.sh`

Run: `docker compose --env-file .env.public config >/dev/null`

Run: `git diff --check`

Expected: 全部命令以 0 退出，Compose 可解析，差异无空白错误。

- [ ] **Step 2: 在测试域名执行试运行**

保持生成关闭，执行迁移、启动、ready 和 session 冒烟；开启后从同一设备成功生成 10 张并确认第 11 张返回设备额度错误；用同一测试网络下不同临时浏览器验证地址累计到 30；在一分钟内触发超过 7 次写请求验证 Nginx 返回 429。

- [ ] **Step 3: 验证源站不可绕过**

从非 Cloudflare 网络直接访问源站地址，确认防火墙拒绝连接；带伪造 `CF-Connecting-IP` 也不能到达 Nginx。通过域名访问时确认应用日志中的 `Cf-Ray` 能与 Cloudflare 请求对应。

- [ ] **Step 4: 更新版本文档**

CHANGELOG 增加 `[新增]` 公众部署与匿名额度归纳；pending-test 写明测试域名的实际结果；todo 仅保留尚未验证或后续人机验证、账号、商店封装事项；docs 索引加入公众部署入口。

- [ ] **Step 5: 提交阶段五文档**

```bash
git add CHANGELOG.md docs/content/docs/progress/todo.mdx docs/content/docs/progress/pending-test.mdx docs/index.md
git commit -m "docs(deploy): 记录公众版本上线验证项"
```
