import { loadConfig } from "./config";
import { createSql } from "./db/client";
import { createQuotaRepository } from "./db/quota-repository";
import { createGenerationWorkerProcessor } from "./services/generation-service";
import { createGenerationQueue, createGenerationWorker } from "./services/generation-queue";
import { createGenerationStorage } from "./services/generation-storage";
import { createImageProvider } from "./services/image-provider";

const config = loadConfig(Bun.env);
const sql = createSql(config.databaseUrl);
const repository = createQuotaRepository(sql);
const storage = createGenerationStorage(config.generationStorageDir);
const processGeneration = createGenerationWorkerProcessor({
  repository,
  provider: createImageProvider(config),
  storage,
  upstreamTimeoutMs: config.upstreamTimeoutMs,
  executionLeaseSeconds: config.executionLeaseSeconds,
  resultTtlSeconds: config.generationResultTtlSeconds,
});
const queue = createGenerationQueue(config.redisUrl);
await queue.ping();
await queue.setGlobalConcurrency(config.imageWorkerConcurrency);
await storage.checkReady();
const generationWorker = createGenerationWorker({
  redisUrl: config.redisUrl,
  concurrency: config.imageWorkerConcurrency,
  process: async (job) => processGeneration(job.data),
});
await generationWorker.worker.waitUntilReady();

let ready = true;
generationWorker.worker.on("failed", (job) => {
  console.error("Generation job failed", {
    requestId: job?.data.requestId,
    errorCode: "SERVICE_UNAVAILABLE",
  });
});

const health = Bun.serve({
  hostname: "127.0.0.1",
  port: config.workerHealthPort,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/health/live") return Response.json({ status: "ok" });
    if (path === "/health/ready") {
      try {
        await sql`select 1`;
        await queue.ping();
        await storage.checkReady();
        if (ready && generationWorker.worker.isRunning()) {
          return Response.json({ status: "ok" });
        }
      } catch {
        // Return the same safe response for every dependency failure.
      }
      return Response.json({ status: "unavailable" }, { status: 503 });
    }
    return new Response("Not Found", { status: 404 });
  },
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  ready = false;
  await health.stop(true);
  await generationWorker.close();
  await queue.close();
  await sql.end({ timeout: 5 });
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
