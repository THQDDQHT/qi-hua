import type { Sql, TransactionSql } from "postgres";
import {
  SETTLEMENT_ERROR_CODES,
  type RequestStatus,
  type SettlementErrorCode,
} from "../domain/public-generation";
import { readCurrentDeviceQuota, type QuotaCounts } from "../services/quota-snapshot";

export type QuotaLimits = {
  deviceLimit: number;
  ipLimit: number;
};

export type ReserveQuotaRecord = {
  clientId: string;
  requestKey: string;
  payloadFingerprint: Uint8Array;
  ipHash: Uint8Array;
  quotaDate: string;
  requestedCount: number;
  expiresAt: Date;
};

export type ReservationRecord =
  | { kind: "reserved"; requestId: string; status: "reserved" }
  | { kind: "replay"; requestId: string; status: RequestStatus };

export type ClaimRecord =
  | { kind: "claimed"; requestId: string; status: "running" }
  | {
      kind: "not-claimed";
      requestId: string;
      status: "running" | "completed" | "partial" | "failed" | "expired";
    };

export type SettleQuotaRecord = {
  requestId: string;
  successCount: number;
  errorCode?: SettlementErrorCode;
  now: Date;
  currentQuotaDate: string;
};

export type SettlementRecord =
  | {
      kind: "settled";
      status: "completed" | "partial" | "failed";
      counts: QuotaCounts;
    }
  | {
      kind: "already-settled";
      status: "completed" | "partial" | "failed";
      counts: QuotaCounts;
    }
  | { kind: "expired"; status: "expired"; counts: QuotaCounts };

export interface QuotaRepository {
  reserveQuota(input: ReserveQuotaRecord, limits: QuotaLimits): Promise<ReservationRecord>;
  claimForExecution(input: { requestId: string; now: Date }): Promise<ClaimRecord>;
  settleQuota(input: SettleQuotaRecord): Promise<SettlementRecord>;
  findExpiredCandidates(input: {
    now: Date;
    limit: number;
  }): Promise<Array<{ requestId: string }>>;
  expireById(input: { requestId: string; now: Date }): Promise<"expired" | "skipped">;
}

export type QuotaRepositoryErrorCode =
  | "DEVICE_QUOTA"
  | "IP_QUOTA"
  | "IDEMPOTENCY_CONFLICT"
  | "INVALID_INPUT"
  | "INCONSISTENT";

export class QuotaRepositoryError extends Error {
  constructor(readonly code: QuotaRepositoryErrorCode, readonly requestId?: string) {
    super(code);
    this.name = "QuotaRepositoryError";
  }
}

type LockedRequest = {
  id: string;
  clientId: string;
  ipHash: Uint8Array;
  quotaDate: string;
  requestedCount: number;
  reservedCount: number;
  status: RequestStatus;
};

function validRequestedCount(value: number) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 4;
}

function validLimit(value: number) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 32767;
}

function sameBytes(first: Uint8Array, second: Uint8Array) {
  return first.byteLength === second.byteLength
    && first.every((value, index) => value === second[index]);
}

function isSettlementErrorCode(value: unknown): value is SettlementErrorCode {
  return typeof value === "string"
    && SETTLEMENT_ERROR_CODES.includes(value as SettlementErrorCode);
}

async function lockQuotaRows(transaction: TransactionSql, request: LockedRequest) {
  const [clientQuota] = await transaction<QuotaCounts[]>`
    select success_count as "successCount", reserved_count as "reservedCount"
    from daily_client_quotas
    where client_id = ${request.clientId} and quota_date = ${request.quotaDate}
    for update
  `;
  if (!clientQuota) throw new QuotaRepositoryError("INCONSISTENT", request.id);

  const [ipQuota] = await transaction<QuotaCounts[]>`
    select success_count as "successCount", reserved_count as "reservedCount"
    from daily_ip_quotas
    where ip_hash = ${request.ipHash} and quota_date = ${request.quotaDate}
    for update
  `;
  if (!ipQuota) throw new QuotaRepositoryError("INCONSISTENT", request.id);

  return { clientQuota, ipQuota };
}

