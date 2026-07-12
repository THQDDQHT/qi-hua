import postgres, { type Sql } from "postgres";

export type Database = Sql;

export function createSql(databaseUrl: string) {
  return postgres(databaseUrl);
}
