import { resolve } from "node:path";
import type { ReservedSql, Sql } from "postgres";
import { createSql } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";

const TEST_DATABASE_LOCK_ID = 2026071301;
const EXPECTED_DATABASE_NAME = "infinite_canvas_test";
const TABLES = [
  "generation_requests",
  "daily_ip_quotas",
  "daily_client_quotas",
  "anonymous_clients",
  "schema_migrations",
];

type DatabaseTestHarnessOptions = {
  migrate: boolean;
};

export type DatabaseTestHarness = {
  sql: Sql;
  setup(): Promise<void>;
  rebuildSchema(): Promise<void>;
  teardown(): Promise<void>;
};

export function createDatabaseTestHarness({ migrate }: DatabaseTestHarnessOptions): DatabaseTestHarness {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");

  const sql = createSql(databaseUrl);
  let reserved: ReservedSql | undefined;
  let locked = false;

  async function rebuildSchema() {
    if (!locked) throw new Error("database test lock must be held before rebuilding schema");

    const existing = await sql<{ tableName: string }[]>`
      select table_name as "tableName"
      from information_schema.tables
      where table_schema = 'public' and table_name in ${sql(TABLES)}
    `;
    for (const { tableName } of existing) {
      await sql`drop table ${sql(tableName)} cascade`;
    }
  }

  async function setup() {
    if (reserved) throw new Error("database test harness is already set up");

    reserved = await sql.reserve();
    try {
      const [{ databaseName }] = await reserved<{ databaseName: string }[]>`
        select current_database() as "databaseName"
      `;
      if (databaseName !== EXPECTED_DATABASE_NAME) {
        throw new Error(`database tests require ${EXPECTED_DATABASE_NAME}, received ${databaseName}`);
      }

      await reserved`select pg_advisory_lock(${TEST_DATABASE_LOCK_ID})`;
      locked = true;
      await rebuildSchema();
      if (migrate) {
        await runMigrations(sql, resolve(import.meta.dir, "../../migrations"));
      }
    } catch (error) {
      await teardown();
      throw error;
    }
  }

  async function teardown() {
    const connection = reserved;
    reserved = undefined;
    try {
      if (connection && locked) {
        await connection`select pg_advisory_unlock(${TEST_DATABASE_LOCK_ID})`;
      }
    } finally {
      locked = false;
      try {
        connection?.release();
      } finally {
        await sql.end();
      }
    }
  }

  return { sql, setup, rebuildSchema, teardown };
}
