export type ServerConfig = {
  port: number;
  databaseUrl: string;
  redisUrl: string;
  aiBaseUrl: string;
  aiApiKey: string;
  aiModel: string;
  anonTokenSecret: string;
  ipHashSecret: string;
  idempotencySecret: string;
  publicOrigin: string;
  publicGenerationEnabled: boolean;
  dailyDeviceLimit: number;
  dailyIpLimit: number;
  timezone: "Asia/Shanghai";
  upstreamTimeoutMs: number;
  reservationTtlSeconds: number;
  executionLeaseSeconds: number;
  imageWorkerConcurrency: number;
  generationStorageDir: string;
  generationResultTtlSeconds: number;
  workerHealthPort: number;
};

type Env = Record<string, string | undefined>;

function required(env: Env, name: string) {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function secret(env: Env, name: string) {
  const value = required(env, name);
  if (value.length < 32) throw new Error(`${name} must be at least 32 characters`);
  return value;
}

function integer(env: Env, name: string, fallback: number) {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function smallintLimit(env: Env, name: string, fallback: number) {
  const value = integer(env, name, fallback);
  if (value > 32767) throw new Error(`${name} must be between 1 and 32767`);
  return value;
}

function boolean(env: Env, name: string, fallback: boolean) {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false`);
}

export function loadConfig(env: Env): ServerConfig {
  const timezone = env.TIMEZONE ?? "Asia/Shanghai";
  if (timezone !== "Asia/Shanghai") throw new Error("TIMEZONE must be Asia/Shanghai");

  const port = integer(env, "PORT", 3001);
  if (port > 65535) throw new Error("PORT must be between 1 and 65535");

  let aiBaseUrl: string;
  let redisUrl: string;
  let publicOrigin: string;
  try {
    aiBaseUrl = new URL(required(env, "AI_BASE_URL")).toString().replace(/\/$/, "");
  } catch {
    throw new Error("AI_BASE_URL must be a valid URL");
  }
  try {
    const parsed = new URL(required(env, "REDIS_URL"));
    if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") throw new Error();
    redisUrl = parsed.toString();
  } catch {
    throw new Error("REDIS_URL must be a valid redis URL");
  }
  try {
    publicOrigin = new URL(required(env, "PUBLIC_ORIGIN")).origin;
  } catch {
    throw new Error("PUBLIC_ORIGIN must be a valid origin URL");
  }

  const upstreamTimeoutMs = integer(env, "UPSTREAM_TIMEOUT_MS", 180000);
  const reservationTtlSeconds = integer(env, "RESERVATION_TTL_SECONDS", 21600);
  const executionLeaseSeconds = integer(env, "EXECUTION_LEASE_SECONDS", 300);
  if (executionLeaseSeconds * 1000 <= upstreamTimeoutMs + 5000) {
    throw new Error("EXECUTION_LEASE_SECONDS must exceed UPSTREAM_TIMEOUT_MS by at least 5 seconds");
  }
  const imageWorkerConcurrency = integer(env, "IMAGE_WORKER_CONCURRENCY", 5);
  if (imageWorkerConcurrency > 10) {
    throw new Error("IMAGE_WORKER_CONCURRENCY must be between 1 and 10");
  }
  const generationStorageDir = env.GENERATION_STORAGE_DIR ?? "/data/public-generation-temp";
  if (!generationStorageDir.startsWith("/")) {
    throw new Error("GENERATION_STORAGE_DIR must be an absolute path");
  }

  return {
    port,
    databaseUrl: required(env, "DATABASE_URL"),
    redisUrl,
    aiBaseUrl,
    aiApiKey: required(env, "AI_API_KEY"),
    aiModel: required(env, "AI_MODEL"),
    anonTokenSecret: secret(env, "ANON_TOKEN_SECRET"),
    ipHashSecret: secret(env, "IP_HASH_SECRET"),
    idempotencySecret: secret(env, "IDEMPOTENCY_SECRET"),
    publicOrigin,
    publicGenerationEnabled: boolean(env, "PUBLIC_GENERATION_ENABLED", true),
    dailyDeviceLimit: smallintLimit(env, "DAILY_DEVICE_LIMIT", 10),
    dailyIpLimit: smallintLimit(env, "DAILY_IP_LIMIT", 30),
    timezone,
    upstreamTimeoutMs,
    reservationTtlSeconds,
    executionLeaseSeconds,
    imageWorkerConcurrency,
    generationStorageDir,
    generationResultTtlSeconds: integer(env, "GENERATION_RESULT_TTL_SECONDS", 86400),
    workerHealthPort: (() => {
      const value = integer(env, "WORKER_HEALTH_PORT", 3002);
      if (value > 65535) throw new Error("WORKER_HEALTH_PORT must be between 1 and 65535");
      return value;
    })(),
  };
}
