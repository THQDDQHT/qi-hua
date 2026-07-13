# 公众生图额度状态机加固设计

日期：2026-07-13
状态：已实施并验证

## 1. 背景

服务端任务 4 已实现匿名图片额度的并发预占、按成功数量结算和过期释放，但复审确认当前实现仍存在迁移升级、幂等载荷、迟到结算、状态约束、回收隔离和跨日额度展示等问题。

本设计以任务 4 的配额与请求状态边界为核心，同时修正任务 2 的迁移升级路径、任务 3 的共享额度格式化，并更新任务 6 将消费的状态机接口。它不提前实现图片路由、回收定时器或结果持久化。

本轮允许修改的范围为：

- `server/migrations/001_public_generation.sql` 与新增的 `002`；
- `server/src/config.ts` 与配置测试；
- `server/src/domain/public-generation.ts`；
- `server/src/db/quota-repository.ts`；
- `server/src/services/quota-service.ts` 及共享额度模块；
- `server/src/routes/session.ts`；
- 相关服务端数据库测试与测试 helper；
- 公众生图总设计、服务端计划和本设计文档。

任务 6 的 HTTP 409 映射和图片交付判断只在文档中定义消费契约，不在本轮实现。

## 2. 目标

本次实施必须满足：

1. 已执行旧 `001` 的数据库和空数据库都能升级到语义相同的 schema；不要求新增列具有相同的物理列顺序。
2. 同一设备、同一 `requestKey` 只有相同语义载荷才能重放；不同载荷返回幂等冲突。
3. 只有一个执行者能领取请求并调用上游。
4. 结算和过期回收通过请求行锁线性化，不能出现图片已交付但额度未扣的状态。
5. 请求行、设备额度和地址额度的计数始终满足可验证的不变量。
6. 数据库只能保存受控的结算错误码，不能保存供应商原始详情。
7. 一个损坏的过期请求不能阻塞同一轮其他健康请求。
8. 跨北京时间零点时，账务修改预占日，面向用户的额度快照展示当前日。
9. 数据库测试可安全地在多个测试文件或共享测试库的 CI shard 之间串行进入破坏性区段。

## 3. 非目标

本次不实现：

- 图片生成或编辑 HTTP 路由；
- 上游图片供应商客户端；
- 进程启动时和每 60 秒执行的回收定时器；
- Redis、消息队列、租约 worker 或 dead-letter 系统；
- 图片或提示词持久化；
- 结算结果图片的可靠重放；
- 数据库触发器或存储过程状态机；
- 自动猜测、修复或删除损坏的额度数据；
- 每 worker 独立数据库或 schema 的完整测试基础设施重构；
- `web/bun.lock` 的任何修改、暂存或提交。

## 4. 已确认的核心决策

### 4.1 迁移策略

恢复 `server/migrations/001_public_generation.sql` 为已经提交的历史内容，新增 `002_generation_request_accounting.sql`。历史迁移不再原地修改。

`002` 兼容两种开发期状态：

- 数据库执行过历史 `001`，尚无 `quota_date`；
- 测试或开发数据库曾执行工作区中临时修改过的 `001`，已经有 `quota_date`。

因此 `002` 可以使用带结构校验的 `ADD COLUMN IF NOT EXISTS`，但最终必须验证列类型、非空属性和约束完全一致。该兼容只用于收敛当前开发期 schema 漂移；提交后的 `001` 和 `002` 均保持不可变。

### 4.2 幂等冲突

同一 `(client_id, request_key)`：

- 载荷指纹和 `requested_count` 都相同：返回原请求状态，不再次预占；
- 指纹或 `requested_count` 任一不同：返回 `IDEMPOTENCY_CONFLICT`，后续路由映射为 HTTP 409，不调用上游，也不改变任何额度。

### 4.3 硬过期

`expired` 是不可逆终态。结算和过期回收谁先取得请求行锁，谁决定最终状态：

- 结算先获锁并成功提交：允许交付图片，回收随后跳过；
- 回收先获锁并提交：迟到结算返回 `kind: "expired"`，本次图片必须丢弃。

