import type { MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Sql } from "postgres";
import type { ServerConfig } from "../config";
import { getShanghaiQuotaWindow } from "../routes/session";
import { createAnonymousToken, hashAnonymousToken } from "../security/anonymous-token";
import { hashDailyIp } from "../security/client-ip";

const COOKIE_NAME = "anon_session";

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

    const clientIp = context.req.header("CF-Connecting-IP");
    if (!clientIp) return context.json(invalidRequest("缺少可信的客户端地址"), 403);

    const { quotaDate, resetAt } = getShanghaiQuotaWindow(new Date());
    let ipHash: Uint8Array;
    try {
      ipHash = await hashDailyIp(clientIp, quotaDate, config.ipHashSecret);
    } catch {
      return context.json(invalidRequest("客户端地址无效"), 403);
    }

    const currentToken = getCookie(context, COOKIE_NAME);
    const currentClient = currentToken
      ? (await sql<{ id: string; status: "active" | "disabled" }[]>`
          select id, status
          from anonymous_clients
          where token_hash = ${await hashAnonymousToken(currentToken, config.anonTokenSecret)}
        `)[0]
      : undefined;

    if (currentClient?.status === "disabled") {
      return context.json(invalidRequest("此匿名客户端已被禁用"), 403);
    }

    let clientId = currentClient?.id;
    if (clientId) {
      await sql`update anonymous_clients set last_seen_at = now() where id = ${clientId}`;
    } else {
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
    }

    context.set("clientId", clientId);
    context.set("ipHash", ipHash);
    context.set("quotaDate", quotaDate);
    context.set("resetAt", resetAt);
    await next();
  };
}
