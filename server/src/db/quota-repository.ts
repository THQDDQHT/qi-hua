import type { Sql, TransactionSql } from "postgres";
import {
  type GenerationReferenceManifest,
  type GenerationResultManifestItem,
  SETTLEMENT_ERROR_CODES,
  selectSettlementErrorCode,
  type RequestStatus,
  type SettlementErrorCode,
} from "../domain/public-generation";
import { readCurrentDeviceQuota, type QuotaCounts } from "../services/quota-snapshot";

export type QuotaLimits = {
  deviceLimit: number;
  ipLimit: number;
};

export type ReserveQuotaRecord = {
  requestId?: string;
  clientId: string;
  requestKey: string;
  payloadFingerprint: Uint8Array;
  ipHash: Uint8Array;
  quotaDate: string;
  requestedCount: number;
  expiresAt: Date;
  task?: {
    operation: "generation" | "edit";
    prompt: string;
    size: string;
    quality: string;
    referenceManifest?: GenerationReferenceManifest;
  };
};

export type ReservationRecord =
  | { kind: "reserved"; requestId: string; status: "reserved"; expiresAt: Date }
  | { kind: "replay"; requestId: string; status: RequestStatus; expiresAt: Date };

export type StoredGenerationTask = {
  requestId: string;
  clientId: string;
  status: RequestStatus;
  requestedCount: number;
  resultManifest?: GenerationResultManifestItem[];
  expiresAt: Date;
  resultExpiresAt?: Date;
  artifactsDeletedAt?: Date;
};

export type StoredActiveGenerationTask = StoredGenerationTask & {
  operation: "generation" | "edit";
  prompt: string;
  size: string;
  quality: string;
  referenceManifest?: GenerationReferenceManifest;
};

export type ExecutionClaim =
  | { kind: "claimed"; task: StoredActiveGenerationTask; executionId: string }
  | { kind: "busy" | "terminal" | "expired" };

export type ExecutionSettlement =
  | { kind: "settled"; status: "completed" | "partial" | "failed" }
  | { kind: "stale" | "already-settled" };

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

