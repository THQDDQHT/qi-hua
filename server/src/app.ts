import { Hono } from "hono";
import type { Sql } from "postgres";
import type { ServerConfig } from "./config";
import type { createGenerationApiService } from "./services/generation-service";
import { requirePublicRequest, type PublicRequestEnv } from "./middleware/public-request";
import { registerHealthRoutes } from "./routes/health";
import { registerImageRoutes } from "./routes/images";
import { registerSessionRoutes } from "./routes/session";

export type AppEnv = PublicRequestEnv;

export type AppDependencies = {
  config: ServerConfig;
  sql: Sql;
  generationService?: ReturnType<typeof createGenerationApiService>;
};

export function createApp({ config, sql, generationService }: AppDependencies) {
  const app = new Hono<AppEnv>();

  app.use("*", async (context, next) => {
    context.set("config", config);
    await next();
  });

  registerHealthRoutes(app, sql, generationService?.checkReady);
  app.use("/api/*", requirePublicRequest({ config, sql }));
  registerSessionRoutes(app, sql);

  if (generationService) registerImageRoutes(app, generationService);

  return app;
}
