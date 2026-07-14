import { create } from "zustand";

import { appMode } from "@/lib/app-mode";
import { publicSessionClient, type PublicSession, type PublicSessionClient, type QuotaSnapshot } from "@/services/public-session";

export type PublicSessionStatus = "idle" | "loading" | "ready" | "unavailable";

type PublicSessionState = {
    status: PublicSessionStatus;
    session: PublicSession | null;
    quota: QuotaSnapshot | null;
    error: string | null;
};

type PublicSessionStore = PublicSessionState & {
    initialize(): Promise<PublicSession | null>;
    refreshQuota(): Promise<QuotaSnapshot | null>;
    applyQuota(quota: QuotaSnapshot): void;
};

const initialState: PublicSessionState = { status: "idle", session: null, quota: null, error: null };

export function createPublicSessionStore(client: PublicSessionClient = publicSessionClient) {
    let initialization: Promise<PublicSession | null> | null = null;

    return create<PublicSessionStore>((set) => ({
        ...initialState,
        initialize: () => {
            if (initialization) return initialization;
            initialization = client
                .loadSession()
                .then((session) => {
                    set({ status: "ready", session, quota: session.quota, error: null });
                    return session;
                })
                .catch((error: unknown) => {
                    set({ status: "unavailable", session: null, quota: null, error: error instanceof Error ? error.message : "无法初始化公众会话" });
                    return null;
                })
                .finally(() => {
                    initialization = null;
                });
            set({ status: "loading", error: null });
            return initialization;
        },
        refreshQuota: async () => {
            try {
                const quota = await client.loadQuota();
                set((state) => ({ quota, session: state.session ? { ...state.session, quota } : state.session, error: null }));
                return quota;
            } catch (error) {
                set({ error: error instanceof Error ? error.message : "无法刷新公众额度" });
                return null;
            }
        },
        applyQuota: (quota) => set((state) => ({ quota, session: state.session ? { ...state.session, quota } : state.session })),
    }));
}

export const usePublicSessionStore = createPublicSessionStore();

export function initializePublicSession() {
    return appMode === "public" ? usePublicSessionStore.getState().initialize() : Promise.resolve(null);
}