第一阶段接受极少数迟到图片造成的上游成本浪费，以换取“图片交付必然对应成功结算”的额度安全性。

### 4.4 回收规模

采用“小批量发现、逐请求独立事务”的方式。当前阶段保持串行处理，不引入大事务、队列或多 worker 高吞吐架构。

## 5. 数据库迁移与 schema

### 5.1 恢复 `001`

`001_public_generation.sql` 恢复为提交历史中的版本：`generation_requests` 不包含 `quota_date` 和 `payload_fingerprint`，原有基础表、状态枚举和索引保持不变。

### 5.2 新增 `002`

`002_generation_request_accounting.sql` 按以下顺序执行：

1. 增加可空 `quota_date date`；若列已存在，验证其类型为 `date`。
2. 为缺少 `quota_date` 的旧请求恢复真实账期：
   - 将 `generation_requests` 与 `daily_client_quotas` 按 `client_id`、与 `daily_ip_quotas` 按 `ip_hash` 关联；
   - 只把同时存在设备额度行和地址额度行的日期视为候选；
   - 活跃请求还要求两张额度行的 `reserved_count >= request.reserved_count`；
   - 恰好一个候选日期时写入该日期；
   - 零个或多个候选日期时让迁移失败并输出固定、无敏感数据的异常，要求先人工核对，而不是用 `created_at` 猜测；
   - 对 `generation_requests` 为空的正常环境，该步骤直接完成。
3. 增加可空 `payload_fingerprint bytea`。
4. 旧请求没有原始提示词或参考图，无法恢复真实语义载荷。固定占位算法为：

   ```text
   SHA-256(UTF-8("infinite-canvas/legacy-generation-request/v1/" + lower-case UUID text))
   ```

   例如请求 ID `00000000-0000-4000-8000-000000000001` 的结果固定为：

   ```text
   bbd820b854e9f425110e57a92bfa9d2db1216eda4760dbeef9df9cbcf074f750
   ```

5. 升级旧 `error_code`：
   - `NULL` 和三个结算错误码保持不变；
   - 旧 schema 合法但不属于结算子集的值统一置为 `NULL`；
   - 迁移只记录受影响行数，不记录旧值；
   - 随后再增加新错误码约束。
6. 将 `quota_date` 和 `payload_fingerprint` 设置为 `NOT NULL`。
7. 替换旧的请求计数约束，并增加指纹、状态数据形状和错误码约束。
8. 保留 `(client_id, request_key)` 唯一索引和活跃请求过期索引。

旧记录占位指纹与正常 HMAC-SHA-256 指纹理论上仍可能发生 256 位摘要碰撞，但概率可忽略。旧 request key 再次提交时会安全地返回幂等冲突，而不是把未知旧载荷错误地当作可重放请求。

两条迁移路径的“语义相同”指相同的列名、类型、可空性、默认值、约束和索引，不包括 PostgreSQL 的物理列顺序。迁移测试不得按 `ordinal_position` 要求新增列顺序完全相同。

### 5.3 `generation_requests` 最终字段

```text
id                   uuid primary key
client_id            uuid not null
request_key          text not null
payload_fingerprint  bytea not null
ip_hash              bytea not null
quota_date           date not null
requested_count      smallint not null
reserved_count       smallint not null
success_count        smallint not null default 0
status               text not null
error_code           text null
expires_at           timestamptz not null
created_at           timestamptz not null default now()
completed_at         timestamptz null
unique (client_id, request_key)
```

### 5.4 行级不变量

所有请求满足：

```text
1 <= requested_count <= 4
0 <= reserved_count <= requested_count
0 <= success_count <= requested_count
reserved_count + success_count <= requested_count
octet_length(payload_fingerprint) = 32
```

状态数据形状为：

| 状态 | 数据不变量 |
|---|---|
| `reserved` | `reserved_count = requested_count`、`success_count = 0`、`completed_at IS NULL`、`error_code IS NULL` |
| `running` | `reserved_count = requested_count`、`success_count = 0`、`completed_at IS NULL`、`error_code IS NULL` |
| `completed` | `reserved_count = 0`、`success_count = requested_count`、`completed_at IS NOT NULL`、`error_code IS NULL` |
| `partial` | `reserved_count = 0`、`0 < success_count < requested_count`、`completed_at IS NOT NULL` |
| `failed` | `reserved_count = 0`、`success_count = 0`、`completed_at IS NOT NULL` |
| `expired` | `reserved_count = 0`、`success_count = 0`、`completed_at IS NOT NULL`、`error_code IS NULL` |

