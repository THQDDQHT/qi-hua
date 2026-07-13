# 公众生图服务端实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增可独立运行的 Bun 接口服务，用 PostgreSQL 为匿名设备和网络地址执行可靠的每日图片额度，并代理现有 OpenAI 兼容生图接口。

**Architecture:** Hono 负责 HTTP 路由和 Cookie，中间件把匿名设备与可信 Cloudflare 地址放入请求上下文；配额服务在 PostgreSQL 中按“请求、设备额度、地址额度”的固定顺序加行锁，调用上游前预占，返回后按成功槽位结算。接口服务不长期保存图片，只返回生成结果并记录不含内容的结构化元数据。

**Tech Stack:** Bun、TypeScript、Hono、postgres.js、PostgreSQL、file-type、sharp、Bun test。

## Global Constraints

- 设备额度 10 张/天，地址额度 30 张/天，时区固定 `Asia/Shanghai`。
- 单次允许 1 到 4 张；提示词最大 4000 字符；参考图最多 4 张、单张 10MB、合计 20MB。
- 第一阶段不做人机验证、不设全站每日额度、不长期保存图片。
- 所有生图写接口必须受 `PUBLIC_GENERATION_ENABLED`、同源校验、匿名凭证、频率限制和数据库额度保护。
- 不把上游密钥、完整上游错误、提示词、图片或明文网络地址写入日志和数据库。
- 所有配额事务采用请求行、设备额度行、地址额度行的固定锁顺序。
- 不执行构建；每个任务只运行对应测试和差异检查。

---

## File Map

```text
server/package.json                         服务端依赖和脚本
server/bun.lock                             服务端依赖锁定
server/tsconfig.json                        TypeScript 配置
server/src/index.ts                         Bun 进程入口和过期回收定时器
server/src/app.ts                           Hono 应用组装
server/src/config.ts                        环境变量解析
server/src/domain/public-generation.ts      共享领域类型和错误码
server/src/db/client.ts                     postgres.js 客户端
server/src/db/migrate.ts                    SQL 迁移执行器
server/src/db/quota-repository.ts            配额事务和请求状态持久化
server/src/security/anonymous-token.ts       匿名令牌生成与摘要
server/src/security/client-ip.ts             Cloudflare 地址读取与日摘要
server/src/middleware/public-request.ts      同源、开关和匿名会话中间件
server/src/services/quota-service.ts         预占、领取、结算和过期回收
server/src/services/quota-snapshot.ts        上海配额窗口与统一额度快照
server/src/services/image-provider.ts        上游图片生成与编辑
server/src/services/image-validation.ts      提示词、参数和图片校验
server/src/routes/session.ts                 会话与额度接口
server/src/routes/images.ts                  图片生成与编辑接口
server/src/routes/health.ts                  存活与就绪检查
server/migrations/001_public_generation.sql  历史初始表结构
server/migrations/002_generation_request_accounting.sql 请求账期、载荷指纹和状态约束升级
server/tests/helpers/database.ts              共享测试库文件级 advisory lock
server/tests/*.test.ts                       单元与集成测试
server/docker-compose.test.yml               隔离的 PostgreSQL 测试实例
```

### Task 1: 服务端骨架与严格配置

**Files:**
- Create: `server/package.json`
- Create: `server/bun.lock`
- Create: `server/tsconfig.json`
- Create: `server/src/config.ts`
- Create: `server/src/domain/public-generation.ts`
- Create: `server/src/app.ts`
- Create: `server/src/index.ts`
- Test: `server/tests/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(env): ServerConfig`、`PublicGenerationErrorCode`、`createApp(deps): Hono`。

- [ ] **Step 1: 写配置失败测试**

