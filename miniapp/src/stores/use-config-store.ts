import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { taroStorage } from "@/services/taro-storage";
import { DEFAULT_SERVER_BASE_URL } from "@/shared/config";
import * as api from "@/services/api";

type ConfigState = {
  serverBaseUrl: string;
  token: string | null;
  quota: api.Quota | null;
  generation: api.SessionGenerationInfo | null;
  sessionReady: boolean;
  initSession: () => Promise<void>;
  refreshQuota: () => Promise<void>;
  setQuota: (quota: api.Quota) => void;
};

let sessionInitPromise: Promise<void> | null = null;

export const useConfigStore = create<ConfigState>()(
  persist(
    (set, get) => ({
      serverBaseUrl: DEFAULT_SERVER_BASE_URL,
      token: null,
      quota: null,
      generation: null,
      sessionReady: false,

      initSession: () => {
        if (!get().serverBaseUrl || get().sessionReady) return Promise.resolve();
        if (sessionInitPromise) return sessionInitPromise;
        sessionInitPromise = api.createSession()
          .then((session) => {
            set({
              token: session.token,
              quota: session.quota,
              generation: session.generation,
              sessionReady: true,
            });
          })
          .catch(() => {
            set({ sessionReady: false });
          })
          .finally(() => {
            sessionInitPromise = null;
          });
        return sessionInitPromise;
      },

      refreshQuota: async () => {
        if (!get().serverBaseUrl) return;
        try {
          set({ quota: await api.fetchQuota() });
        } catch {
          // 静默失败，保留旧配额展示
        }
      },

      setQuota: (quota) => set({ quota }),
    }),
    {
      name: "miniapp:config",
      storage: createJSONStorage(() => taroStorage),
      // 服务地址以代码里的 DEFAULT_SERVER_BASE_URL 为准，只持久化匿名会话 token。
      partialize: (state) => ({ token: state.token }),
    },
  ),
);
