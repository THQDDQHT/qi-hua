import { Hono } from "hono";
import type { ServerConfig } from "./config";

export type AppEnv = {
  Variables: {
    config: ServerConfig;
  };
};

export type AppDependencies = {
  config: ServerConfig;
};

export function createApp({ config }: AppDependencies) {
  const app = new Hono<AppEnv>();

  app.use("*", async (context, next) => {
    context.set("config", config);
    await next();
  });

  return app;
}
