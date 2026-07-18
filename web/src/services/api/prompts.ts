import localforage from "localforage";

import { appMode } from "@/lib/app-mode";

import { loadRemotePrompts, PROMPT_CATEGORIES, type Prompt } from "./prompt-sources";

export type { Prompt } from "./prompt-sources";

export const ALL_PROMPTS_OPTION = "全部";

const promptCategoryLabels: Record<string, string> = {
    "awesome-gpt-image": "综合生图精选",
    "awesome-gpt4o-image-prompts": "GPT-4o 生图精选",
    "youmind-gpt-image-2": "GPT Image 2 生图精选",
    "youmind-nano-banana-pro": "Nano Banana Pro 生图精选",
    "davidwu-gpt-image2-prompts": "GPT Image 2 社区精选",
};

export type PromptListResponse = {
    items: Prompt[];
    tags: string[];
    categories: string[];
    total: number;
};

type PromptSnapshot = {
    version: 1;
    generatedAt: string;
    items: Prompt[];
};

const cacheTtlMs = 1000 * 60 * 60;
const promptCacheKey = "third-party-prompts-v3";
const promptCacheStore = localforage.createInstance({ name: "infinite-canvas", storeName: "prompt_cache" });

let loadingPrompts: Promise<Prompt[]> | null = null;

export async function fetchPrompts({ keyword = "", tag = [], category = ALL_PROMPTS_OPTION, page = 1, pageSize = 20 }: { keyword?: string; tag?: string[]; category?: string; page?: number; pageSize?: number } = {}) {
    const items = await getPrompts();
    const normalizedKeyword = keyword.trim().toLowerCase();
    const normalizedPage = Math.max(1, page);
    const normalizedPageSize = Math.max(1, Math.min(100, pageSize));
    const withoutTagFilter = filterPrompts(items, { keyword: normalizedKeyword, category, tags: [] });
    const filtered = filterPrompts(items, { keyword: normalizedKeyword, category, tags: tag });

    return {
        items: filtered.slice((normalizedPage - 1) * normalizedPageSize, normalizedPage * normalizedPageSize),
        tags: collectTags(withoutTagFilter),
        categories: PROMPT_CATEGORIES.map((item) => item.category),
        total: filtered.length,
    };
}

async function getPrompts() {
    const cached = await promptCacheStore.getItem<{ items?: Prompt[]; fetchedAt?: number }>(promptCacheKey);
    if (cached?.items?.length && cached.fetchedAt && Date.now() - cached.fetchedAt < cacheTtlMs) return cached.items;
    if (loadingPrompts) return loadingPrompts;
    loadingPrompts = loadPrompts().finally(() => {
        loadingPrompts = null;
    });
    return loadingPrompts;
}

async function loadPrompts() {
    const items = appMode === "public" ? await loadPublicPromptSnapshot() : await loadRemotePrompts();
    await promptCacheStore.setItem(promptCacheKey, { items, fetchedAt: Date.now() });
    return items;
}

async function loadPublicPromptSnapshot() {
    const response = await fetch("/prompt-library/prompts.json", { cache: "no-store" });
    if (response.status === 404 && import.meta.env.DEV) return loadRemotePrompts();
    if (!response.ok) throw new Error(`提示词快照读取失败（${response.status}）`);
    const snapshot = (await response.json()) as PromptSnapshot | Prompt[];
    const items = Array.isArray(snapshot) ? snapshot : snapshot?.items;
    if (!Array.isArray(items) || !items.length) throw new Error("提示词快照内容为空或格式错误");
    return items;
}

function filterPrompts(items: Prompt[], options: { keyword: string; category: string; tags: string[] }) {
    return items.filter((item) => {
        if (isActiveOption(options.category) && item.category !== options.category) return false;
        if (options.tags.length && !options.tags.some((tag) => item.tags.includes(tag))) return false;
        if (!options.keyword) return true;
        return [item.title, item.prompt, item.category, ...item.tags].join(" ").toLowerCase().includes(options.keyword);
    });
}

function collectTags(items: Prompt[]) {
    return Array.from(new Set(items.flatMap((item) => item.tags).filter(Boolean)));
}

function isActiveOption(value: string) {
    return value && value !== "全部" && value !== "all";
}

export function formatPromptDate(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function formatPromptCategory(value: string) {
    return promptCategoryLabels[value] || value;
}