普通 `CHECK` 只保护更新后的行形状，不尝试验证历史转换路径。允许的转换仍由仓储条件更新控制，不引入触发器。

### 5.5 结算错误码

新增结算错误码子集：

```text
PROVIDER_REJECTED
PROVIDER_TIMEOUT
SERVICE_UNAVAILABLE
```

规则：

- `error_code` 为 `NULL` 或上述值之一；
- 只有 `partial` 和 `failed` 可以保存非空错误码；
- `partial` 和 `failed` 暂不强制必须有错误码；
- `completed` 即使调用方传入错误码也保存 `NULL`；
- `reserved`、`running`、`expired` 必须保存 `NULL`。

## 6. 领域类型与接口

### 6.1 错误码

`PublicGenerationErrorCode` 增加：

```text
IDEMPOTENCY_CONFLICT
```

另行导出：

```ts
export const SETTLEMENT_ERROR_CODES = [
  "PROVIDER_REJECTED",
  "PROVIDER_TIMEOUT",
  "SERVICE_UNAVAILABLE",
] as const;

export type SettlementErrorCode = (typeof SETTLEMENT_ERROR_CODES)[number];
```

服务层和仓储层都只接受 `SettlementErrorCode`。运行时仍执行白名单校验，防止 JavaScript 调用方绕过 TypeScript。

### 6.2 预占输入与结果

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

额度层不理解提示词、尺寸、质量或参考图，只比较不透明的 32 字节指纹。

后续输入校验与路由任务负责按以下固定协议生成 HMAC-SHA-256 指纹。本轮在 `ServerConfig` 增加独立的 `IDEMPOTENCY_SECRET`，要求至少 32 个字符；不复用匿名令牌或地址摘要密钥，也不支持无版本的密钥轮换。

协议版本为 `v1`，消息字节按以下顺序拼接：

```text
ASCII("infinite-canvas/public-image-idempotency/v1\\0")
field(operation)
field(prompt)
u8(count)
field(size)
field(quality)
u8(referenceCount)
referenceDigest[0]
...
referenceDigest[n-1]
```

其中：

- `field(value) = u32be(UTF-8 字节长度) || UTF-8(value)`；
- `operation` 只能是原样 ASCII `generation` 或 `edit`；
- `prompt` 采用校验通过后准备发送给供应商的原始 JavaScript 字符串，不执行 trim、Unicode normalization、换行转换或大小写转换；
- `count` 为 `1..4` 的单字节无符号整数；
- `size` 和 `quality` 使用校验后的规范枚举字符串；
- `generation` 的 `referenceCount` 必须为 0；
- `edit` 保留用户上传顺序，每张参考图使用其原始上传字节的 SHA-256 32 字节摘要；
- 参考图摘要直接依序拼接，不转换为十六进制文本。

固定测试向量：

```text
IDEMPOTENCY_SECRET = 0123456789abcdef0123456789abcdef
operation = generation
prompt = "cat\\nblue"
count = 2
size = 1:1
quality = high
references = []
HMAC-SHA-256 = 4d9d1cf77dde2b2421ae8109ee3482f647a70477d9053439cd47e34dc8936b58
```

指纹不包括客户端地址、配额日期、过期时间或当前请求时间，因此跨北京时间零点或网络切换后的同一用户操作仍可重放。

`IDEMPOTENCY_SECRET` 轮换会令旧 request key 无法与新指纹匹配并返回 409。第一阶段将该密钥视为持久配置，不执行轮换；未来若必须轮换，应先设计带 key version 的双读迁移，不得直接替换生产值。

### 6.3 执行权领取

