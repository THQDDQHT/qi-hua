import { createApp } from "./app";
import { loadConfig } from "./config";
import { createSql } from "./db/client";

const config = loadConfig(Bun.env);
const sql = createSql(config.databaseUrl);
const app = createApp({ config, sql });

Bun.serve({ port: config.port, fetch: app.fetch });
