import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";
import { createSql } from "./client";

const migrationLockId = 2026071202;

export async function runMigrations(sql: Sql, directory: string) {
  const filenames = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
  const migrations = await Promise.all(
    filenames.map(async (filename) => ({ filename, source: await readFile(join(directory, filename), "utf8") })),
  );

  await sql.begin(async (transaction) => {
    await transaction`select pg_advisory_xact_lock(${migrationLockId})`;
    const [{ migrationsTableExists }] = await transaction<{ migrationsTableExists: boolean }[]>`
      select to_regclass('public.schema_migrations') is not null as "migrationsTableExists"
    `;
    if (!migrationsTableExists) {
      await transaction`
        create table schema_migrations (
          filename text primary key,
          applied_at timestamptz not null default now()
        )
      `;
    }
    const applied = new Set(
      (await transaction<{ filename: string }[]>`select filename from schema_migrations`).map(
        ({ filename }) => filename,
      ),
    );

    for (const migration of migrations) {
      if (applied.has(migration.filename)) continue;
      await transaction.unsafe(migration.source);
      await transaction`insert into schema_migrations (filename) values (${migration.filename})`;
    }
  });
}

if (import.meta.main) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const sql = createSql(databaseUrl);
  try {
    await runMigrations(sql, fileURLToPath(new URL("../../migrations", import.meta.url)));
  } finally {
    await sql.end();
  }
}