```ts
export type ClaimResult =
  | { kind: "claimed"; requestId: string; status: "running" }
  | {
      kind: "not-claimed";
      requestId: string;
      status: "running" | "completed" | "partial" | "failed" | "expired";
    };

claimForExecution(input: { requestId: string; now: Date }): Promise<ClaimResult>
```

领取规则：

1. 锁定请求行。
2. 仅允许未过期的 `reserved -> running`。
3. 两个并发领取者只有一个得到 `claimed`。
4. `running` 或任意终态返回 `not-claimed`。
5. `reserved` 但已经到期时，在同一事务中锁定额度行、释放预占并转为 `expired`，返回 `{ kind: "not-claimed", status: "expired" }`。

简单的 `markRunning` 不足以阻止两个执行者都调用供应商，因此不提供无条件状态 setter。

### 6.4 结算结果

```ts
export type SettleQuotaInput = {
  requestId: string;
  successCount: number;
  errorCode?: SettlementErrorCode;
  now: Date;
};

export type SettlementResult =
  | {
      kind: "settled";
      status: "completed" | "partial" | "failed";
      quota: QuotaSnapshot;
    }
  | {
      kind: "already-settled";
      status: "completed" | "partial" | "failed";
      quota: QuotaSnapshot;
    }
  | {
      kind: "expired";
      status: "expired";
      quota: QuotaSnapshot;
    };

settleQuota(input: SettleQuotaInput): Promise<SettlementResult>
```

服务层根据 `input.now` 计算当前 `Asia/Shanghai` 配额窗口，并把 `currentQuotaDate` 传给仓储；仓储不读取系统时钟。这样跨日行为可以确定性测试。

`settleQuota` 的顺序为：

1. 锁请求行。
2. 先判断当前状态：
   - `completed/partial/failed`：忽略本次回调参数，返回 `already-settled`；
   - `expired`：忽略本次回调参数，返回 `expired`；
   - `reserved`：视为内部编排错误，拒绝结算；
   - `running`：继续。
3. 对活跃结算验证：
   - `successCount` 是安全整数；
   - `0 <= successCount <= reserved_count`；
   - 非空错误码属于结算错误码子集；未知字符串返回 `INVALID_REQUEST`，整个事务回滚，请求保持 `running`；
   - 终态幂等分支在上述校验之前执行，因此已完成或已过期请求会忽略重试携带的未知错误字符串。
4. 按请求、设备额度、地址额度的固定顺序加锁。
5. 释放请求持有的全部预占，增加实际成功数。
6. 更新为 `completed`、`partial` 或 `failed`。
7. 返回判别结果和当前设备额度。

当多个槽位失败原因不同时，请求级 `error_code` 使用固定严重度优先级选取一个汇总码：

```text
SERVICE_UNAVAILABLE > PROVIDER_TIMEOUT > PROVIDER_REJECTED
```

同级错误与槽位完成顺序无关。逐槽位错误仍只存在于当次 HTTP 响应，不写入请求表。

只有 `kind === "settled"` 的本次执行结果可以交付图片。`already-settled` 用于幂等观察，不能把本次临时图片再次交付；`expired` 必须丢弃本次临时图片。

## 7. 当前额度快照

统一额度响应：

```ts
export type QuotaSnapshot = {
  limit: number;
  used: number;
  reserved: number;
  remaining: number;
  resetAt: string;
};
```

规则：

```text
remaining = max(0, limit - used - reserved)
```

账务更新始终使用请求行保存的 `quota_date`。服务使用调用方传入的 `input.now` 计算当前 `Asia/Shanghai` 配额窗口，并让结算事务在完成账务后读取该当前日期的设备额度：

- 当前日期等于请求日期：返回刚更新的额度行；
- 当前日期不同：读取当前日期额度行，不存在时按零计数返回。

把当前额度读取放在同一结算事务中，可以避免账务已经提交、但第二次数据库查询失败后调用方误以为结算失败。`resetAt` 由同一配额窗口计算。

抽取共享额度读取和格式化边界，供：

- `GET /api/session`；
- `GET /api/quota`；
- `settleQuota`；
- 后续重复请求响应。

共享边界必须统一零值钳制，不能让不同接口分别计算 `remaining`。

## 8. 预占算法

