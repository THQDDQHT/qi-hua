import { create } from "zustand";

import { appMode } from "@/lib/app-mode";
import { PublicApiError, publicSessionClient, type PublicApiIssue, type PublicSession, type PublicSessionClient, type QuotaSnapshot } from "@/services/public-session";

export type PublicSessionStatus = "idle" | "loading" | "ready" | "unavailable";

type PublicSessionState = {
    status: PublicSessionStatus;
    session: PublicSession | null;
    quota: QuotaSnapshot | null;
    error: string | null;
    issue: PublicApiIssue | null;
};

type PublicSessionStore = PublicSessionState & {
    initialize(): Promise<PublicSession | null>;
    refreshQuota(): Promise<QuotaSnapshot | null>;
    applyQuota(quota: QuotaSnapshot): void;
};

const initialState: PublicSessionState = { status: "idle", session: null, quota: null, error: null, issue: null };

export function createPublicSessionStore(client: PublicSessionClient = publicSessionClient) {
    let initialization: Promise<PublicSession | null> | null = null;

    return create<PublicSessionStore>((set) => ({
        ...initialState,
        initialize: () => {
            if (initialization) return initialization;
            initialization = client
                .loadSession()
                .then((session) => {
                    set({ status: "ready", session, quota: session.quota, error: null, issue: null });
                    return session;
                })
                .catch((error: unknown) => {
                    const issue = publicIssue(error, "无法初始化公众会话");
                    set({ status: "unavailable", session: null, quota: null, error: issue.message, issue });
                    return null;
                })
                .finally(() => {
                    initialization = null;
                });
            set({ status: "loading", error: null, issue: null });
            return initialization;
        },
        refreshQuota: async () => {
            try {
                const quota = await client.loadQuota();
                set((state) => ({ quota, session: state.session ? { ...state.session, quota } : state.session, error: null, issue: null }));
                return quota;
            } catch (error) {
                const issue = publicIssue(error, "无法刷新公众额度");
                set({ error: issue.message, issue });
                return null;
            }
        },
        applyQuota: (quota) => set((state) => ({ quota, session: state.session ? { ...state.session, quota } : state.session })),
    }));
}

function publicIssue(error: unknown, fallback: string): PublicApiIssue {
    if (error instanceof PublicApiError) return error.issue;
    return { message: error instanceof Error ? error.message : fallback, retryable: true };
}

export const usePublicSessionStore = createPublicSessionStore();

export function initializePublicSession() {
    return appMode === "public" ? usePublicSessionStore.getState().initialize() : Promise.resolve(null);
}
