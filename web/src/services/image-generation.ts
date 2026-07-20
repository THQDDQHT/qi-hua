import { nanoid } from "nanoid";

import { appMode, type AppMode } from "@/lib/app-mode";
import { assertImageGenerationReferenceLimit, IMAGE_GENERATION_REFERENCE_LIMIT, normalizeImageGenerationCount } from "@/lib/image-generation-policy";
import { dataUrlToFile } from "@/lib/image-utils";
import { requestEdit, requestGeneration } from "@/services/api/image";
import { imageToDataUrl } from "@/services/image-storage";
import { PublicApiError, readPublicApiError, type PublicSession, type QuotaSnapshot } from "@/services/public-session";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

export type GeneratedImageResult = {
    index: number;
    status: "success" | "failed";
    image?: { id: string; dataUrl: string; mimeType: string };
    errorCode?: string;
    quota?: QuotaSnapshot;
    replayed?: boolean;
};

export type GenerationBatch = {
    results: GeneratedImageResult[];
    quota?: QuotaSnapshot;
    replayed?: boolean;
};

export type PublicImageGenerationTask = {
    taskId: string;
    requestKey: string;
    expiresAt?: string;
};

export type GenerateImagesInput = {
    requestKey?: string;
    prompt: string;
    count: number;
    size: string;
    quality: string;
    references?: ReferenceImage[];
    mask?: ReferenceImage;
    signal?: AbortSignal;
    selfHostedConfig?: AiConfig;
    onTaskCreated?: (task: PublicImageGenerationTask) => void | Promise<void>;
};

export type ResumePublicGenerationOptions = {
    signal?: AbortSignal;
    expiresAt?: string;
};

export function publicGenerationInput(session: PublicSession, input: Pick<GenerateImagesInput, "count" | "size" | "quality" | "references">) {
    const limit = Math.min(IMAGE_GENERATION_REFERENCE_LIMIT, session.generation.maxReferenceImages);
    if ((input.references?.length || 0) > limit) throw new Error(`图片生成最多使用 ${limit} 张参考图`);
}

type PublicImagePayload = {
    mimeType: string;
    data?: string;
    url?: string;
};

type PublicResultPayload = {
    index: number;
    status: "success" | "failed";
    image?: PublicImagePayload;
    errorCode?: string;
};

type PublicTaskStatus = "queued" | "running" | "completed" | "partial" | "failed" | "expired" | "canceled" | "cancelled";

type PublicBatchResponse = {
    taskId?: string;
    status?: PublicTaskStatus;
    results?: PublicResultPayload[];
    quota?: QuotaSnapshot;
    replayed?: boolean;
    expiresAt?: string;
    pollAfterMs?: number;
};

export type ImageGenerationDependencies = {
    mode: AppMode;
    fetch: typeof globalThis.fetch;
    requestGeneration: typeof requestGeneration;
    requestEdit: typeof requestEdit;
    pollDelaysMs?: readonly number[];
    maxPollMs?: number;
    now?: () => number;
};

type PollEntry = {
    controller: AbortController;
    promise: Promise<GenerationBatch>;
    subscribers: number;
    settled: boolean;
};

type PollOptions = ResumePublicGenerationOptions & {
    initialDelayMs?: number;
    replayed?: boolean;
};

const DEFAULT_POLL_DELAYS_MS = [2000, 3000, 5000] as const;
const DEFAULT_MAX_POLL_MS = 6 * 60 * 60 * 1000;
const MAX_RESULT_BYTES = 16 * 1024 * 1024;
const MAX_RESULT_COUNT = 4;
const RESULT_FETCH_ATTEMPTS = 3;
const RESULT_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const ACTIVE_TASK_STATUSES = new Set<PublicTaskStatus>(["queued", "running"]);
const TERMINAL_TASK_STATUSES = new Set<PublicTaskStatus>(["completed", "partial", "failed", "expired", "canceled", "cancelled"]);

class InvalidTaskResponseError extends Error {
    constructor(message = "生图任务响应格式无效") {
        super(message);
        this.name = "InvalidTaskResponseError";
    }
}

function normalizedDelay(value: unknown) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 60_000 ? value : undefined;
}

function abortError() {
    return new DOMException("请求已取消", "AbortError");
}

function isAbortError(error: unknown) {
    return error instanceof Error && error.name === "AbortError";
}

