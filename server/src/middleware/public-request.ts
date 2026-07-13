import type { MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Sql } from "postgres";
import type { ServerConfig } from "../config";
import { createAnonymousToken, hashAnonymousToken } from "../security/anonymous-token";
import { getShanghaiQuotaWindow } from "../services/quota-snapshot";
import { hashDailyIp } from "../security/client-ip";

const COOKIE_NAME = "anon_session";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type PublicRequestEnv = {
  Variables: {
    config: ServerConfig;
    clientId: string;
    ipHash: Uint8Array;
    quotaDate: string;
    resetAt: string;
  };
};

type Dependencies = { config: ServerConfig; sql: Sql };

function invalidRequest(message: string) {
  return { error: { code: "INVALID_REQUEST" as const, message } };
}

export function requirePublicRequest({ config, sql }: Dependencies): MiddlewareHandler<PublicRequestEnv> {
  return async (context, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(context.req.method)) {
      if (context.req.header("Origin") !== config.publicOrigin) {
        return context.json(invalidRequest("请求来源不受信任"), 403);
      }
    }

    const currentToken = getCookie(context, COOKIE_NAME);
    const canCreateClient = context.req.method === "GET" && context.req.path === "/api/session";
    if (currentToken === undefined && !canCreateClient) {
      return context.json(invalidRequest("请先建立匿名会话"), 401);
    }
    if (currentToken !== undefined && !TOKEN_PATTERN.test(currentToken)) {
      return context.json(invalidRequest("匿名会话凭证无效"), 403);
    }

    const clientIp = context.req.header("CF-Connecting-IP");
    if (!clientIp) return context.json(invalidRequest("缺少可信的客户端地址"), 403);

    const { quotaDate, resetAt } = getShanghaiQuotaWindow(new Date());
    let ipHash: Uint8Array;
    try {
      ipHash = await hashDailyIp(clientIp, quotaDate, config.ipHashSecret);
    } catch {
      return context.json(invalidRequest("客户端地址无效"), 403);
    }

    let clientId: string;
    if (currentToken === undefined) {
      const token = createAnonymousToken();
      clientId = crypto.randomUUID();
      await sql`
        insert into anonymous_clients (id, token_hash, status)
        values (${clientId}, ${await hashAnonymousToken(token, config.anonTokenSecret)}, 'active')
      `;
      setCookie(context, COOKIE_NAME, token, {
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
        maxAge: 31536000,
        path: "/",
      });
    } else {
      const [client] = await sql<{ id: string; status: "active" | "disabled" }[]>`
        insert into anonymous_clients (id, token_hash, status)
        values (
          ${crypto.randomUUID()},
          ${await hashAnonymousToken(currentToken, config.anonTokenSecret)},
          'active'
        )
        on conflict (token_hash) do update set last_seen_at = now()
        returning id, status
      `;
      if (client.status === "disabled") {
        return context.json(invalidRequest("此匿名客户端已被禁用"), 403);
      }
      clientId = client.id;
    }

    context.set("clientId", clientId);
    context.set("ipHash", ipHash);
    context.set("quotaDate", quotaDate);
    context.set("resetAt", resetAt);
    await next();
  };
}