```ts
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

const valid = {
  DATABASE_URL: "postgres://test:test@localhost:55432/infinite_canvas_test",
  AI_BASE_URL: "https://provider.example.com",
  AI_API_KEY: "secret",
  AI_MODEL: "image-model",
  ANON_TOKEN_SECRET: "a".repeat(32),
  IP_HASH_SECRET: "b".repeat(32),
  IDEMPOTENCY_SECRET: "c".repeat(32),
  PUBLIC_ORIGIN: "https://canvas.example.com",
};

describe("loadConfig", () => {
  test("使用设计确认的默认额度", () => {
    const config = loadConfig(valid);
    expect(config.dailyDeviceLimit).toBe(10);
    expect(config.dailyIpLimit).toBe(30);
    expect(config.timezone).toBe("Asia/Shanghai");
    expect(config.publicGenerationEnabled).toBe(true);
  });

  test("缺少密钥时拒绝启动", () => {
    expect(() => loadConfig({ ...valid, AI_API_KEY: "" })).toThrow("AI_API_KEY");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && bun test tests/config.test.ts`

Expected: FAIL，提示无法导入 `../src/config`。

- [ ] **Step 3: 创建依赖、配置类型和应用入口**

先在新目录安装本阶段确定的成熟依赖并生成独立锁文件：

Run: `cd server && bun add hono postgres file-type sharp`

Expected: `server/package.json` 写入四个运行依赖并生成 `server/bun.lock`，不修改 `web/bun.lock`。

`ServerConfig` 必须包含：

```ts
export type ServerConfig = {
  port: number;
  databaseUrl: string;
  aiBaseUrl: string;
  aiApiKey: string;
  aiModel: string;
  anonTokenSecret: string;
  ipHashSecret: string;
  publicOrigin: string;
  publicGenerationEnabled: boolean;
  dailyDeviceLimit: number;
  dailyIpLimit: number;
  timezone: "Asia/Shanghai";
  upstreamTimeoutMs: number;
  reservationTtlSeconds: number;
};
```

解析默认值固定为端口 `3001`、设备 `10`、地址 `30`、上游超时 `180000` 毫秒、预占有效期 `600` 秒。布尔值只接受 `true` 或 `false`，密钥长度不足 32 字符时拒绝启动。

`package.json` 脚本固定为：

```json
{
  "scripts": {
    "dev": "bun --watch src/index.ts",
    "start": "bun src/index.ts",
    "test": "bun test",
    "migrate": "bun src/db/migrate.ts"
  }
}
```

- [ ] **Step 4: 运行配置测试**

Run: `cd server && bun test tests/config.test.ts`

Expected: PASS，2 tests passed。

- [ ] **Step 5: 提交骨架**

```bash
git add server/package.json server/bun.lock server/tsconfig.json server/src server/tests/config.test.ts
git commit -m "feat(server): 初始化公众生图接口服务"
```

### Task 2: 数据库迁移与测试数据库

**Files:**
- Create: `server/migrations/001_public_generation.sql`
- Create: `server/src/db/client.ts`
- Create: `server/src/db/migrate.ts`
- Create: `server/docker-compose.test.yml`
- Test: `server/tests/migration.test.ts`

**Interfaces:**
- Produces: `createSql(databaseUrl)`、`runMigrations(sql, directory)` 和设计稿中的四张表。

- [ ] **Step 1: 写迁移结构测试**

测试启动后执行迁移，再查询 `information_schema.columns`，断言存在：

```ts
const expected = {
  anonymous_clients: ["id", "token_hash", "status", "created_at", "last_seen_at", "disabled_at"],
  daily_client_quotas: ["client_id", "quota_date", "success_count", "reserved_count", "updated_at"],
  daily_ip_quotas: ["ip_hash", "quota_date", "success_count", "reserved_count", "updated_at"],
  generation_requests: ["id", "client_id", "request_key", "payload_fingerprint", "ip_hash", "quota_date", "requested_count", "reserved_count", "success_count", "status", "error_code", "expires_at", "created_at", "completed_at"],
};
```

- [ ] **Step 2: 启动隔离 PostgreSQL 并确认测试失败**

Run: `docker compose -f server/docker-compose.test.yml up -d`

Run: `cd server && TEST_DATABASE_URL=postgres://test:test@127.0.0.1:55432/infinite_canvas_test bun test tests/migration.test.ts`

Expected: FAIL，迁移文件或表不存在。

