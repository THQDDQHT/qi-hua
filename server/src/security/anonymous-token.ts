import { createHash, randomBytes } from "node:crypto";

export function createAnonymousToken() {
  return randomBytes(32).toString("base64url");
}

export async function hashAnonymousToken(token: string, secret: string): Promise<Uint8Array> {
  return createHash("sha256").update(token + secret).digest();
}
