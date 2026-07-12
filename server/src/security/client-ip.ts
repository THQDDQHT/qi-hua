import { createHmac } from "node:crypto";
import { isIP } from "node:net";

function normalizeIp(ip: string) {
  const value = ip.trim();
  const version = isIP(value);
  if (version === 4) return value;
  if (version === 6) return new URL(`http://[${value}]/`).hostname.slice(1, -1).toLowerCase();
  throw new Error("invalid client IP");
}

export async function hashDailyIp(
  ip: string,
  quotaDate: string,
  secret: string,
): Promise<Uint8Array> {
  return createHmac("sha256", secret).update(`${quotaDate}\n${normalizeIp(ip)}`).digest();
}
