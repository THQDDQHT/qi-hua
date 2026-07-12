import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createSql } from "../src/db/client";
import { runMigrations } from "../src/db/migrate";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");

const sql = createSql(databaseUrl);
const migrationsDirectory = resolve(import.meta.dir, "../migrations");

const expected = {
  anonymous_clients: ["id", "token_hash", "status", "created_at", "last_seen_at", "disabled_at"],
  daily_client_quotas: ["client_id", "quota_date", "success_count", "reserved_count", "updated_at"],
  daily_ip_quotas: ["ip_hash", "quota_date", "success_count", "reserved_count", "updated_at"],
  generation_requests: [
    "id",
    "client_id",
    "request_key",
    "ip_hash",
    "requested_count",
    "reserved_count",
    "success_count",
    "status",
    "error_code",
    "expires_at",
    "created_at",
    "completed_at",
  ],
};

async function expectSqlState(code: string, operation: () => Promise<unknown>) {
  let error: unknown;
  try {
    await operation();
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({ code });
}

function insertGenerationRequest({
  id,
  clientId = "10000000-0000-4000-8000-000000000001",
  requestKey = id,
  requestedCount = 1,
  reservedCount = 1,
  successCount = 0,
  status = "reserved",
}: {
  id: string;
  clientId?: string;
  requestKey?: string;
  requestedCount?: number;
  reservedCount?: number;
  successCount?: number;
  status?: string;
}) {
  return sql`
    insert into generation_requests (
      id, client_id, request_key, ip_hash, requested_count, reserved_count, success_count, status, expires_at
    ) values (
      ${id}, ${clientId}, ${requestKey}, decode('10', 'hex'), ${requestedCount}, ${reservedCount},
      ${successCount}, ${status}, now() + interval '10 minutes'
    )
  `;
}

async function resetSchema() {
  const [{ database_name }] = await sql<{ database_name: string }[]>`
    select current_database() as database_name
  `;
  if (database_name !== "infinite_canvas_test") {
    throw new Error(`migration tests require infinite_canvas_test, received ${database_name}`);
  }

  const targetTables = [
    "generation_requests",
    "daily_ip_quotas",
    "daily_client_quotas",
    "anonymous_clients",
    "schema_migrations",
  ];
  const existingTables = await sql<{ table_name: string }[]>`
    select table_name
    from information_schema.tables
    where table_schema = 'public' and table_name in ${sql(targetTables)}
  `;
  for (const { table_name } of existingTables) {
    await sql`drop table ${sql(table_name)} cascade`;
  }
}

describe("database migrations", () => {
  beforeAll(resetSchema);
  afterAll(() => sql.end());

  test("创建公众生图所需的表、约束和索引", async () => {
    await runMigrations(sql, migrationsDirectory);

    const columns = await sql<{ table_name: keyof typeof expected; column_name: string }[]>`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name in ${sql(Object.keys(expected))}
      order by table_name, ordinal_position
    `;
    const actual = Object.fromEntries(
      Object.keys(expected).map((table) => [
        table,
        columns.filter((column) => column.table_name === table).map((column) => column.column_name),
      ]),
    );
    expect(actual).toEqual(expected);

    const constraints = await sql<{ constraint_name: string }[]>`
      select constraint_name
      from information_schema.table_constraints
      where constraint_schema = 'public'
        and constraint_name in (
          'anonymous_clients_status_check',
          'daily_client_counts_check',
          'daily_ip_counts_check',
          'generation_request_count_check',
          'generation_request_status_check'
        )
      order by constraint_name
    `;
    expect(constraints.map(({ constraint_name }) => constraint_name)).toEqual([
      "anonymous_clients_status_check",
      "daily_client_counts_check",
      "daily_ip_counts_check",
      "generation_request_count_check",
      "generation_request_status_check",
    ]);

    const indexes = await sql<{ indexname: string }[]>`
      select indexname
      from pg_indexes
      where schemaname = 'public'
        and indexname in ('generation_requests_client_key_uidx', 'generation_requests_expiry_idx')
      order by indexname
    `;
    expect(indexes.map(({ indexname }) => indexname)).toEqual([
      "generation_requests_client_key_uidx",
      "generation_requests_expiry_idx",
    ]);

    const migrations = await sql<{ filename: string }[]>`
      select filename from schema_migrations order by filename
    `;
    expect(migrations.map(({ filename }) => filename)).toEqual(["001_public_generation.sql"]);
  });

  test("检查约束拒绝非法状态、数量和负计数", async () => {
    await expectSqlState("23514", () => sql`
      insert into anonymous_clients (id, token_hash, status)
      values ('20000000-0000-4000-8000-000000000001', decode('20', 'hex'), 'pending')
    `);
    await expectSqlState("23514", () => sql`
      insert into daily_client_quotas (client_id, quota_date, success_count, reserved_count)
      values ('30000000-0000-4000-8000-000000000001', current_date, -1, 0)
    `);
    await expectSqlState("23514", () => sql`
      insert into daily_client_quotas (client_id, quota_date, success_count, reserved_count)
      values ('30000000-0000-4000-8000-000000000002', current_date, 0, -1)
    `);
    await expectSqlState("23514", () => sql`
      insert into daily_ip_quotas (ip_hash, quota_date, success_count, reserved_count)
      values (decode('30', 'hex'), current_date, -1, 0)
    `);
    await expectSqlState("23514", () => sql`
      insert into daily_ip_quotas (ip_hash, quota_date, success_count, reserved_count)
      values (decode('31', 'hex'), current_date, 0, -1)
    `);
    await expectSqlState("23514", () => insertGenerationRequest({
      id: "40000000-0000-4000-8000-000000000001",
      requestedCount: 0,
    }));
    await expectSqlState("23514", () => insertGenerationRequest({
      id: "40000000-0000-4000-8000-000000000002",
      requestedCount: 5,
    }));
    await expectSqlState("23514", () => insertGenerationRequest({
      id: "40000000-0000-4000-8000-000000000003",
      reservedCount: -1,
    }));
    await expectSqlState("23514", () => insertGenerationRequest({
      id: "40000000-0000-4000-8000-000000000004",
      successCount: -1,
    }));
    await expectSqlState("23514", () => insertGenerationRequest({
      id: "40000000-0000-4000-8000-000000000005",
      status: "pending",
    }));
  });

  test("同一客户端和请求键只能写入一次", async () => {
    const clientId = "50000000-0000-4000-8000-000000000001";
    const requestKey = "same-request";
    await insertGenerationRequest({
      id: "50000000-0000-4000-8000-000000000002",
      clientId,
      requestKey,
    });
    await expectSqlState("23505", () => insertGenerationRequest({
      id: "50000000-0000-4000-8000-000000000003",
      clientId,
      requestKey,
    }));
  });

  test("索引列、唯一性和部分索引谓词符合设计", async () => {
    const indexes = await sql<{
      index_name: string;
      is_unique: boolean;
      column_names: string[];
      predicate: string | null;
    }[]>`
      select
        index_class.relname as index_name,
        index_data.indisunique as is_unique,
        array(
          select attribute.attname
          from unnest(index_data.indkey::smallint[]) with ordinality as key(attnum, position)
          join pg_attribute attribute
            on attribute.attrelid = index_data.indrelid and attribute.attnum = key.attnum
          where key.position <= index_data.indnkeyatts
          order by key.position
        ) as column_names,
        pg_get_expr(index_data.indpred, index_data.indrelid) as predicate
      from pg_index index_data
      join pg_class index_class on index_class.oid = index_data.indexrelid
      join pg_class table_class on table_class.oid = index_data.indrelid
      join pg_namespace table_namespace on table_namespace.oid = table_class.relnamespace
      where index_class.relname in (
        'generation_requests_client_key_uidx',
        'generation_requests_expiry_idx'
      )
        and table_namespace.nspname = 'public'
        and table_class.relname = 'generation_requests'
      order by index_class.relname
    `;

    expect(indexes).toHaveLength(2);
    expect(indexes[0]).toEqual({
      index_name: "generation_requests_client_key_uidx",
      is_unique: true,
      column_names: ["client_id", "request_key"],
      predicate: null,
    });
    expect(indexes[1]?.index_name).toBe("generation_requests_expiry_idx");
    expect(indexes[1]?.is_unique).toBe(false);
    expect(indexes[1]?.column_names).toEqual(["expires_at"]);
    expect(indexes[1]?.predicate).toBe(
      "(status = ANY (ARRAY['reserved'::text, 'running'::text]))",
    );
  });

  test("重复执行迁移保持幂等", async () => {
    await expect(runMigrations(sql, migrationsDirectory)).resolves.toBeUndefined();
  });
});
