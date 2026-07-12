import { Hono } from "hono";
import type { Sql } from "postgres";
import type { ServerConfig } from "./config";
import { requirePublicRequest, type PublicRequestEnv } from "./middleware/public-request";
import { registerSessionRoutes } from "./routes/session";

export type AppEnv = PublicRequestEnv;

export type AppDependencies = {
  config: ServerConfig;
  sql: Sql;
};

export function createApp({ config, sql }: AppDependencies) {
  const app = new Hono<AppEnv>();

  app.use("*", async (context, next) => {
    context.set("config", config);
    await next();
  });

  app.use("/api/*", requirePublicRequest({ config, sql }));
  registerSessionRoutes(app, sql);

  return app;
}