- [ ] **Step 3: 编写迁移**

迁移必须包含以下约束：

```sql
alter table anonymous_clients add constraint anonymous_clients_status_check check (status in ('active', 'disabled'));
alter table daily_client_quotas add constraint daily_client_counts_check check (success_count >= 0 and reserved_count >= 0);
alter table daily_ip_quotas add constraint daily_ip_counts_check check (success_count >= 0 and reserved_count >= 0);
alter table generation_requests add constraint generation_request_count_check check (requested_count between 1 and 4 and reserved_count >= 0 and success_count >= 0);
alter table generation_requests add constraint generation_request_status_check check (status in ('reserved', 'running', 'completed', 'partial', 'failed', 'expired'));
create unique index generation_requests_client_key_uidx on generation_requests (client_id, request_key);
create index generation_requests_expiry_idx on generation_requests (expires_at) where status in ('reserved', 'running');
```

迁移执行器按文件名排序，在 `schema_migrations` 中记录已执行文件，并用 PostgreSQL advisory lock 防止两个进程同时迁移。

- [ ] **Step 4: 运行迁移测试**

Run: `cd server && TEST_DATABASE_URL=postgres://test:test@127.0.0.1:55432/infinite_canvas_test bun test tests/migration.test.ts`

Expected: PASS，表与约束存在，重复执行迁移不报错。

- [ ] **Step 5: 提交数据库基础**

```bash
git add server/migrations server/src/db server/docker-compose.test.yml server/tests/migration.test.ts
git commit -m "feat(server): 增加匿名生图配额表"
```

### Task 3: 匿名凭证、地址摘要与会话接口

**Files:**
- Create: `server/src/security/anonymous-token.ts`
- Create: `server/src/security/client-ip.ts`
- Create: `server/src/middleware/public-request.ts`
- Create: `server/src/routes/session.ts`
- Test: `server/tests/anonymous-session.test.ts`

**Interfaces:**
- Produces: `createAnonymousToken(): string`、`hashAnonymousToken(token, secret): Promise<Uint8Array>`、`hashDailyIp(ip, quotaDate, secret): Promise<Uint8Array>`、`requirePublicRequest`、`GET /api/session`、`GET /api/quota`。

- [ ] **Step 1: 写匿名会话测试**

覆盖：首次请求设置安全 Cookie、重复请求复用同一客户端、禁用客户端返回 403、非站点 `Origin` 的写请求返回 403、直接请求缺少可信 Cloudflare 标记时不接受伪造地址。

Cookie 断言：

```ts
expect(setCookie).toContain("anon_session=");
expect(setCookie).toContain("HttpOnly");
expect(setCookie).toContain("Secure");
expect(setCookie).toContain("SameSite=Lax");
expect(setCookie).toContain("Max-Age=31536000");
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && TEST_DATABASE_URL=postgres://test:test@127.0.0.1:55432/infinite_canvas_test bun test tests/anonymous-session.test.ts`

Expected: FAIL，会话路由不存在。

- [ ] **Step 3: 实现令牌和会话**

匿名令牌使用 32 个随机字节的 base64url 字符串；数据库摘要为 `SHA-256(token + ANON_TOKEN_SECRET)`。地址摘要为 `HMAC-SHA-256(IP_HASH_SECRET, quotaDate + "\n" + normalizedIp)`。

会话响应类型固定为：

```ts
export type PublicSessionResponse = {
  mode: "public";
  quota: { limit: number; used: number; reserved: number; remaining: number; resetAt: string };
  generation: {
    modelLabel: string;
    counts: number[];
    sizes: string[];
    qualities: string[];
    maxPromptLength: number;
    maxReferenceImages: number;
  };
};
```

Cookie 不存在时插入客户端；Cookie 摘要不存在时签发新客户端；客户端被禁用时不自动换发，返回明确的 403 错误。

- [ ] **Step 4: 运行会话测试**

Run: `cd server && TEST_DATABASE_URL=postgres://test:test@127.0.0.1:55432/infinite_canvas_test bun test tests/anonymous-session.test.ts`

