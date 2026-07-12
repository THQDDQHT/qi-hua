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

  test("重复执行迁移保持幂等", async () => {
    await expect(runMigrations(sql, migrationsDirectory)).resolves.toBeUndefined();
  });
});
