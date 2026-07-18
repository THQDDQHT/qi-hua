import { createApp } from "./app";
import { loadConfig } from "./config";
import { createSql } from "./db/client";
import { createQuotaRepository } from "./db/quota-repository";
import { createGenerationApiService } from "./services/generation-service";
import { createGenerationQueue } from "./services/generation-queue";
import { createGenerationStorage } from "./services/generation-storage";
import { createQuotaService } from "./services/quota-service";

const config = loadConfig(Bun.env);
const sql = createSql(config.databaseUrl);
const repository = createQuotaRepository(sql);
const quotaService = createQuotaService({
  repository,
  deviceLimit: config.dailyDeviceLimit,
  ipLimit: config.dailyIpLimit,
});
const queue = createGenerationQueue(config.redisUrl);
const generationService = createGenerationApiService({
  sql,
  repository,
  quotaService,
  queue,
  storage: createGenerationStorage(config.generationStorageDir),
  idempotencySecret: config.idempotencySecret,
  reservationTtlSeconds: config.reservationTtlSeconds,
  deviceLimit: config.dailyDeviceLimit,
});

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
void generationService.dispatchPending().catch(() => {
  console.error("Generation queue dispatch failed", { errorCode: "SERVICE_UNAVAILABLE" });
});
const app = createApp({ config, sql, generationService });
const server = Bun.serve({ port: config.port, fetch: app.fetch });

let maintaining = false;
const timer = setInterval(async () => {
  if (maintaining) return;
  maintaining = true;
  try {
    await sweepExpiredReservations();
    await generationService.cleanupExpiredArtifacts();
  } catch {
    console.error("Generation maintenance failed", { errorCode: "SERVICE_UNAVAILABLE" });
  } finally {
    maintaining = false;
  }
}, 60_000);
timer.unref?.();

let dispatching = false;
const dispatchTimer = setInterval(async () => {
  if (dispatching) return;
  dispatching = true;
  try {
    await generationService.dispatchPending();
  } catch {
    console.error("Generation queue dispatch failed", { errorCode: "SERVICE_UNAVAILABLE" });
  } finally {
    dispatching = false;
  }
}, 2_000);
dispatchTimer.unref?.();

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(timer);
  clearInterval(dispatchTimer);
  await server.stop(true);
  await queue.close();
  await sql.end({ timeout: 5 });
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
