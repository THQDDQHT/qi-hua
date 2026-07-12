export type ServerConfig = {
  port: number;
  databaseUrl: string;
  aiBaseUrl: string;
  aiApiKey: string;
  aiModel: string;
  anonTokenSecret: string;
  ipHashSecret: string;
  publicOrigin: string;
  publicGenerationEnabled: boolean;
  dailyDeviceLimit: number;
  dailyIpLimit: number;
  timezone: "Asia/Shanghai";
  upstreamTimeoutMs: number;
  reservationTtlSeconds: number;
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

  return {
    port: integer(env, "PORT", 3001),
    databaseUrl: required(env, "DATABASE_URL"),
    aiBaseUrl: required(env, "AI_BASE_URL"),
    aiApiKey: required(env, "AI_API_KEY"),
    aiModel: required(env, "AI_MODEL"),
    anonTokenSecret: secret(env, "ANON_TOKEN_SECRET"),
    ipHashSecret: secret(env, "IP_HASH_SECRET"),
    publicOrigin: required(env, "PUBLIC_ORIGIN"),
    publicGenerationEnabled: boolean(env, "PUBLIC_GENERATION_ENABLED", true),
    dailyDeviceLimit: integer(env, "DAILY_DEVICE_LIMIT", 10),
    dailyIpLimit: integer(env, "DAILY_IP_LIMIT", 30),
    timezone,
    upstreamTimeoutMs: integer(env, "UPSTREAM_TIMEOUT_MS", 180000),
    reservationTtlSeconds: integer(env, "RESERVATION_TTL_SECONDS", 600),
  };
}
