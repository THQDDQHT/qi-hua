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
        modelLabel: string;
        counts: number[];
        sizes: string[];
        qualities: string[];
        maxPromptLength: number;
        maxReferenceImages: number;
    };
};

export type PublicSessionClient = {
    loadSession(signal?: AbortSignal): Promise<PublicSession>;
    loadQuota(signal?: AbortSignal): Promise<QuotaSnapshot>;
};

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(path, { credentials: "same-origin", signal });
    if (!response.ok) throw new Error(`公众会话请求失败：${response.status}`);
    return (await response.json()) as T;
}

export const publicSessionClient: PublicSessionClient = {
    loadSession: (signal) => getJson<PublicSession>("/api/session", signal),
    loadQuota: (signal) => getJson<QuotaSnapshot>("/api/quota", signal),
};