async function expireLockedRequest(
  transaction: TransactionSql,
  request: LockedRequest,
  now: Date,
) {
  const { clientQuota, ipQuota } = await lockQuotaRows(transaction, request);
  if (
    clientQuota.reservedCount < request.reservedCount
    || ipQuota.reservedCount < request.reservedCount
  ) {
    throw new QuotaRepositoryError("INCONSISTENT", request.id);
  }

  const clientUpdated = await transaction`
    update daily_client_quotas
    set reserved_count = reserved_count - ${request.reservedCount}, updated_at = ${now}
    where client_id = ${request.clientId} and quota_date = ${request.quotaDate}
      and reserved_count >= ${request.reservedCount}
    returning client_id
  `;
  const ipUpdated = await transaction`
    update daily_ip_quotas
    set reserved_count = reserved_count - ${request.reservedCount}, updated_at = ${now}
    where ip_hash = ${request.ipHash} and quota_date = ${request.quotaDate}
      and reserved_count >= ${request.reservedCount}
    returning ip_hash
  `;
  const requestUpdated = await transaction`
    update generation_requests
    set reserved_count = 0, status = 'expired', error_code = null, completed_at = ${now}
    where id = ${request.id} and status = ${request.status}
    returning id
  `;
  if (clientUpdated.length !== 1 || ipUpdated.length !== 1 || requestUpdated.length !== 1) {
    throw new QuotaRepositoryError("INCONSISTENT", request.id);
  }
}

