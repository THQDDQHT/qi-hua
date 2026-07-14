import { createApp } from "./app";
import { loadConfig } from "./config";
import { createSql } from "./db/client";
import { createQuotaRepository } from "./db/quota-repository";
import { createImageProvider } from "./services/image-provider";
import { createQuotaService } from "./services/quota-service";

const config = loadConfig(Bun.env);
const sql = createSql(config.databaseUrl);
const quotaService = createQuotaService({
  repository: createQuotaRepository(sql),
  deviceLimit: config.dailyDeviceLimit,
  ipLimit: config.dailyIpLimit,
});
const provider = createImageProvider(config);

async function sweepExpiredReservations() {
  try {
    const result = await quotaService.expireReservations(new Date());
    if (result.expired || result.inconsistent) {
      console.info("Quota expiration sweep completed", result);
    }
  } catch {
    console.error("Quota expiration sweep failed", { errorCode: "SERVICE_UNAVAILABLE" });
  }
}

await sweepExpiredReservations();
const app = createApp({ config, sql, quotaService, provider });
const server = Bun.serve({ port: config.port, fetch: app.fetch });

let sweeping = false;
const timer = setInterval(async () => {
  if (sweeping) return;
  sweeping = true;
  try {
    await sweepExpiredReservations();
  } finally {
    sweeping = false;
  }
}, 60_000);
timer.unref?.();

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(timer);
  await server.stop(true);
  await sql.end({ timeout: 5 });
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