Expected: PASS，全部会话与来源断言通过。

- [ ] **Step 5: 提交匿名会话**

```bash
git add server/src/security server/src/middleware server/src/routes/session.ts server/tests/anonymous-session.test.ts
git commit -m "feat(server): 增加匿名设备会话"
```

### Task 4: 事务配额预占、结算与过期回收

**Files:**
- Create: `server/migrations/002_generation_request_accounting.sql`
- Create: `server/src/db/quota-repository.ts`
- Create: `server/src/services/quota-service.ts`
- Create: `server/src/services/quota-snapshot.ts`
- Create: `server/tests/helpers/database.ts`
- Test: `server/tests/quota-service.test.ts`
- Test: `server/tests/quota-service.unit.test.ts`
- Test: `server/tests/quota-snapshot.test.ts`

**Interfaces:**
- Produces: `reserveQuota` 的 `reserved/replay` 判别结果、`claimForExecution` 的 `claimed/not-claimed`、`settleQuota` 的 `settled/already-settled/expired`，以及带 `expired/skipped/inconsistent` 计数的有界回收结果。

```ts
export type ReserveQuotaInput = {
  clientId: string;
  requestKey: string;
  payloadFingerprint: Uint8Array;
  ipHash: Uint8Array;
  quotaDate: string;
  requestedCount: number;
  expiresAt: Date;
};

export type Reservation =
  | { kind: "reserved"; requestId: string; status: "reserved" }
  | { kind: "replay"; requestId: string; status: RequestStatus };
```

- [ ] **Step 1: 写真实 PostgreSQL 并发测试**

测试同时执行 12 个 `requestedCount: 1` 的不同请求，断言恰好 10 个预占成功；同一地址下不同设备并发 35 次，断言恰好 30 个成功；同一 `requestKey` 并发两次只产生一条请求和一次预占。

```ts
const results = await Promise.allSettled(
  Array.from({ length: 12 }, (_, index) => service.reserveQuota({
    clientId,
    requestKey: `request-${index}`,
    ipHash,
    quotaDate: "2040-01-02",
    requestedCount: 1,
    expiresAt: new Date("2040-01-02T01:10:00Z"),
  })),
);
expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(10);
```

- [ ] **Step 2: 运行并发测试确认失败**

Run: `cd server && TEST_DATABASE_URL=postgres://test:test@127.0.0.1:55432/infinite_canvas_test bun test tests/quota-service.test.ts`

Expected: FAIL，配额服务不存在。

- [ ] **Step 3: 实现固定锁顺序**

`reserveQuota` 的单个事务严格执行：

```text
以完整 reserved_count 和 payload_fingerprint 插入 generation_requests，冲突时不插入
select generation_requests for update
已有请求仅在指纹和 requested_count 相同时返回 replay，否则返回 IDEMPOTENCY_CONFLICT
insert daily_client_quotas on conflict do nothing
select daily_client_quotas for update
insert daily_ip_quotas on conflict do nothing
select daily_ip_quotas for update
检查设备 10 和地址 30
更新两个 reserved_count；任一步失败整体回滚
```

`claimForExecution` 原子完成 `reserved -> running`，只有 `claimed` 能调用上游；领取已到期的 `reserved` 会在同一事务释放预占并转为 `expired`。`settleQuota` 和 `expireById` 同样先锁请求，再锁设备额度，最后锁地址额度。结算先判断终态，只有 `running` 才校验并写账；所有计数更新增加 `reserved_count >= reservedToRelease` 条件，受影响行数不是 1 时回滚并记录内部一致性错误。回收先无锁读取最多 100 个候选，再逐请求独立事务处理。

- [ ] **Step 4: 补齐结算测试**

覆盖：4 张中成功 2 张后设备与地址均为 `success=2,reserved=0`；失败全部释放；未领取请求不能结算；终态重放忽略新参数；过期后迟到结算返回 `expired`；跨北京时间零点只修改旧日账务并返回当前日额度；坏行不阻塞后续回收；结算和回收竞态只产生一个不可逆终态。

