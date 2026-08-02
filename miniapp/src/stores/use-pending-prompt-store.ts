import { create } from "zustand";

// 提示词库「使用」→ 工作台填入 的跨页传递（不持久化）。
type PendingPromptState = {
  pendingPrompt: string | null;
  setPendingPrompt: (prompt: string) => void;
  consumePendingPrompt: () => string | null;
};

export const usePendingPromptStore = create<PendingPromptState>((set, get) => ({
  pendingPrompt: null,
  setPendingPrompt: (prompt) => set({ pendingPrompt: prompt }),
  consumePendingPrompt: () => {
    const prompt = get().pendingPrompt;
    if (prompt !== null) set({ pendingPrompt: null });
    return prompt;
  },
}));
