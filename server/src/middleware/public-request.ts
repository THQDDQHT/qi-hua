import type { MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createHmac } from "node:crypto";
import type { Sql } from "postgres";
import type { ServerConfig } from "../config";
import { createAnonymousToken, hashAnonymousToken } from "../security/anonymous-token";
import { getShanghaiQuotaWindow } from "../services/quota-snapshot";
import { hashDailyIp } from "../security/client-ip";

const COOKIE_NAME = "anon_session";
const MINIAPP_TOKEN_HEADER = "X-Miniapp-Token";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type PublicRequestEnv = {
  Variables: {
    config: ServerConfig;
    clientId: string;
    ipHash: Uint8Array;
    quotaDate: string;
    resetAt: string;
    miniappToken?: string;
  };
};

type Dependencies = { config: ServerConfig; sql: Sql };

function invalidRequest(message: string) {
  return { error: { code: "INVALID_REQUEST" as const, message } };
}

export function requirePublicRequest({ config, sql }: Dependencies): MiddlewareHandler<PublicRequestEnv> {
  return async (context, next) => {
    // 小程序请求：无浏览器 Origin/cookie/CF-Connecting-IP 概念，用请求头携带匿名 token，
    // 只做设备维度限额（微信出口 IP 集中，IP 限额不适用）。
    const miniappToken = context.req.header(MINIAPP_TOKEN_HEADER);
    const isMiniappSessionCreate = context.req.method === "POST" && context.req.path === "/api/miniapp/session";
    const viaMiniapp = miniappToken !== undefined || isMiniappSessionCreate;

    if (!viaMiniapp && !["GET", "HEAD", "OPTIONS"].includes(context.req.method)) {
      if (context.req.header("Origin") !== config.publicOrigin) {
        return context.json(invalidRequest("请求来源不受信任"), 403);
      }
    }

    const cookieToken = viaMiniapp ? undefined : getCookie(context, COOKIE_NAME);
    const currentToken = miniappToken ?? cookieToken;
    const canCreateClient = (context.req.method === "GET" && context.req.path === "/api/session") || isMiniappSessionCreate;
    if (currentToken === undefined && !canCreateClient) {
      return context.json(invalidRequest("请先建立匿名会话"), 401);
    }
    if (currentToken !== undefined && !TOKEN_PATTERN.test(currentToken)) {
      return context.json(invalidRequest("匿名会话凭证无效"), 403);
    }

    const { quotaDate, resetAt } = getShanghaiQuotaWindow(new Date());
    let ipHash: Uint8Array | undefined;
    if (!viaMiniapp) {
      const clientIp = context.req.header("CF-Connecting-IP");
      if (!clientIp) return context.json(invalidRequest("缺少可信的客户端地址"), 403);
      try {
        ipHash = await hashDailyIp(clientIp, quotaDate, config.ipHashSecret);
      } catch {
        return context.json(invalidRequest("客户端地址无效"), 403);
      }
    }

    let clientId: string;
    if (currentToken === undefined) {
      const token = createAnonymousToken();
      clientId = crypto.randomUUID();
      await sql`
        insert into anonymous_clients (id, token_hash, status)
        values (${clientId}, ${await hashAnonymousToken(token, config.anonTokenSecret)}, 'active')
      `;
      if (viaMiniapp) {
        context.set("miniappToken", token);
      } else {
        setCookie(context, COOKIE_NAME, token, {
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
          maxAge: 31536000,
          path: "/",
        });
      }
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

    // 小程序请求的 ipHash 按设备派生，让 IP 限额退化为每设备独立桶，实际由设备限额约束。
    ipHash ??= createHmac("sha256", config.ipHashSecret)
      .update(`${quotaDate}\nminiapp:${clientId}`)
      .digest();

    context.set("clientId", clientId);
    context.set("ipHash", ipHash);
    context.set("quotaDate", quotaDate);
    context.set("resetAt", resetAt);
    await next();
  };
}