- [ ] **Step 5: 运行配额测试**

Run: `cd server && TEST_DATABASE_URL=postgres://test:test@127.0.0.1:55432/infinite_canvas_test bun test tests/quota-service.test.ts`

Expected: PASS，并发、结算、幂等和过期用例全部通过。

- [ ] **Step 6: 等待明确提交指令**

完成专项、并行、完整测试、类型检查和代码审查后保持未暂存、未提交状态。只有用户明确要求时才逐文件暂存任务 4 文件；禁止使用 `git add .` 或 `git add -A`，并确认 `web/bun.lock` 不在暂存区。

### Task 5: 输入校验与上游生图客户端

**Files:**
- Create: `server/src/services/image-validation.ts`
- Create: `server/src/services/image-provider.ts`
- Test: `server/tests/image-validation.test.ts`
- Test: `server/tests/image-provider.test.ts`

**Interfaces:**
- Produces: `validateGenerationInput`、`validateReferenceImages`、`ImageProvider.generateSlot`、`ImageProvider.editSlot`。

- [ ] **Step 1: 写参数和文件失败测试**

覆盖空提示词、4001 字符、数量 0/5、未知比例、未知质量、5 张参考图、单张超 10MB、总量超 20MB、扩展名伪装文本、像素超过配置上限。

- [ ] **Step 2: 运行校验测试确认失败**

Run: `cd server && bun test tests/image-validation.test.ts`

Expected: FAIL，校验函数不存在。

- [ ] **Step 3: 使用成熟库实现校验**

使用 `file-type` 检查真实格式，使用 `sharp(...).metadata()` 读取宽高但不重新编码图片。允许 MIME 固定为 `image/jpeg`、`image/png`、`image/webp`；总像素上限沿用前端 `8294400`，最长边上限 `3840`。

上游客户端接口：

```ts
export type ProviderImage = { mimeType: string; data: string };

export interface ImageProvider {
  generateSlot(input: { prompt: string; size: string; quality: string; signal: AbortSignal }): Promise<ProviderImage>;
  editSlot(input: { prompt: string; size: string; quality: string; references: File[]; signal: AbortSignal }): Promise<ProviderImage>;
}
```

上游请求始终使用服务端配置的模型和密钥，要求 `response_format: "b64_json"`。错误只映射为 `PROVIDER_REJECTED`、`PROVIDER_TIMEOUT` 或 `SERVICE_UNAVAILABLE`，不能把响应正文写入日志。

- [ ] **Step 4: 写模拟上游测试并运行**

用本地 `Bun.serve` 模拟成功、401、429、500、超时和空图片响应。

Run: `cd server && bun test tests/image-validation.test.ts tests/image-provider.test.ts`

Expected: PASS，所有校验与错误映射通过。

- [ ] **Step 5: 提交上游客户端**

```bash
git add server/src/services/image-validation.ts server/src/services/image-provider.ts server/tests/image-validation.test.ts server/tests/image-provider.test.ts
git commit -m "feat(server): 增加生图参数校验和上游调用"
```

### Task 6: 生图路由与按槽位结算

**Files:**
- Create: `server/src/routes/images.ts`
- Create: `server/src/services/generation-service.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/index.ts`
- Test: `server/tests/images-route.test.ts`

**Interfaces:**
- Consumes: `reserveQuota`、`claimForExecution`、判别式 `settleQuota`、`ImageProvider` 和会话上下文。路由生成规范载荷指纹并将 `IDEMPOTENCY_CONFLICT` 映射为 HTTP 409；只有 `claimed` 调用上游，只有本次 `settled` 交付图片，`already-settled` 不交付本次临时图片，`expired` 丢弃图片。
- Produces: `POST /api/images/generations`、`POST /api/images/edits`。

- [ ] **Step 1: 写路由行为测试**

覆盖：开关关闭返回 `PUBLIC_GENERATION_OFF`；额度不足返回 429 且不调用供应商；4 个槽位中 2 成功时返回两个成功和两个失败；重复 `requestKey` 不再次调用供应商；数据库失败不调用供应商；上游超时释放额度。

