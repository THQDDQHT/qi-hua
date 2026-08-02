import Taro from "@tarojs/taro";
import { ApiError } from "@/services/api";
import { useConfigStore } from "@/stores/use-config-store";

export type PromptItem = {
  id: string;
  title: string;
  coverUrl: string;
  prompt: string;
  tags: string[];
  category: string;
};

type PromptCache = { fetchedAt: number; items: PromptItem[] };

const CACHE_KEY = "miniapp:prompt_cache";
const CACHE_TTL_MS = 60 * 60 * 1000;

function baseUrl(): string {
  const { serverBaseUrl } = useConfigStore.getState();
  if (!serverBaseUrl) throw new ApiError("NO_SERVER", "请先在「设置」页配置服务地址");
  return serverBaseUrl.replace(/\/+$/, "");
}

/** coverUrl 在 prompts.json 里是相对路径，拼接服务地址后供 <image> 远程加载。 */
export function promptCoverUrl(coverUrl: string): string {
  return coverUrl.startsWith("http") ? coverUrl : `${baseUrl()}${coverUrl}`;
}

export async function loadPromptLibrary(force = false): Promise<PromptItem[]> {
  if (!force) {
    try {
      const cached = Taro.getStorageSync(CACHE_KEY) as PromptCache | "";
      if (cached && typeof cached === "object" && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return cached.items;
      }
    } catch {
      // 缓存损坏则重新拉取
    }
  }

  const response = await Taro.request({
    url: `${baseUrl()}/prompt-library/prompts.json`,
    timeout: 30000,
  }).catch(() => {
    throw new ApiError("NETWORK", "网络请求失败，请检查服务地址和网络");
  });
  if (response.statusCode !== 200) {
    throw new ApiError(`HTTP_${response.statusCode}`, "提示词库加载失败", response.statusCode);
  }
  const items = ((response.data as { items?: PromptItem[] })?.items ?? []).filter(
    (item) => item && typeof item.prompt === "string",
  );
  try {
    Taro.setStorageSync(CACHE_KEY, { fetchedAt: Date.now(), items } satisfies PromptCache);
  } catch {
    // 存储失败不影响使用
  }
  return items;
}
