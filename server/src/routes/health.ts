import type { Hono } from "hono";
import type { Sql } from "postgres";
import type { AppEnv } from "../app";

export function registerHealthRoutes(app: Hono<AppEnv>, sql: Sql) {
  app.get("/health/live", (context) => context.json({ status: "ok" as const }));

  app.get("/health/ready", async (context) => {
    try {
      await sql`select 1`;
      return context.json({ status: "ok" as const });
    } catch {
      return context.json({ status: "unavailable" as const }, 503);
    }
  });
}
