import Taro from "@tarojs/taro";
import { useConfigStore } from "@/stores/use-config-store";

export class ApiError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export type Quota = { limit: number; used: number; reserved: number; remaining: number; resetAt: string };

export type SessionGenerationInfo = {
  enabled: boolean;
  disabledReason?: string;
  modelLabel: string;
  maxPromptLength: number;
  maxReferenceImages: number;
};

export type MiniappSession = {
  mode: "miniapp";
  token: string;
  quota: Quota;
  generation: SessionGenerationInfo;
};

export type SubmitResult = {
  taskId: string;
  status: string;
  replayed: boolean;
  expiresAt: string;
  pollAfterMs: number;
};

export type TaskResultItem = {
  index: number;
  status: string;
  image?: { mimeType: string; url: string };
};

export type TaskPoll = {
  taskId: string;
  status: string;
  expiresAt?: string;
  pollAfterMs?: number;
  results?: TaskResultItem[];
  quota?: Quota;
};

function baseUrl(): string {
  const { serverBaseUrl } = useConfigStore.getState();
  if (!serverBaseUrl) throw new ApiError("NO_SERVER", "请先在「设置」页配置服务地址");
  return serverBaseUrl.replace(/\/+$/, "");
}

function authHeader(): Record<string, string> {
  const { token } = useConfigStore.getState();
  return token ? { "X-Miniapp-Token": token } : {};
}

function unwrap<T>(status: number, data: unknown): T {
  if (status >= 200 && status < 300) return data as T;
  const error = (data as { error?: { code?: string; message?: string } } | undefined)?.error;
  throw new ApiError(error?.code ?? `HTTP_${status}`, error?.message ?? `请求失败（${status}）`, status);
}

async function request<T>(options: { path: string; method?: "GET" | "POST"; data?: Record<string, unknown> }): Promise<T> {
  const response = await Taro.request({
    url: `${baseUrl()}${options.path}`,
    method: options.method ?? "GET",
    data: options.data,
    header: { "content-type": "application/json", ...authHeader() },
    timeout: 30000,
  }).catch(() => {
    throw new ApiError("NETWORK", "网络请求失败，请检查服务地址和网络");
  });
  return unwrap<T>(response.statusCode, response.data);
}

export function createSession(): Promise<MiniappSession> {
  return request<MiniappSession>({ path: "/api/miniapp/session", method: "POST" });
}

export function fetchQuota(): Promise<Quota> {
  return request<Quota>({ path: "/api/quota" });
}

export function submitGeneration(input: {
  requestKey: string;
  prompt: string;
  count: number;
  size: string;
  quality: string;
}): Promise<SubmitResult> {
  return request<SubmitResult>({ path: "/api/images/generations", method: "POST", data: input });
}

export async function submitEdit(input: {
  requestKey: string;
  prompt: string;
  count: number;
  size: string;
  quality: string;
  filePath: string;
}): Promise<SubmitResult> {
  const response = await Taro.uploadFile({
    url: `${baseUrl()}/api/images/edits`,
    filePath: input.filePath,
    name: "file",
    formData: {
      requestKey: input.requestKey,
      prompt: input.prompt,
      count: String(input.count),
      size: input.size,
      quality: input.quality,
    },
    header: authHeader(),
    timeout: 120000,
  }).catch(() => {
    throw new ApiError("NETWORK", "参考图上传失败，请检查网络");
  });
  let data: unknown;
  try {
    data = JSON.parse(response.data);
  } catch {
    throw new ApiError("INVALID_RESPONSE", "服务响应格式无效", response.statusCode);
  }
  return unwrap<SubmitResult>(response.statusCode, data);
}

export function pollTask(taskId: string): Promise<TaskPoll> {
  return request<TaskPoll>({ path: `/api/images/tasks/${encodeURIComponent(taskId)}` });
}

export async function downloadResultFile(pathOrUrl: string): Promise<string> {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${baseUrl()}${pathOrUrl}`;
  const response = await Taro.downloadFile({ url, header: authHeader(), timeout: 120000 }).catch(() => {
    throw new ApiError("NETWORK", "结果图下载失败，请检查网络");
  });
  if (response.statusCode !== 200) {
    throw new ApiError("DOWNLOAD_FAILED", "结果图下载失败", response.statusCode);
  }
  return response.tempFilePath;
}