function delay(ms: number, signal?: AbortSignal) {
    if (signal?.aborted) return Promise.reject(abortError());
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortError());
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function publicImageDataUrl(image: PublicImagePayload) {
    if (!image.data) throw new InvalidTaskResponseError("图片任务没有返回图片内容");
    return image.data.startsWith("data:") ? image.data : `data:${image.mimeType};base64,${image.data}`;
}

function encodeBase64(bytes: Uint8Array) {
    let result = "";
    const chunkSize = 32_766;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        result += btoa(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
    }
    return result;
}

async function responseImageDataUrl(response: Response, mimeType: string) {
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null) {
        const bytes = Number(contentLength);
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_RESULT_BYTES) throw new InvalidTaskResponseError("生成图片超过 16MiB 限制");
    }
    if (!response.body) throw new InvalidTaskResponseError("生成图片内容为空");

    const reader = response.body.getReader();
    let total = 0;
    let carry = new Uint8Array(0);
    let base64 = "";
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESULT_BYTES) {
            await reader.cancel().catch(() => undefined);
            throw new InvalidTaskResponseError("生成图片超过 16MiB 限制");
        }
        const bytes = carry.length ? new Uint8Array(carry.length + value.length) : value;
        if (carry.length) {
            bytes.set(carry);
            bytes.set(value, carry.length);
        }
        const encodedLength = bytes.length - (bytes.length % 3);
        if (encodedLength) base64 += encodeBase64(bytes.subarray(0, encodedLength));
        carry = bytes.slice(encodedLength);
    }
    if (!total) throw new InvalidTaskResponseError("生成图片内容为空");
    if (carry.length) base64 += encodeBase64(carry);
    return `data:${mimeType};base64,${base64}`;
}

async function referenceFiles(references: ReferenceImage[]) {
    return Promise.all(references.map(async (reference) => dataUrlToFile({ ...reference, dataUrl: await imageToDataUrl(reference) })));
}

