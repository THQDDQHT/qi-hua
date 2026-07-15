export type QuotaSnapshot = {
    limit: number;
    used: number;
    reserved: number;
    remaining: number;
    resetAt: string;
};

export type PublicSession = {
    mode: "public";
    quota: QuotaSnapshot;
    generation: {
        enabled?: boolean;
        disabledReason?: string;
        modelLabel: string;
        maxPromptLength: number;
        maxReferenceImages: number;
    };
};

export type PublicApiIssue = {
    code?: string;
    message: string;
    status?: number;
    retryable: boolean;
};

export class PublicApiError extends Error {
    issue: PublicApiIssue;

    constructor(issue: PublicApiIssue) {
        super(issue.message);
        this.name = "PublicApiError";
        this.issue = issue;
    }
}

export type PublicSessionClient = {
    loadSession(signal?: AbortSignal): Promise<PublicSession>;
    loadQuota(signal?: AbortSignal): Promise<QuotaSnapshot>;
};

type PublicErrorBody = { errorCode?: string; error?: { code?: string; message?: string } | string; message?: string };

export async function readPublicApiError(response: Response, fallback = "公众服务请求失败") {
    let body: PublicErrorBody | null = null;
    try {
        body = (await response.clone().json()) as PublicErrorBody;
    } catch {
        body = null;
    }
    const nestedError = body?.error && typeof body.error === "object" ? body.error : null;
    const code = body?.errorCode || nestedError?.code;
    const message = nestedError?.message || (typeof body?.error === "string" ? body.error : undefined) || body?.message || `${fallback}：${response.status}`;
    return new PublicApiError({ code, message, status: response.status, retryable: response.status >= 500 || response.status === 408 || response.status === 429 });
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(path, { credentials: "same-origin", signal });
    if (!response.ok) throw await readPublicApiError(response, "公众会话请求失败");
    return (await response.json()) as T;
}

export const publicSessionClient: PublicSessionClient = {
    loadSession: (signal) => getJson<PublicSession>("/api/session", signal),
    loadQuota: (signal) => getJson<QuotaSnapshot>("/api/quota", signal),
};
