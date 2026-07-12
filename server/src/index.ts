import { createApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig(Bun.env);
const app = createApp({ config });

Bun.serve({ port: config.port, fetch: app.fetch });