`reserveQuota` 在服务层和仓储层验证：

- `requestedCount` 是 `1..4` 的安全整数；
- `payloadFingerprint` 恰好 32 字节；
- 配置的设备和地址限额是 `1..32767` 的安全整数，以匹配 PostgreSQL `smallint` 计数字段。

`loadConfig` 同步拒绝超过 32767 的 `DAILY_DEVICE_LIMIT` 和 `DAILY_IP_LIMIT`；限额小于单次最大请求数时，较大的请求正常走额度不足分支。本次不把计数字段扩大为 `integer`。

单个事务按以下顺序执行：

1. 以 `reserved_count = requested_count`、`status = 'reserved'` 插入请求行，冲突时不插入。
2. 锁定 `(client_id, request_key)` 请求行。
3. 若为已有请求：
   - 指纹和 `requested_count` 都相同，返回 `replay`；
   - 任一不同，抛出 `IDEMPOTENCY_CONFLICT`。
4. 创建并锁定设备额度行。
5. 创建并锁定地址额度行。
6. 检查设备与地址的 `success + reserved + requested` 上限。
7. 同时增加两张额度表的预占数。
8. 提交事务。

初始请求行直接写完整预占，是为了让新的数据库状态约束在每条 SQL 执行后都成立。若任一额度检查或更新失败，整个事务回滚，请求行不会遗留。

## 9. 过期回收

### 9.1 仓储接口

```ts
findExpiredCandidates(input: {
  now: Date;
  limit: number;
}): Promise<Array<{ requestId: string }>>

expireById(input: {
  requestId: string;
  now: Date;
}): Promise<"expired" | "skipped">
```

候选查询按 `(expires_at, id)` 返回最多 100 条活跃且到期的请求 ID，不在候选查询事务中长期持锁。

`expireById` 为每个请求开启独立事务：

1. 锁请求行；
2. 重新检查状态和过期时间；
3. 已被其他实例结算或回收时返回 `skipped`；
4. 锁设备额度行；
5. 锁地址额度行；
6. 释放全部预占并转为 `expired`；
7. 提交并返回 `expired`。

多个实例读取到同一候选不会重复释放，因为请求行锁和状态重检决定唯一获胜者。

### 9.2 服务接口

```ts
export type ExpirationSweepResult = {
  expired: number;
  skipped: number;
  inconsistent: number;
};

expireReservations(now: Date): Promise<ExpirationSweepResult>
```

服务行为：

- 单条 `QuotaRepositoryError("INCONSISTENT")`：记录固定消息和 `requestId`，计入 `inconsistent`，继续本轮其他候选；
- 数据库连接、权限、SQL 或 schema 错误：中止本轮并抛出 `SERVICE_UNAVAILABLE`；
- 每轮最多扫描 100 个候选；
- 当前阶段逐条串行处理，每条请求独立提交。

本次不把损坏请求自动改成其他终态，也不修改其计数。运维人员仍可根据结构化日志定位并人工处理。

## 10. 错误与日志边界

### 10.1 服务错误映射

| 仓储/领域情况 | 对外错误码 |
|---|---|
| 设备额度不足 | `QUOTA_EXHAUSTED` |
| 地址额度不足 | `IP_QUOTA_EXHAUSTED` |
| request key 与载荷指纹冲突 | `IDEMPOTENCY_CONFLICT` |
| 非法请求数量、指纹、成功数量或活跃结算错误码 | `INVALID_REQUEST` |
| 状态或计数不一致 | `SERVICE_UNAVAILABLE` |
| 未知数据库或基础设施错误 | `SERVICE_UNAVAILABLE` |

### 10.2 日志

允许记录：

```text
固定错误类别
requestId
回收阶段
```

禁止记录：

```text
数据库连接串
SQL 文本或绑定参数
供应商响应正文
提示词
参考图或图片数据
未知 errorCode 原始字符串
匿名 Cookie 或原始地址
```

## 11. 测试设计

### 11.1 共享数据库测试锁

新增测试 helper，集中实现：