export function createImageGenerationFacade(dependencies: ImageGenerationDependencies) {
    const polls = new Map<string, PollEntry>();
    const pollDelays = dependencies.pollDelaysMs?.length ? dependencies.pollDelaysMs.map((value) => Math.max(0, value)) : [...DEFAULT_POLL_DELAYS_MS];
    const maxPollMs = dependencies.maxPollMs ?? DEFAULT_MAX_POLL_MS;
    const now = dependencies.now || Date.now;

    function pollDelay(attempt: number) {
        return pollDelays[Math.min(attempt, pollDelays.length - 1)] ?? DEFAULT_POLL_DELAYS_MS.at(-1)!;
    }

    async function fetchPublicImage(url: string, signal?: AbortSignal) {
        for (let attempt = 0; attempt < RESULT_FETCH_ATTEMPTS; attempt += 1) {
            try {
                const response = await dependencies.fetch(url, { credentials: "same-origin", signal });
                if (!response.ok) throw await readPublicApiError(response, "生成图片下载失败");
                const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || "";
                if (!RESULT_MIME_TYPES.has(mimeType)) throw new InvalidTaskResponseError("生成图片格式仅支持 JPEG、PNG 或 WebP");
                return { dataUrl: await responseImageDataUrl(response, mimeType), mimeType };
            } catch (error) {
                if (isAbortError(error) || error instanceof InvalidTaskResponseError) throw error;
                if (error instanceof PublicApiError && !error.issue.retryable) throw error;
                if (attempt === RESULT_FETCH_ATTEMPTS - 1) throw error;
                await delay(pollDelay(attempt), signal);
            }
        }
        throw new Error("生成图片下载失败");
    }

    async function publicImage(image: PublicImagePayload, taskId: string | undefined, index: number, signal?: AbortSignal) {
        if (image.data) return { id: nanoid(), dataUrl: publicImageDataUrl(image), mimeType: image.mimeType };
        if (!image.url || !taskId) throw new InvalidTaskResponseError("图片任务没有返回有效图片地址");
        const expectedUrl = `/api/images/tasks/${encodeURIComponent(taskId)}/results/${index}`;
        if (image.url !== expectedUrl) throw new InvalidTaskResponseError("图片任务返回了不受信任的图片地址");
        const result = await fetchPublicImage(expectedUrl, signal);
        return { id: nanoid(), ...result };
    }

    async function publicBatch(payload: PublicBatchResponse, signal?: AbortSignal, replayed = payload.replayed, taskId = payload.taskId): Promise<GenerationBatch> {
        const payloadResults = payload.results || [];
        if (payloadResults.length > MAX_RESULT_COUNT) throw new InvalidTaskResponseError("单次生图结果不能超过 4 张");
        const indexes = new Set<number>();
        const results: GeneratedImageResult[] = [];
        for (const result of payloadResults) {
            if (!Number.isSafeInteger(result.index) || result.index < 0 || result.index >= MAX_RESULT_COUNT || indexes.has(result.index)) throw new InvalidTaskResponseError("生图结果序号无效");
            indexes.add(result.index);
            results.push({
                index: result.index,
                status: result.status,
                ...(result.image ? { image: await publicImage(result.image, taskId, result.index, signal) } : {}),
                ...(result.errorCode ? { errorCode: result.errorCode } : {}),
            });
        }
        return {
            results,
            ...(payload.quota ? { quota: payload.quota } : {}),
            ...(replayed !== undefined ? { replayed } : {}),
        };
    }

    async function readTaskResponse(response: Response) {
        if (!response.ok) throw await readPublicApiError(response, "生图任务查询失败");
        try {
            const payload = (await response.json()) as PublicBatchResponse;
            if (!payload || typeof payload !== "object" || !payload.status) throw new InvalidTaskResponseError();
            return payload;
        } catch (error) {
            if (error instanceof InvalidTaskResponseError) throw error;
            throw new InvalidTaskResponseError();
        }
    }

    function retryablePollError(error: unknown) {
        if (error instanceof PublicApiError) return error.issue.retryable;
        if (error instanceof InvalidTaskResponseError || isAbortError(error)) return false;
        return true;
    }

    async function pollPublicGeneration(taskId: string, options: PollOptions, signal: AbortSignal): Promise<GenerationBatch> {
        const startedAt = now();
        const parsedExpiry = options.expiresAt ? Date.parse(options.expiresAt) : Number.NaN;
        const deadline = Math.min(startedAt + maxPollMs, Number.isFinite(parsedExpiry) ? parsedExpiry : Number.POSITIVE_INFINITY);
        let waitMs = normalizedDelay(options.initialDelayMs) ?? 0;
        let attempt = waitMs > 0 ? 1 : 0;

        while (true) {
            if (waitMs > 0 && now() < deadline) await delay(Math.min(waitMs, Math.max(0, deadline - now())), signal);
            if (signal.aborted) throw abortError();

            let payload: PublicBatchResponse;
            try {
                payload = await readTaskResponse(
                    await dependencies.fetch(`/api/images/tasks/${encodeURIComponent(taskId)}`, {
                        credentials: "same-origin",
                        signal,
                    }),
                );
            } catch (error) {
                if (!retryablePollError(error)) throw error;
                if (now() >= deadline) throw new Error("生图任务等待超时，请稍后刷新查看结果");
                waitMs = pollDelay(attempt++);
                continue;
            }

            if (payload.taskId && payload.taskId !== taskId) throw new InvalidTaskResponseError("生图任务编号不匹配");
            if (payload.status && TERMINAL_TASK_STATUSES.has(payload.status)) return publicBatch(payload, signal, payload.replayed ?? options.replayed, taskId);
            if (!payload.status || !ACTIVE_TASK_STATUSES.has(payload.status)) throw new InvalidTaskResponseError();
            if (now() >= deadline) throw new Error("生图任务等待超时，请稍后刷新查看结果");
            waitMs = normalizedDelay(payload.pollAfterMs) ?? pollDelay(attempt++);
        }
    }

    function subscribe(entry: PollEntry, taskId: string, signal?: AbortSignal) {
        if (signal?.aborted) return Promise.reject<GenerationBatch>(abortError());
        entry.subscribers += 1;
        return new Promise<GenerationBatch>((resolve, reject) => {
            let released = false;
            const release = () => {
                if (released) return;
                released = true;
                signal?.removeEventListener("abort", onAbort);
                entry.subscribers -= 1;
                if (entry.subscribers === 0 && !entry.settled) {
                    entry.controller.abort();
                    if (polls.get(taskId) === entry) polls.delete(taskId);
                }
            };
            const onAbort = () => {
                release();
                reject(abortError());
            };
            signal?.addEventListener("abort", onAbort, { once: true });
            entry.promise.then(
                (batch) => {
                    release();
                    resolve(batch);
                },
                (error) => {
                    release();
                    reject(error);
                },
            );
        });
    }

    function waitForPublicGeneration(taskId: string, options: PollOptions = {}) {
        if (options.signal?.aborted) return Promise.reject<GenerationBatch>(abortError());
        let entry = polls.get(taskId);
        if (!entry) {
            const controller = new AbortController();
            entry = {
                controller,
                promise: pollPublicGeneration(taskId, options, controller.signal),
                subscribers: 0,
                settled: false,
            };
            polls.set(taskId, entry);
            const current = entry;
            current.promise.then(
                () => {
                    current.settled = true;
                    if (polls.get(taskId) === current) polls.delete(taskId);
                },
                () => {
                    current.settled = true;
                    if (polls.get(taskId) === current) polls.delete(taskId);
                },
            );
        }
        return subscribe(entry, taskId, options.signal);
    }

    async function resumePublicGeneration(taskId: string, options: ResumePublicGenerationOptions = {}) {
        if (dependencies.mode !== "public") throw new Error("只有公众模式支持恢复生图任务");
        if (!taskId.trim()) throw new Error("缺少生图任务编号");
        return waitForPublicGeneration(taskId, options);
    }

    async function generateImages(input: GenerateImagesInput): Promise<GenerationBatch> {
        const count = normalizeImageGenerationCount(input.count);
        const references = input.references || [];
        assertImageGenerationReferenceLimit(references);
        if (dependencies.mode === "public") {
            if (input.mask) throw new Error("公众模式暂不支持蒙版编辑");
            const requestKey = input.requestKey || crypto.randomUUID();
            let body: BodyInit;
            let path: string;
            let headers: HeadersInit | undefined;

            if (references.length) {
                path = "/api/images/edits";
                const form = new FormData();
                form.set("requestKey", requestKey);
                form.set("prompt", input.prompt);
                form.set("count", String(count));
                form.set("size", input.size);
                form.set("quality", input.quality);
                for (const file of await referenceFiles(references)) form.append("references", file);
                body = form;
            } else {
                path = "/api/images/generations";
                headers = { "Content-Type": "application/json" };
                body = JSON.stringify({ requestKey, prompt: input.prompt, count, size: input.size, quality: input.quality });
            }

            const response = await dependencies.fetch(path, { method: "POST", credentials: "same-origin", headers, body, signal: input.signal });
            if (!response.ok) throw await readPublicApiError(response, "公众生图请求失败");
            let payload: PublicBatchResponse;
            try {
                payload = (await response.json()) as PublicBatchResponse;
            } catch {
                throw new InvalidTaskResponseError();
            }
            if (Array.isArray(payload.results)) return publicBatch(payload, input.signal);
            if (!payload.taskId) throw new InvalidTaskResponseError("生图任务没有返回任务编号");
            await input.onTaskCreated?.({ taskId: payload.taskId, requestKey, ...(payload.expiresAt ? { expiresAt: payload.expiresAt } : {}) });
            return waitForPublicGeneration(payload.taskId, {
                signal: input.signal,
                expiresAt: payload.expiresAt,
                replayed: payload.replayed,
                initialDelayMs: normalizedDelay(payload.pollAfterMs) ?? pollDelay(0),
            });
        }

        if (!input.selfHostedConfig) throw new Error("自部署生图需要本地渠道配置");
        const config = { ...input.selfHostedConfig, count: String(count), size: input.size, quality: input.quality };
        const images = references.length
            ? await dependencies.requestEdit(config, input.prompt, references, input.mask, { signal: input.signal })
            : await dependencies.requestGeneration(config, input.prompt, { signal: input.signal });
        return {
            results: images.map((image, index) => ({ index, status: "success", image: { ...image, mimeType: image.dataUrl.match(/^data:([^;,]+)/)?.[1] || "image/png" } })),
        };
    }

    async function generateSingleImage(input: Omit<GenerateImagesInput, "count">): Promise<GeneratedImageResult> {
        const batch = await generateImages({ ...input, count: 1 });
        const result = batch.results[0];
        if (!result) throw new Error("接口没有返回图片结果");
        return { ...result, quota: batch.quota, replayed: batch.replayed };
    }

    return { generateImages, generateSingleImage, resumePublicGeneration };
}

const imageGenerationFacade = createImageGenerationFacade({ mode: appMode, fetch: globalThis.fetch.bind(globalThis), requestGeneration, requestEdit });

export const generateImages = imageGenerationFacade.generateImages;
export const generateSingleImage = imageGenerationFacade.generateSingleImage;
export const resumePublicGeneration = imageGenerationFacade.resumePublicGeneration;