响应断言：

```ts
expect(body.results.map((item: { status: string }) => item.status)).toEqual(["success", "failed"]);
expect(body.quota).toEqual({ limit: 10, used: 1, reserved: 0, remaining: 9, resetAt: expect.any(String) });
```

- [ ] **Step 2: 运行路由测试确认失败**

Run: `cd server && TEST_DATABASE_URL=postgres://test:test@127.0.0.1:55432/infinite_canvas_test bun test tests/images-route.test.ts`

Expected: FAIL，路由返回 404。

- [ ] **Step 3: 实现生成编排**

`generation-service.ts` 必须：先校验、再预占、把请求标记为 `running`、为每个槽位创建共享超时控制器下的独立 Promise、使用 `Promise.allSettled` 汇总、在 `finally` 路径调用一次结算。取消客户端连接不能直接跳过结算。

重复请求行为：运行中返回 202 和请求状态；已完成返回 200、空 `results`、`replayed: true` 和当前额度；因为不保存图片，不能伪造可恢复结果。

- [ ] **Step 4: 启动过期回收**

`index.ts` 在监听前执行一次 `expireReservations(new Date())`，随后每 60 秒执行一次；定时器错误只记录错误类别，不中止 HTTP 服务。进程关闭时清理定时器并停止接收新请求。

- [ ] **Step 5: 运行全部服务端测试**

Run: `cd server && TEST_DATABASE_URL=postgres://test:test@127.0.0.1:55432/infinite_canvas_test bun test`

Expected: PASS，无失败测试。

- [ ] **Step 6: 提交接口路由**

```bash
git add server/src/app.ts server/src/index.ts server/src/routes/images.ts server/src/services/generation-service.ts server/tests/images-route.test.ts
git commit -m "feat(server): 提供公众生图代理接口"
```

### Task 7: 健康检查、容器和阶段文档

**Files:**
- Create: `server/src/routes/health.ts`
- Create: `server/Dockerfile`
- Create: `server/.dockerignore`
- Modify: `server/src/app.ts`
- Modify: `CHANGELOG.md`
- Modify: `docs/content/docs/progress/todo.mdx`
- Modify: `docs/content/docs/progress/pending-test.mdx`
- Test: `server/tests/health.test.ts`

**Interfaces:**
- Produces: `GET /health/live` 和 `GET /health/ready`，供部署计划消费。

- [ ] **Step 1: 写健康检查测试**

存活接口始终返回 200 和 `{ "status": "ok" }`；就绪接口在数据库可用且关键配置完整时返回 200，数据库断开时返回 503；测试替身必须证明就绪检查没有调用付费供应商。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && bun test tests/health.test.ts`

Expected: FAIL，健康路由不存在。

- [ ] **Step 3: 实现健康检查和最小运行镜像**

`server/Dockerfile` 使用固定 Bun 基础镜像，只复制服务端包、锁文件、源码和迁移；非 root 用户运行；暴露 3001；健康检查调用 `/health/live`。不在镜像中包含 `web` 或上游密钥。

- [ ] **Step 4: 更新阶段文档**

在 `CHANGELOG.md` 的 `Unreleased` 增加一条 `[新增]`，在 `pending-test.mdx` 写入匿名会话、10/30 额度、部分成功结算、开关和健康检查的人工验证项；从 `todo.mdx` 移除本阶段已完成事项，保留后续公众前端、手机和部署事项。

- [ ] **Step 5: 最终针对性验证**

Run: `cd server && TEST_DATABASE_URL=postgres://test:test@127.0.0.1:55432/infinite_canvas_test bun test`

Run: `git diff --check`

Expected: 服务端测试无失败；差异无空白错误。按项目规则不执行构建。

- [ ] **Step 6: 提交阶段一**

```bash
git add server CHANGELOG.md docs/content/docs/progress/todo.mdx docs/content/docs/progress/pending-test.mdx
git commit -m "docs(server): 记录公众生图服务端待测试项"
```
