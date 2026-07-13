import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { runMigrations } from "../src/db/migrate";
import { createDatabaseTestHarness } from "./helpers/database";

setDefaultTimeout(30_000);

const database = createDatabaseTestHarness({ migrate: false });
const { sql } = database;
const migrationsDirectory = resolve(import.meta.dir, "../migrations");
const historicalMigrationPath = resolve(migrationsDirectory, "001_public_generation.sql");
const accountingMigrationPath = resolve(migrationsDirectory, "002_generation_request_accounting.sql");
const LEGACY_FINGERPRINT = "bbd820b854e9f425110e57a92bfa9d2db1216eda4760dbeef9df9cbcf074f750";
const REQUEST_ID = "00000000-0000-4000-8000-000000000001";
const CLIENT_ID = "10000000-0000-4000-8000-000000000001";

beforeAll(database.setup, { timeout: 120_000 });
beforeEach(database.rebuildSchema);
afterAll(database.teardown, { timeout: 120_000 });

async function expectSqlState(code: string, operation: () => Promise<unknown>) {
  let error: unknown;
  try {
    await operation();
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({ code });
}

async function withMigrationDirectory(
  files: Record<string, string>,
  operation: (directory: string) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "infinite-canvas-migrations-"));
  try {
    await Promise.all(
      Object.entries(files).map(([filename, source]) => writeFile(join(directory, filename), source)),
    );
    await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function readMigrations() {
  const [historical, accounting] = await Promise.all([
    readFile(historicalMigrationPath, "utf8"),
    readFile(accountingMigrationPath, "utf8"),
  ]);
  return { historical, accounting };
}

function developmentMigration(historical: string, type = "date", defaultValue?: string) {
  const marker = "  ip_hash bytea not null,\n  requested_count smallint not null,";
  const defaultClause = defaultValue ? ` default ${defaultValue}` : "";
  const replacement = `  ip_hash bytea not null,\n  quota_date ${type} not null${defaultClause},\n  requested_count smallint not null,`;
  if (historical.split(marker).length !== 2) {
    throw new Error("historical migration marker must occur exactly once");
  }
  return historical.replace(marker, replacement);
}

async function applyHistoricalMigration(source?: string) {
  const { historical } = await readMigrations();
  await withMigrationDirectory(
    { [basename(historicalMigrationPath)]: source ?? historical },
    (directory) => runMigrations(sql, directory),
  );
}

async function recordHistoricalMigration() {
  await sql`insert into schema_migrations (filename) values ('001_public_generation.sql')`;
}

async function insertLegacyRequest(input: {
  status?: string;
  requestedCount?: number;
  reservedCount?: number;
  successCount?: number;
  errorCode?: string | null;
  completedAt?: Date | null;
} = {}) {
  const {
    status = "reserved",
    requestedCount = 1,
    reservedCount = status === "reserved" || status === "running" ? requestedCount : 0,
    successCount = status === "completed" ? requestedCount : 0,
    errorCode = null,
    completedAt = ["completed", "partial", "failed", "expired"].includes(status)
      ? new Date("2040-01-02T02:00:00Z")
      : null,
  } = input;
  await sql`
    insert into generation_requests (
      id, client_id, request_key, ip_hash, requested_count, reserved_count,
      success_count, status, error_code, expires_at, completed_at
    ) values (
      ${REQUEST_ID}, ${CLIENT_ID}, 'legacy-request', decode('10', 'hex'), ${requestedCount},
      ${reservedCount}, ${successCount}, ${status}, ${errorCode},
      '2040-01-02T03:00:00Z', ${completedAt}
    )
  `;
}

async function insertQuotaCandidate(
  quotaDate: string,
  clientReserved: number,
  ipReserved = clientReserved,
) {
  await sql`
    insert into daily_client_quotas (client_id, quota_date, reserved_count)
    values (${CLIENT_ID}, ${quotaDate}, ${clientReserved})
  `;
  await sql`
    insert into daily_ip_quotas (ip_hash, quota_date, reserved_count)
    values (decode('10', 'hex'), ${quotaDate}, ${ipReserved})
  `;
}

async function schemaSnapshot() {
  const columns = await sql<{
    tableName: string;
    columnName: string;
    dataType: string;
    nullable: string;
    defaultValue: string | null;
  }[]>`
    select table_name as "tableName", column_name as "columnName", data_type as "dataType",
      is_nullable as nullable, column_default as "defaultValue"
    from information_schema.columns
    where table_schema = 'public'
      and table_name in (
        'anonymous_clients',
        'daily_client_quotas',
        'daily_ip_quotas',
        'generation_requests',
        'schema_migrations'
      )
    order by table_name, column_name
  `;
  const constraints = await sql<{ name: string; definition: string }[]>`
    select constraint_name as name, pg_get_constraintdef(pg_constraint.oid, true) as definition
    from information_schema.table_constraints
    join pg_constraint on pg_constraint.conname = constraint_name
      and pg_constraint.connamespace = 'public'::regnamespace
    where constraint_schema = 'public'
      and table_name in (
        'anonymous_clients',
        'daily_client_quotas',
        'daily_ip_quotas',
        'generation_requests',
        'schema_migrations'
      )
    order by constraint_name
  `;
  const indexes = await sql<{ name: string; definition: string }[]>`
    select indexname as name, indexdef as definition
    from pg_indexes
    where schemaname = 'public'
      and tablename in (
        'anonymous_clients',
        'daily_client_quotas',
        'daily_ip_quotas',
        'generation_requests',
        'schema_migrations'
      )
    order by indexname
  `;
  return { columns, constraints, indexes };
}

async function runAccountingMigration() {
  const { accounting } = await readMigrations();
  await withMigrationDirectory(
    { [basename(accountingMigrationPath)]: accounting },
    (directory) => runMigrations(sql, directory),
  );
}

function insertFinalRequest(overrides: Record<string, unknown> = {}) {
  const row = {
    id: crypto.randomUUID(),
    clientId: CLIENT_ID,
    requestKey: crypto.randomUUID(),
    fingerprint: new Uint8Array(32),
    ipHash: new Uint8Array([16]),
    quotaDate: "2040-01-02",
    requestedCount: 1,
    reservedCount: 1,
    successCount: 0,
    status: "reserved",
    errorCode: null,
    completedAt: null,
    ...overrides,
  };
  return sql`
    insert into generation_requests (
      id, client_id, request_key, payload_fingerprint, ip_hash, quota_date,
      requested_count, reserved_count, success_count, status, error_code,
      expires_at, completed_at
    ) values (
      ${row.id}, ${row.clientId}, ${row.requestKey}, ${row.fingerprint}, ${row.ipHash},
      ${row.quotaDate}, ${row.requestedCount}, ${row.reservedCount}, ${row.successCount},
      ${row.status}, ${row.errorCode}, '2040-01-02T03:00:00Z', ${row.completedAt}
    )
  `;
}

describe("database migrations", () => {
  test("空库执行 001 和 002 并生成最终 schema", async () => {
    await runMigrations(sql, migrationsDirectory);

    const migrations = await sql<{ filename: string }[]>`
      select filename from schema_migrations order by filename
    `;
    expect(migrations.map(({ filename }) => filename)).toEqual([
      "001_public_generation.sql",
      "002_generation_request_accounting.sql",
    ]);

    const generationColumns = (await schemaSnapshot()).columns
      .filter(({ tableName }) => tableName === "generation_requests")
      .map(({ columnName, dataType, nullable }) => ({ columnName, dataType, nullable }));
    expect(generationColumns).toEqual(expect.arrayContaining([
      { columnName: "payload_fingerprint", dataType: "bytea", nullable: "NO" },
      { columnName: "quota_date", dataType: "date", nullable: "NO" },
    ]));
  });

  test("已记录历史 001 且业务表为空时只执行 002", async () => {
    await applyHistoricalMigration();
    const before = await sql<{ filename: string }[]>`select filename from schema_migrations`;
    expect(before.map(({ filename }) => filename)).toEqual(["001_public_generation.sql"]);

    await runMigrations(sql, migrationsDirectory);

    const migrations = await sql<{ filename: string }[]>`
      select filename from schema_migrations order by filename
    `;
    expect(migrations.map(({ filename }) => filename)).toEqual([
      "001_public_generation.sql",
      "002_generation_request_accounting.sql",
    ]);
  });

  test("历史请求从唯一真实候选恢复账期和固定指纹", async () => {
    await applyHistoricalMigration();
    await insertLegacyRequest();
    await insertQuotaCandidate("2040-01-02", 1);

    await runMigrations(sql, migrationsDirectory);

    const [request] = await sql<{ quotaDate: string; fingerprint: string }[]>`
      select quota_date::text as "quotaDate", encode(payload_fingerprint, 'hex') as fingerprint
      from generation_requests where id = ${REQUEST_ID}
    `;
    expect(request).toEqual({ quotaDate: "2040-01-02", fingerprint: LEGACY_FINGERPRINT });
  });

  test("活跃请求要求设备和地址候选都有足够预占", async () => {
    await applyHistoricalMigration();
    await insertLegacyRequest({ requestedCount: 2, reservedCount: 2 });
    await insertQuotaCandidate("2040-01-01", 2, 1);
    await insertQuotaCandidate("2040-01-02", 2, 2);

    await runMigrations(sql, migrationsDirectory);

    const [request] = await sql<{ quotaDate: string }[]>`
      select quota_date::text as "quotaDate" from generation_requests where id = ${REQUEST_ID}
    `;
    expect(request?.quotaDate).toBe("2040-01-02");
  });

  test("零候选账期使整个 002 回滚", async () => {
    await applyHistoricalMigration();
    await insertLegacyRequest();

    await expect(runMigrations(sql, migrationsDirectory)).rejects.toThrow(
      "generation_requests.quota_date recovery requires exactly one candidate",
    );

    const migrations = await sql<{ filename: string }[]>`
      select filename from schema_migrations order by filename
    `;
    expect(migrations.map(({ filename }) => filename)).toEqual(["001_public_generation.sql"]);
    const [{ exists }] = await sql<{ exists: boolean }[]>`
      select exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'generation_requests'
          and column_name = 'quota_date'
      ) as exists
    `;
    expect(exists).toBe(false);
  });

  test("多候选账期失败而不按创建时间猜测", async () => {
    await applyHistoricalMigration();
    await insertLegacyRequest();
    await insertQuotaCandidate("2040-01-01", 1);
    await insertQuotaCandidate("2040-01-02", 1);

    await expect(runMigrations(sql, migrationsDirectory)).rejects.toThrow(
      "generation_requests.quota_date recovery requires exactly one candidate",
    );
  });

  test("开发期已含 quota_date 的 001 收敛到相同语义 schema", async () => {
    const { historical } = await readMigrations();
    await applyHistoricalMigration(developmentMigration(historical));
    await runMigrations(sql, migrationsDirectory);
    const developmentSnapshot = await schemaSnapshot();

    await database.rebuildSchema();
    await runMigrations(sql, migrationsDirectory);
    const cleanSnapshot = await schemaSnapshot();

    expect(developmentSnapshot).toEqual(cleanSnapshot);
  });

  test("开发期 quota_date 默认值被清除并收敛到最终 schema", async () => {
    const { historical } = await readMigrations();
    await applyHistoricalMigration(developmentMigration(historical, "date", "current_date"));

    await runMigrations(sql, migrationsDirectory);

    const [column] = await sql<{ defaultValue: string | null }[]>`
      select column_default as "defaultValue" from information_schema.columns
      where table_schema = 'public' and table_name = 'generation_requests'
        and column_name = 'quota_date'
    `;
    expect(column?.defaultValue).toBeNull();
  });

  test("已有 quota_date 类型错误时使用固定错误并回滚", async () => {
    const { historical } = await readMigrations();
    await applyHistoricalMigration(developmentMigration(historical, "text"));

    await expect(runAccountingMigration()).rejects.toThrow(
      "generation_requests.quota_date must be date",
    );

    const [column] = await sql<{ dataType: string }[]>`
      select data_type as "dataType" from information_schema.columns
      where table_schema = 'public' and table_name = 'generation_requests'
        and column_name = 'quota_date'
    `;
    expect(column?.dataType).toBe("text");
  });

  test("迁移只保留 partial/failed 上的受控错误码", async () => {
    await applyHistoricalMigration();
    const rows = [
      ["failed", "PROVIDER_REJECTED", "20000000-0000-4000-8000-000000000001"],
      ["partial", "PROVIDER_TIMEOUT", "20000000-0000-4000-8000-000000000002"],
      ["failed", "SERVICE_UNAVAILABLE", "20000000-0000-4000-8000-000000000003"],
      ["failed", "INVALID_IMAGE", "20000000-0000-4000-8000-000000000004"],
      ["completed", "PROVIDER_TIMEOUT", "20000000-0000-4000-8000-000000000005"],
      ["expired", "PROVIDER_REJECTED", "20000000-0000-4000-8000-000000000006"],
    ] as const;
    for (const [status, errorCode, id] of rows) {
      const requestedCount = status === "partial" ? 2 : 1;
      const successCount = status === "completed" ? 1 : status === "partial" ? 1 : 0;
      await sql`
        insert into generation_requests (
          id, client_id, request_key, ip_hash, requested_count, reserved_count,
          success_count, status, error_code, expires_at, completed_at
        ) values (
          ${id}, ${CLIENT_ID}, ${id}, decode('10', 'hex'), ${requestedCount}, 0,
          ${successCount}, ${status}, ${errorCode}, '2040-01-02T03:00:00Z',
          '2040-01-02T02:00:00Z'
        )
      `;
    }
    await insertQuotaCandidate("2040-01-02", 0);

    await runMigrations(sql, migrationsDirectory);

    const requests = await sql<{ id: string; errorCode: string | null }[]>`
      select id, error_code as "errorCode" from generation_requests order by id
    `;
    expect(requests.map(({ errorCode }) => errorCode)).toEqual([
      "PROVIDER_REJECTED",
      "PROVIDER_TIMEOUT",
      "SERVICE_UNAVAILABLE",
      null,
      null,
      null,
    ]);
  });

  test("最终约束拒绝非法计数、指纹、状态形状和错误码", async () => {
    await runMigrations(sql, migrationsDirectory);

    await expectSqlState("23514", () => insertFinalRequest({ reservedCount: 2 }));
    await expectSqlState("23514", () => insertFinalRequest({ successCount: 2, reservedCount: 0 }));
    await expectSqlState("23514", () => insertFinalRequest({ successCount: 1, reservedCount: 1 }));
    await expectSqlState("23514", () => insertFinalRequest({ fingerprint: new Uint8Array(31) }));
    await expectSqlState("23514", () => insertFinalRequest({ status: "running", completedAt: new Date() }));
    await expectSqlState("23514", () => insertFinalRequest({ status: "reserved", errorCode: "PROVIDER_TIMEOUT" }));
    await expectSqlState("23514", () => insertFinalRequest({
      status: "failed",
      reservedCount: 0,
      completedAt: new Date(),
      errorCode: "INVALID_IMAGE",
    }));
  });

  test("最终约束接受每一种合法状态形状", async () => {
    await runMigrations(sql, migrationsDirectory);

    await insertFinalRequest({ status: "reserved" });
    await insertFinalRequest({ status: "running" });
    await insertFinalRequest({
      status: "completed",
      reservedCount: 0,
      successCount: 1,
      completedAt: new Date(),
    });
    await insertFinalRequest({
      status: "partial",
      requestedCount: 2,
      reservedCount: 0,
      successCount: 1,
      completedAt: new Date(),
      errorCode: "PROVIDER_REJECTED",
    });
    await insertFinalRequest({
      status: "failed",
      reservedCount: 0,
      completedAt: new Date(),
      errorCode: "PROVIDER_TIMEOUT",
    });
    await insertFinalRequest({
      status: "expired",
      reservedCount: 0,
      completedAt: new Date(),
    });

    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int as count from generation_requests
    `;
    expect(count).toBe(6);
  });

  test("索引语义保持不变且重复迁移幂等", async () => {
    await runMigrations(sql, migrationsDirectory);
    await expect(runMigrations(sql, migrationsDirectory)).resolves.toBeUndefined();

    const indexes = await sql<{
      indexName: string;
      unique: boolean;
      columns: string[];
      predicate: string | null;
    }[]>`
      select
        index_class.relname as "indexName",
        index_data.indisunique as unique,
        array(
          select attribute.attname
          from unnest(index_data.indkey::smallint[]) with ordinality as key(attnum, position)
          join pg_attribute attribute
            on attribute.attrelid = index_data.indrelid and attribute.attnum = key.attnum
          where key.position <= index_data.indnkeyatts
          order by key.position
        ) as columns,
        pg_get_expr(index_data.indpred, index_data.indrelid) as predicate
      from pg_index index_data
      join pg_class index_class on index_class.oid = index_data.indexrelid
      where index_class.relname in (
        'generation_requests_client_key_uidx',
        'generation_requests_expiry_idx'
      )
      order by index_class.relname
    `;
    expect([...indexes]).toEqual([
      {
        indexName: "generation_requests_client_key_uidx",
        unique: true,
        columns: ["client_id", "request_key"],
        predicate: null,
      },
      {
        indexName: "generation_requests_expiry_idx",
        unique: false,
        columns: ["expires_at"],
        predicate: "(status = ANY (ARRAY['reserved'::text, 'running'::text]))",
      },
    ]);
  });

  test("测试 session lock 与迁移事务锁不会自锁", async () => {
    await expect(runMigrations(sql, migrationsDirectory)).resolves.toBeUndefined();
  });
});
