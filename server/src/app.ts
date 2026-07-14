import { Hono } from "hono";
import type { Sql } from "postgres";
import type { ServerConfig } from "./config";
import type { ImageProvider } from "./services/image-provider";
import type { createQuotaService } from "./services/quota-service";
import { createGenerationService } from "./services/generation-service";
import { requirePublicRequest, type PublicRequestEnv } from "./middleware/public-request";
import { registerHealthRoutes } from "./routes/health";
import { registerImageRoutes } from "./routes/images";
import { registerSessionRoutes } from "./routes/session";

export type AppEnv = PublicRequestEnv;

type QuotaService = ReturnType<typeof createQuotaService>;

export type AppDependencies = {
  config: ServerConfig;
  sql: Sql;
  quotaService?: QuotaService;
  provider?: ImageProvider;
};

export function createApp({ config, sql, quotaService, provider }: AppDependencies) {
  const app = new Hono<AppEnv>();

  app.use("*", async (context, next) => {
    context.set("config", config);
    await next();
  });

  registerHealthRoutes(app, sql);
  app.use("/api/*", requirePublicRequest({ config, sql }));
  registerSessionRoutes(app, sql);

  if (quotaService && provider) {
    registerImageRoutes(app, createGenerationService({
      quotaService,
      provider,
      idempotencySecret: config.idempotencySecret,
      reservationTtlSeconds: config.reservationTtlSeconds,
      upstreamTimeoutMs: config.upstreamTimeoutMs,
    }));
  }

  return app;
}