- `TEST_DATABASE_URL` 必须存在；
- 数据库名必须是 `infinite_canvas_test`；
- 使用固定的 PostgreSQL session-level advisory lock `2026071301` 序列化每个数据库测试文件的完整生命周期；该键与迁移器的事务锁 `2026071202` 明确不同；
- 在最早注册的 `beforeAll` 中通过 `sql.reserve()` 获取专用连接，再使用该连接取得 session lock；只有取锁后才能重建 schema、迁移或写 fixture；
- helper 提供 `migrate: true | false`，迁移测试选择 `false`，以便先构造旧 schema；其他数据库套件选择 `true`；
- 每个文件自身的 `afterAll` 清理必须在 helper 的最终释放之前注册并完成；最终释放逻辑使用 `try/finally`，依次执行 `pg_advisory_unlock`、`reserved.release()` 和 `sql.end()`；
- 即使测试或清理失败，也必须尝试解锁并释放连接；
- 集中实现数据库名保护、schema 重建和测试数据清理。

增加回归测试证明：持有测试 session lock 时，`runMigrations` 仍能在池中其他连接取得不同键的迁移锁并完成，不发生自我死锁。

这样 `bun test --parallel` 或多个共享同一测试库的 CI shard 会等待锁，而不会互相删表。文件内部仍不得使用 `--concurrent`；该限制在测试 helper 和服务端测试文档中明确记录。

### 11.2 迁移测试

覆盖：

1. 空库运行 `001 -> 002`，最终列名、类型、可空性、默认值、约束、索引和迁移记录正确；断言不依赖新增列的 `ordinal_position`。
2. 模拟已经记录旧 `001` 的数据库：
   - 只建立旧 schema；
   - 插入至少一个旧请求；
   - 记录 `001_public_generation.sql`；
   - 运行当前迁移器；
   - 验证只执行 `002`；
   - 构造唯一可恢复的设备/地址账期并验证 `quota_date`；
   - 验证固定 32 字节占位指纹算法和测试向量；
   - 零候选或多候选账期时迁移必须失败，不能按 `created_at` 猜测；
   - 旧的非结算错误码被置空，受控结算错误码保持不变。
3. 对已执行历史 `001` 但业务表为空的真实当前场景，验证 `002` 可直接升级成功。
4. 模拟开发期已有 `quota_date` 的 schema，`002` 仍能收敛到语义相同的最终结构。
5. 计数关系约束拒绝：
   - `reserved_count > requested_count`；
   - `success_count > requested_count`；
   - 两者之和超过申请数。
6. 每种状态的合法与非法数据形状。
7. 指纹长度不是 32 字节时拒绝。
8. 非受控错误码或错误状态携带错误码时拒绝。
9. 重复运行迁移保持幂等。

### 11.3 预占与幂等测试

覆盖：

- 同一设备 12 个单图请求恰好 10 个成功预占；
- 同一地址 35 个单图请求恰好 30 个成功预占；
- 相同 key、相同指纹和相同数量并发时只产生一条请求和一次预占；
- 相同 key 下指纹或数量任一变化时返回 `IDEMPOTENCY_CONFLICT`，原请求和额度不变；
- `requestedCount` 为 0、5、小数、`NaN` 或 `Infinity` 时返回 `INVALID_REQUEST`，且不产生请求或额度行；
- 额度不足事务不遗留请求行或孤立计数。

### 11.4 执行领取测试

覆盖：

- 两个并发领取者只有一个得到 `claimed`；
- 已 `running`、已完成或已过期请求返回 `not-claimed`；
- 领取已经过期的 `reserved` 请求会释放一次预占并返回 `{ kind: "not-claimed", status: "expired" }`；
- 领取失败或一致性错误完整回滚。

### 11.5 结算测试

覆盖：

- 全部成功、部分成功、全部失败的状态、计数、错误码和完成时间；
- 多槽位不同失败原因按 `SERVICE_UNAVAILABLE > PROVIDER_TIMEOUT > PROVIDER_REJECTED` 稳定聚合，与 Promise 完成顺序无关；
- `completed` 即使传入错误码也保存 `NULL`；
- 重复结算传入不同成功数或错误码，仍返回首次终态且不改变计数；
- `successCount > reserved_count` 返回受控错误并完整回滚；
- 活跃请求收到未知错误字符串时返回 `INVALID_REQUEST`、事务回滚并保持 `running`；终态幂等重放忽略该未知新参数；
- 直接 SQL 写入未知错误码被数据库拒绝；
- `reserved` 未领取时不能结算；
- `running` 可以结算。