export interface GenerationTaskRepository {
  requestExists(requestId: string): Promise<boolean>;
  findTaskForClient(input: { requestId: string; clientId: string }): Promise<StoredGenerationTask | undefined>;
  findDispatchCandidates(input: { now: Date; limit: number }): Promise<Array<{ requestId: string }>>;
  claimTaskExecution(input: {
    requestId: string;
    executionId: string;
    now: Date;
    leaseUntil: Date;
  }): Promise<ExecutionClaim>;
  heartbeatTaskExecution(input: {
    requestId: string;
    executionId: string;
    now: Date;
    leaseUntil: Date;
  }): Promise<boolean>;
  abandonTaskExecution(input: {
    requestId: string;
    executionId: string;
    now: Date;
  }): Promise<void>;
  settleTaskExecution(input: {
    requestId: string;
    executionId: string;
    results: GenerationResultManifestItem[];
    now: Date;
    resultExpiresAt: Date;
  }): Promise<ExecutionSettlement>;
  findArtifactCleanupCandidates(input: { now: Date; limit: number }): Promise<Array<{ requestId: string }>>;
  markArtifactsDeleted(input: { requestId: string; now: Date }): Promise<void>;
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

type StoredTaskRow = {
  requestId: string;
  clientId: string;
  status: RequestStatus;
  operation: "generation" | "edit" | null;
  prompt: string | null;
  requestedCount: number;
  size: string | null;
  quality: string | null;
  referenceManifest: GenerationReferenceManifest | null;
  resultManifest: GenerationResultManifestItem[] | null;
  expiresAt: Date;
  resultExpiresAt: Date | null;
  artifactsDeletedAt: Date | null;
};

function storedTask(row: StoredTaskRow): StoredGenerationTask {
  return {
    requestId: row.requestId,
    clientId: row.clientId,
    status: row.status,
    requestedCount: row.requestedCount,
    ...(row.resultManifest ? { resultManifest: row.resultManifest } : {}),
    expiresAt: row.expiresAt,
    ...(row.resultExpiresAt ? { resultExpiresAt: row.resultExpiresAt } : {}),
    ...(row.artifactsDeletedAt ? { artifactsDeletedAt: row.artifactsDeletedAt } : {}),
  };
}

function activeTask(row: StoredTaskRow): StoredActiveGenerationTask | undefined {
  if (!row.operation || !row.prompt || !row.size || !row.quality) return undefined;
  return {
    ...storedTask(row),
    operation: row.operation,
    prompt: row.prompt,
    size: row.size,
    quality: row.quality,
    ...(row.referenceManifest ? { referenceManifest: row.referenceManifest } : {}),
  };
}

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
    set reserved_count = 0, status = 'expired', error_code = null, completed_at = ${now},
      execution_id = null, heartbeat_at = null, lease_expires_at = null,
      operation = null, prompt = null, size = null, quality = null, reference_manifest = null,
      result_expires_at = ${now}, updated_at = ${now}
    where id = ${request.id} and status = ${request.status}
    returning id
  `;
  if (clientUpdated.length !== 1 || ipUpdated.length !== 1 || requestUpdated.length !== 1) {
    throw new QuotaRepositoryError("INCONSISTENT", request.id);
  }
}

export function createQuotaRepository(sql: Sql): QuotaRepository & GenerationTaskRepository {
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
      const requestId = input.requestId ?? crypto.randomUUID();
      const inserted = await transaction<{ id: string }[]>`
        insert into generation_requests (
          id, client_id, request_key, payload_fingerprint, ip_hash, quota_date,
          requested_count, reserved_count, status, expires_at,
          operation, prompt, size, quality, reference_manifest
        ) values (
          ${requestId}, ${input.clientId}, ${input.requestKey}, ${input.payloadFingerprint},
          ${input.ipHash}, ${input.quotaDate}, ${input.requestedCount},
          ${input.requestedCount}, 'reserved', ${input.expiresAt},
          ${input.task?.operation ?? null}, ${input.task?.prompt ?? null},
          ${input.task?.size ?? null}, ${input.task?.quality ?? null},
          ${input.task?.referenceManifest ? transaction.json(input.task.referenceManifest) : null}
        )
        on conflict (client_id, request_key) do nothing
        returning id
      `;
      const [request] = await transaction<{
        id: string;
        status: RequestStatus;
        requestedCount: number;
        payloadFingerprint: Uint8Array;
        expiresAt: Date;
      }[]>`
        select id, status, requested_count as "requestedCount", expires_at as "expiresAt",
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
        return {
          kind: "replay",
          requestId: request.id,
          status: request.status,
          expiresAt: request.expiresAt,
        };
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

