import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { taroStorage } from "@/services/taro-storage";
import { clearStoredFiles, deleteStoredFile } from "@/services/file-storage";

export type Generation = {
  id: string;
  mode: "text" | "edit";
  prompt: string;
  size: string;
  quality: string;
  taskId?: string;
  resultPaths: string[];
  status: "pending" | "success" | "failed";
  error?: string;
  createdAt: number;
};

type GenerationState = {
  generations: Generation[];
  addGeneration: (generation: Generation) => void;
  updateGeneration: (id: string, patch: Partial<Generation>) => void;
  deleteGeneration: (id: string) => void;
  clearAll: () => void;
};

function deleteGenerationFiles(generation: Generation) {
  generation.resultPaths.forEach(deleteStoredFile);
}

export const useGenerationStore = create<GenerationState>()(
  persist(
    (set, get) => ({
      generations: [],

      addGeneration: (generation) =>
        set((state) => ({ generations: [generation, ...state.generations] })),

      updateGeneration: (id, patch) =>
        set((state) => ({
          generations: state.generations.map((generation) =>
            generation.id === id ? { ...generation, ...patch } : generation,
          ),
        })),

      deleteGeneration: (id) => {
        const target = get().generations.find((generation) => generation.id === id);
        if (target) deleteGenerationFiles(target);
        set((state) => ({
          generations: state.generations.filter((generation) => generation.id !== id),
        }));
      },

      clearAll: () => {
        clearStoredFiles();
        set({ generations: [] });
      },
    }),
    {
      name: "miniapp:generations",
      storage: createJSONStorage(() => taroStorage),
    },
  ),
);
