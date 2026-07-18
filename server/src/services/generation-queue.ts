import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";

export const GENERATION_QUEUE_NAME = "image-generation";
export const GENERATION_QUEUE_PREFIX = "infinite-canvas";

export type GenerationJobData = { requestId: string };

const jobOptions = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5000 },
  removeOnComplete: true,
  removeOnFail: true,
};

export function createGenerationQueue(redisUrl: string) {
  const connection = new IORedis(redisUrl, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
  });
  connection.on("error", () => undefined);
  const queue = new Queue<GenerationJobData>(GENERATION_QUEUE_NAME, {
    connection,
    prefix: GENERATION_QUEUE_PREFIX,
    defaultJobOptions: jobOptions,
  });
  queue.on("error", () => undefined);

  return {
    async ping() {
      if (connection.status === "wait") await connection.connect();
      return connection.ping();
    },
    enqueue(requestId: string) {
      return queue.add("generate", { requestId }, { jobId: requestId });
    },
    setGlobalConcurrency(concurrency: number) {
      return queue.setGlobalConcurrency(concurrency);
    },
    async close() {
      await queue.close();
      connection.disconnect();
    },
  };
}

export function createGenerationWorker(input: {
  redisUrl: string;
  concurrency: number;
  process: (job: Job<GenerationJobData>) => Promise<void>;
}) {
  const connection = new IORedis(input.redisUrl, { maxRetriesPerRequest: null });
  connection.on("error", () => undefined);
  const worker = new Worker<GenerationJobData>(GENERATION_QUEUE_NAME, input.process, {
    connection,
    prefix: GENERATION_QUEUE_PREFIX,
    concurrency: input.concurrency,
  });
  worker.on("error", () => undefined);
  return {
    worker,
    async close() {
      await worker.close();
      connection.disconnect();
    },
  };
}