      return {
        kind: "reserved",
        requestId: request.id,
        status: "reserved",
        expiresAt: input.expiresAt,
      };
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
          completed_at = ${input.now}, operation = null, prompt = null, size = null,
          quality = null, reference_manifest = null, updated_at = ${input.now}
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
      where expires_at <= ${input.now}
        and (
          status = 'reserved'
          or (status = 'running' and coalesce(lease_expires_at, expires_at) <= ${input.now})
        )
      order by expires_at, id
      limit ${input.limit}
    `;
  }

  async function expireById(input: {
    requestId: string;
    now: Date;
  }): Promise<"expired" | "skipped"> {
    return sql.begin(async (transaction) => {
      const [request] = await transaction<(LockedRequest & { isExpired: boolean; leaseExpired: boolean })[]>`
        select id, client_id as "clientId", ip_hash as "ipHash", quota_date::text as "quotaDate",
          requested_count as "requestedCount", reserved_count as "reservedCount", status,
          expires_at <= ${input.now} as "isExpired",
          coalesce(lease_expires_at, expires_at) <= ${input.now} as "leaseExpired"
        from generation_requests where id = ${input.requestId}
        for update
      `;
      if (
        !request
        || !request.isExpired
        || (request.status !== "reserved" && !(request.status === "running" && request.leaseExpired))
      ) {
        return "skipped";
      }

      await expireLockedRequest(transaction, request, input.now);
      return "expired";
    });
  }

  async function findTaskForClient(input: {
    requestId: string;
    clientId: string;
  }): Promise<StoredGenerationTask | undefined> {
    const [row] = await sql<StoredTaskRow[]>`
      select id as "requestId", client_id as "clientId", status, operation, prompt,
        requested_count as "requestedCount", size, quality,
        reference_manifest as "referenceManifest", result_manifest as "resultManifest",
        expires_at as "expiresAt", result_expires_at as "resultExpiresAt",
        artifacts_deleted_at as "artifactsDeletedAt"
      from generation_requests
      where id = ${input.requestId} and client_id = ${input.clientId}
    `;
    return row ? storedTask(row) : undefined;
  }

  async function requestExists(requestId: string) {
    const [{ exists }] = await sql<{ exists: boolean }[]>`
      select exists(select 1 from generation_requests where id = ${requestId}) as exists
    `;
    return exists;
  }

  async function findDispatchCandidates(input: {
    now: Date;
    limit: number;
  }): Promise<Array<{ requestId: string }>> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      throw new QuotaRepositoryError("INVALID_INPUT");
    }
    return sql<{ requestId: string }[]>`
      select id as "requestId"
      from generation_requests
      where operation is not null
        and (
          (status = 'reserved' and expires_at > ${input.now})
          or (
            status = 'running' and expires_at > ${input.now}
            and lease_expires_at <= ${input.now}
          )
        )
      order by created_at, id
      limit ${input.limit}
    `;
  }

  async function claimTaskExecution(input: {
    requestId: string;
    executionId: string;
    now: Date;
    leaseUntil: Date;
  }): Promise<ExecutionClaim> {
    return sql.begin(async (transaction) => {
      const [row] = await transaction<(StoredTaskRow & LockedRequest & {
        isExpired: boolean;
        leaseExpired: boolean;
      })[]>`
        select id, id as "requestId", client_id as "clientId", ip_hash as "ipHash",
          quota_date::text as "quotaDate", requested_count as "requestedCount",
          reserved_count as "reservedCount", status, operation, prompt, size, quality,
          reference_manifest as "referenceManifest", result_manifest as "resultManifest",
          expires_at as "expiresAt", expires_at <= ${input.now} as "isExpired",
          coalesce(lease_expires_at <= ${input.now}, true) as "leaseExpired",
          result_expires_at as "resultExpiresAt",
          artifacts_deleted_at as "artifactsDeletedAt"
        from generation_requests where id = ${input.requestId}
        for update
      `;
      if (!row) return { kind: "terminal" };
      if (["completed", "partial", "failed", "expired"].includes(row.status)) {
        return { kind: "terminal" };
      }
      const task = activeTask(row);
      if (!task) return { kind: "terminal" };
      if (row.isExpired && (row.status === "reserved" || row.leaseExpired)) {
        await expireLockedRequest(transaction, row, input.now);
        return { kind: "expired" };
      }
      if (row.status === "running" && !row.leaseExpired) return { kind: "busy" };

      const [updated] = await transaction<{ attemptCount: number }[]>`
        update generation_requests
        set status = 'running', execution_id = ${input.executionId},
          attempt_count = attempt_count + 1, started_at = coalesce(started_at, ${input.now}),
          heartbeat_at = ${input.now}, lease_expires_at = ${input.leaseUntil}, updated_at = ${input.now}
        where id = ${input.requestId} and status in ('reserved', 'running')
        returning attempt_count as "attemptCount"
      `;
      if (!updated) throw new QuotaRepositoryError("INCONSISTENT", input.requestId);
      return {
        kind: "claimed",
        executionId: input.executionId,
        task: { ...task, status: "running" },
      };
    });
  }

  async function heartbeatTaskExecution(input: {
    requestId: string;
    executionId: string;
    now: Date;
    leaseUntil: Date;
  }) {
    const updated = await sql`
      update generation_requests
      set heartbeat_at = ${input.now}, lease_expires_at = ${input.leaseUntil}, updated_at = ${input.now}
      where id = ${input.requestId} and status = 'running'
        and execution_id = ${input.executionId}
      returning id
    `;
    return updated.length === 1;
  }

  async function abandonTaskExecution(input: {
    requestId: string;
    executionId: string;
    now: Date;
  }) {
    await sql`
      update generation_requests
      set lease_expires_at = ${input.now}, heartbeat_at = ${input.now}, updated_at = ${input.now}
      where id = ${input.requestId} and status = 'running'
        and execution_id = ${input.executionId}
    `;
  }

  async function settleTaskExecution(input: {
    requestId: string;
    executionId: string;
    results: GenerationResultManifestItem[];
    now: Date;
    resultExpiresAt: Date;
  }): Promise<ExecutionSettlement> {
    return sql.begin(async (transaction) => {
      const [request] = await transaction<LockedRequest[]>`
        select id, client_id as "clientId", ip_hash as "ipHash", quota_date::text as "quotaDate",
          requested_count as "requestedCount", reserved_count as "reservedCount", status
        from generation_requests where id = ${input.requestId}
        for update
      `;
      if (!request) return { kind: "stale" };
      if (["completed", "partial", "failed"].includes(request.status)) {
        return { kind: "already-settled" };
      }
      if (request.status !== "running") return { kind: "stale" };
      const [{ matchesExecution }] = await transaction<{ matchesExecution: boolean }[]>`
        select execution_id = ${input.executionId} as "matchesExecution"
        from generation_requests where id = ${input.requestId}
      `;
      if (!matchesExecution) return { kind: "stale" };

      const indexes = input.results.map(({ index }) => index);
      if (
        input.results.length !== request.requestedCount
        || new Set(indexes).size !== request.requestedCount
        || indexes.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= request.requestedCount)
      ) {
        throw new QuotaRepositoryError("INVALID_INPUT", request.id);
      }

      const successCount = input.results.filter(({ status }) => status === "success").length;
      const errorCode = selectSettlementErrorCode(input.results.flatMap((result) => (
        result.status === "failed" ? [result.errorCode] : []
      )));
      const { clientQuota, ipQuota } = await lockQuotaRows(transaction, request);
      if (
        clientQuota.reservedCount < request.reservedCount
        || ipQuota.reservedCount < request.reservedCount
      ) throw new QuotaRepositoryError("INCONSISTENT", request.id);

      const clientUpdated = await transaction`
        update daily_client_quotas
        set success_count = success_count + ${successCount},
          reserved_count = reserved_count - ${request.reservedCount}, updated_at = ${input.now}
        where client_id = ${request.clientId} and quota_date = ${request.quotaDate}
          and reserved_count >= ${request.reservedCount}
        returning client_id
      `;
      const ipUpdated = await transaction`
        update daily_ip_quotas
        set success_count = success_count + ${successCount},
          reserved_count = reserved_count - ${request.reservedCount}, updated_at = ${input.now}
        where ip_hash = ${request.ipHash} and quota_date = ${request.quotaDate}
          and reserved_count >= ${request.reservedCount}
        returning ip_hash
      `;
      if (clientUpdated.length !== 1 || ipUpdated.length !== 1) {
        throw new QuotaRepositoryError("INCONSISTENT", request.id);
      }
      const status = successCount === request.requestedCount
        ? "completed" : successCount === 0 ? "failed" : "partial";
      const updated = await transaction`
        update generation_requests
        set reserved_count = 0, success_count = ${successCount}, status = ${status},
          error_code = ${status === "completed" ? null : errorCode ?? "SERVICE_UNAVAILABLE"},
          result_manifest = ${transaction.json(input.results)}, execution_id = null,
          heartbeat_at = null, lease_expires_at = null, completed_at = ${input.now},
          result_expires_at = ${input.resultExpiresAt}, operation = null, prompt = null,
          size = null, quality = null, reference_manifest = null,
          updated_at = ${input.now}
        where id = ${request.id} and status = 'running'
          and execution_id = ${input.executionId}
        returning id
      `;
      if (updated.length !== 1) throw new QuotaRepositoryError("INCONSISTENT", request.id);
      return { kind: "settled", status };
    });
  }

  async function findArtifactCleanupCandidates(input: {
    now: Date;
    limit: number;
  }): Promise<Array<{ requestId: string }>> {
    return sql<{ requestId: string }[]>`
      select id as "requestId" from generation_requests
      where result_expires_at <= ${input.now} and artifacts_deleted_at is null
      order by result_expires_at, id limit ${input.limit}
    `;
  }

  async function markArtifactsDeleted(input: { requestId: string; now: Date }) {
    await sql`
      update generation_requests set artifacts_deleted_at = ${input.now}, updated_at = ${input.now}
      where id = ${input.requestId} and result_expires_at <= ${input.now}
        and artifacts_deleted_at is null
    `;
  }

  return {
    reserveQuota,
    claimForExecution,
    settleQuota,
    findExpiredCandidates,
    expireById,
    findTaskForClient,
    requestExists,
    findDispatchCandidates,
    claimTaskExecution,
    heartbeatTaskExecution,
    abandonTaskExecution,
    settleTaskExecution,
    findArtifactCleanupCandidates,
    markArtifactsDeleted,
  };
}