### 11.6 竞态与跨日测试

覆盖：

- `settle` 先获锁：请求结算，后续回收跳过；
- `expire` 先获锁：请求过期，迟到结算返回 `expired`，成功计数不增加；
- 旧日期预占、跨北京时间零点后结算：只修改旧日期设备和地址额度；
- 同一结算结果返回当前新日期的设备额度与新日期 `resetAt`；
- 旧日期预占、跨零点后过期：只释放旧日期额度，新日期额度不变。

### 11.7 回收隔离测试

构造“最老请求损坏、后续请求健康”的场景，验证：

- 损坏请求事务回滚；
- 日志只包含固定类别和该 `requestId`；
- 后续健康请求仍在同一轮成功回收；
- 返回的 `expired`、`skipped`、`inconsistent` 数量准确；
- 系统性数据库错误会中止本轮，而不是对每个候选重复失败。

### 11.8 删除重复测试

删除 `quota-service.test.ts` 中与匿名会话测试完全重复的纯 `getShanghaiQuotaWindow` 边界测试，用真实跨零点结算和回收测试替代。

## 12. 文档同步

实施时同步更新：

- `docs/superpowers/specs/2026-07-12-public-image-generation-design.md`：增加载荷指纹、幂等冲突、执行领取、硬过期和结算错误码子集；
- `docs/superpowers/plans/2026-07-12-public-image-server.md`：更新任务 4 接口、迁移文件和测试步骤，并让任务 6 消费 `claimForExecution` 与判别式结算结果；
- `.git/sdd/progress.md`：只有代码审查和全部验证完成后才记录任务 4 完成。

## 13. 审查发现处置

| 审查发现 | 处置 |
|---|---|
| 修改已执行 `001` 无法升级 | 恢复 `001`，新增 `002` 和升级测试 |
| 过期后的迟到成功不扣额度 | 硬过期；结算返回 `expired`，路由不得交付 |
| 重复 key 不校验载荷 | 增加 32 字节载荷指纹和 409 冲突 |
| 成功数可超过实际预占 | 验证 `successCount <= reserved_count` |
| 请求计数约束不足 | 增加计数关系和状态数据形状约束 |
| 预占数量缺少领域校验 | 服务和仓储双层校验 |
| 终态幂等判断顺序错误 | 先判断终态，再校验新回调参数和锁额度 |
| 仓储可写任意错误详情 | 类型、运行时和数据库三层白名单 |
| 损坏最老请求阻塞回收 | 有界候选列表、逐请求事务、单条错误继续 |
| 跨零点返回旧日额度 | 旧日记账、当前日快照 |
| `remaining` 可为负且接口不一致 | 共享格式化并钳制为零 |
| 没有 `running` 转换 API | 新增原子 `claimForExecution` |
| 回收逐条事务效率 | 保留逐条事务；仅增加每轮 100 条上限，不做过度优化 |
| 数据库测试共享 schema | session advisory lock 序列化文件生命周期 |
| 上海窗口测试重复 | 删除重复纯函数测试，替换为跨日数据库测试 |

## 14. 验收标准

实施完成必须同时满足：

1. 迁移专项测试通过。
2. 配额服务专项测试通过。
3. 完整服务端测试通过。
4. 真实 PostgreSQL 并发测试稳定满足设备 10、地址 30 的限制。
5. 迁移升级、幂等冲突、执行领取、结算/过期竞态、跨日账务和坏行隔离均有失败优先的回归测试。
6. 数据库中不存在供应商原始错误详情。
7. `git diff --check` 通过。
8. 代码审查没有未解决的阻断或高严重度问题。
9. `web/bun.lock` 未被修改、暂存或提交。
10. 只有完成以上验证后，才提交任务 4 并在进度账本中标记完成。