export function createQuotaRepository(sql: Sql): QuotaRepository {
  async function reserveQuota(
    input: ReserveQuotaRecord,
    limits: QuotaLimits,
  ): Promise<ReservationRecord> {
    if (
      !validRequestedCount(input.requestedCount)
      || input.payloadFingerprint.byteLength !== 32
      || !validLimit(limits.deviceLimit)
      || !validLimit(limits.ipLimit)
    ) {
      throw new QuotaRepositoryError("INVALID_INPUT");
    }

    return sql.begin(async (transaction) => {
      const requestId = crypto.randomUUID();
      const inserted = await transaction<{ id: string }[]>`
        insert into generation_requests (
          id, client_id, request_key, payload_fingerprint, ip_hash, quota_date,
          requested_count, reserved_count, status, expires_at
        ) values (
          ${requestId}, ${input.clientId}, ${input.requestKey}, ${input.payloadFingerprint},
          ${input.ipHash}, ${input.quotaDate}, ${input.requestedCount},
          ${input.requestedCount}, 'reserved', ${input.expiresAt}
        )
        on conflict (client_id, request_key) do nothing
        returning id
      `;
      const [request] = await transaction<{
        id: string;
        status: RequestStatus;
        requestedCount: number;
        payloadFingerprint: Uint8Array;
      }[]>`
        select id, status, requested_count as "requestedCount",
          payload_fingerprint as "payloadFingerprint"
        from generation_requests
        where client_id = ${input.clientId} and request_key = ${input.requestKey}
        for update
      `;
      if (!request) throw new QuotaRepositoryError("INCONSISTENT");

      if (inserted.length === 0) {
        if (
          request.requestedCount !== input.requestedCount
          || !sameBytes(request.payloadFingerprint, input.payloadFingerprint)
        ) {
          throw new QuotaRepositoryError("IDEMPOTENCY_CONFLICT", request.id);
        }
        return { kind: "replay", requestId: request.id, status: request.status };
      }

      await transaction`
        insert into daily_client_quotas (client_id, quota_date)
        values (${input.clientId}, ${input.quotaDate})
        on conflict do nothing
      `;
      const [clientQuota] = await transaction<QuotaCounts[]>`
        select success_count as "successCount", reserved_count as "reservedCount"
        from daily_client_quotas
        where client_id = ${input.clientId} and quota_date = ${input.quotaDate}
        for update
      `;
      if (!clientQuota) throw new QuotaRepositoryError("INCONSISTENT", request.id);

      await transaction`
        insert into daily_ip_quotas (ip_hash, quota_date)
        values (${input.ipHash}, ${input.quotaDate})
        on conflict do nothing
      `;
      const [ipQuota] = await transaction<QuotaCounts[]>`
        select success_count as "successCount", reserved_count as "reservedCount"
        from daily_ip_quotas
        where ip_hash = ${input.ipHash} and quota_date = ${input.quotaDate}
        for update
      `;
      if (!ipQuota) throw new QuotaRepositoryError("INCONSISTENT", request.id);

      if (
        clientQuota.successCount + clientQuota.reservedCount + input.requestedCount
        > limits.deviceLimit
      ) {
        throw new QuotaRepositoryError("DEVICE_QUOTA", request.id);
      }
      if (
        ipQuota.successCount + ipQuota.reservedCount + input.requestedCount
        > limits.ipLimit
      ) {
        throw new QuotaRepositoryError("IP_QUOTA", request.id);
      }

      const clientUpdated = await transaction`
        update daily_client_quotas
        set reserved_count = reserved_count + ${input.requestedCount}, updated_at = now()
        where client_id = ${input.clientId} and quota_date = ${input.quotaDate}
        returning client_id
      `;
      const ipUpdated = await transaction`
        update daily_ip_quotas
        set reserved_count = reserved_count + ${input.requestedCount}, updated_at = now()
        where ip_hash = ${input.ipHash} and quota_date = ${input.quotaDate}
        returning ip_hash
      `;
      if (clientUpdated.length !== 1 || ipUpdated.length !== 1) {
        throw new QuotaRepositoryError("INCONSISTENT", request.id);
      }

      return { kind: "reserved", requestId: request.id, status: "reserved" };
    });
  }

  async function claimForExecution(input: {
    requestId: string;
    now: Date;
  }): Promise<ClaimRecord> {
    return sql.begin(async (transaction) => {
      const [request] = await transaction<(LockedRequest & { isExpired: boolean })[]>`
        select id, client_id as "clientId", ip_hash as "ipHash", quota_date::text as "quotaDate",
          requested_count as "requestedCount", reserved_count as "reservedCount", status,
          expires_at <= ${input.now} as "isExpired"
        from generation_requests where id = ${input.requestId}
        for update
      `;
      if (!request) throw new QuotaRepositoryError("INCONSISTENT", input.requestId);

      if (request.status !== "reserved") {
        return {
          kind: "not-claimed",
          requestId: request.id,
          status: request.status,
        } as ClaimRecord;
      }

      if (request.isExpired) {
        await expireLockedRequest(transaction, request, input.now);
        return { kind: "not-claimed", requestId: request.id, status: "expired" };
      }

      const updated = await transaction`
        update generation_requests
        set status = 'running'
        where id = ${request.id} and status = 'reserved'
        returning id
      `;
      if (updated.length !== 1) throw new QuotaRepositoryError("INCONSISTENT", request.id);
      return { kind: "claimed", requestId: request.id, status: "running" };
    });
  }

  async function settleQuota(input: SettleQuotaRecord): Promise<SettlementRecord> {
    return sql.begin(async (transaction) => {
      const [request] = await transaction<LockedRequest[]>`
        select id, client_id as "clientId", ip_hash as "ipHash", quota_date::text as "quotaDate",
          requested_count as "requestedCount", reserved_count as "reservedCount", status
        from generation_requests where id = ${input.requestId}
        for update
      `;
      if (!request) throw new QuotaRepositoryError("INCONSISTENT", input.requestId);

      if (["completed", "partial", "failed"].includes(request.status)) {
        return {
          kind: "already-settled",
          status: request.status,
          counts: await readCurrentDeviceQuota(
            transaction,
            request.clientId,
            input.currentQuotaDate,
          ),
        } as SettlementRecord;
      }
      if (request.status === "expired") {
        return {
          kind: "expired",
          status: "expired",
          counts: await readCurrentDeviceQuota(
            transaction,
            request.clientId,
            input.currentQuotaDate,
          ),
        };
      }
      if (request.status !== "running") {
        throw new QuotaRepositoryError("INCONSISTENT", request.id);
      }

      if (
        !Number.isSafeInteger(input.successCount)
        || input.successCount < 0
        || input.successCount > request.reservedCount
        || (input.errorCode !== undefined && !isSettlementErrorCode(input.errorCode))
      ) {
        throw new QuotaRepositoryError("INVALID_INPUT", request.id);
      }

      const { clientQuota, ipQuota } = await lockQuotaRows(transaction, request);
      if (
        clientQuota.reservedCount < request.reservedCount
        || ipQuota.reservedCount < request.reservedCount
      ) {
        throw new QuotaRepositoryError("INCONSISTENT", request.id);
      }

      const clientUpdated = await transaction`
        update daily_client_quotas
        set success_count = success_count + ${input.successCount},
          reserved_count = reserved_count - ${request.reservedCount}, updated_at = ${input.now}
        where client_id = ${request.clientId} and quota_date = ${request.quotaDate}
          and reserved_count >= ${request.reservedCount}
        returning client_id
      `;
      const ipUpdated = await transaction`
        update daily_ip_quotas
        set success_count = success_count + ${input.successCount},
          reserved_count = reserved_count - ${request.reservedCount}, updated_at = ${input.now}
        where ip_hash = ${request.ipHash} and quota_date = ${request.quotaDate}
          and reserved_count >= ${request.reservedCount}
        returning ip_hash
      `;
      const status = input.successCount === request.requestedCount
        ? "completed"
        : input.successCount === 0 ? "failed" : "partial";
      const requestUpdated = await transaction`
        update generation_requests
        set reserved_count = 0, success_count = ${input.successCount}, status = ${status},
          error_code = ${status === "completed" ? null : input.errorCode ?? null},
          completed_at = ${input.now}
        where id = ${request.id} and status = 'running'
        returning id
      `;
      if (clientUpdated.length !== 1 || ipUpdated.length !== 1 || requestUpdated.length !== 1) {
        throw new QuotaRepositoryError("INCONSISTENT", request.id);
      }

      return {
        kind: "settled",
        status,
        counts: await readCurrentDeviceQuota(
          transaction,
          request.clientId,
          input.currentQuotaDate,
        ),
      };
    });
  }

  async function findExpiredCandidates(input: {
    now: Date;
    limit: number;
  }): Promise<Array<{ requestId: string }>> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new QuotaRepositoryError("INVALID_INPUT");
    }
    return sql<{ requestId: string }[]>`
      select id as "requestId"
      from generation_requests
      where status in ('reserved', 'running') and expires_at <= ${input.now}
      order by expires_at, id
      limit ${input.limit}
    `;
  }

  async function expireById(input: {
    requestId: string;
    now: Date;
  }): Promise<"expired" | "skipped"> {
    return sql.begin(async (transaction) => {
      const [request] = await transaction<(LockedRequest & { isExpired: boolean })[]>`
        select id, client_id as "clientId", ip_hash as "ipHash", quota_date::text as "quotaDate",
          requested_count as "requestedCount", reserved_count as "reservedCount", status,
          expires_at <= ${input.now} as "isExpired"
        from generation_requests where id = ${input.requestId}
        for update
      `;
      if (!request || !["reserved", "running"].includes(request.status) || !request.isExpired) {
        return "skipped";
      }

      await expireLockedRequest(transaction, request, input.now);
      return "expired";
    });
  }

  return {
    reserveQuota,
    claimForExecution,
    settleQuota,
    findExpiredCandidates,
    expireById,
  };
}
