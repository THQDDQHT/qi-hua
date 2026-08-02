import { Hono } from "hono";
import { serveStatic } from "hono/bun";
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
  // 提示词库静态文件（小程序端直接从此服务拉取，covers 长缓存、清单短缓存）。
  app.use(
    "/prompt-library/*",
    serveStatic({
      root: config.promptLibraryDir,
      rewriteRequestPath: (path) => path.replace(/^\/prompt-library/, ""),
      onFound: (path, context) => {
        context.header(
          "Cache-Control",
          path.endsWith(".json") ? "no-cache" : "public, max-age=31536000, immutable",
        );
      },
    }),
  );
  app.use("/api/*", requirePublicRequest({ config, sql }));
  registerSessionRoutes(app, sql);

  if (generationService) registerImageRoutes(app, generationService);

  return app;
}
