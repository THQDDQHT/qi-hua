import { nanoid } from "nanoid";

import { appMode, type AppMode } from "@/lib/app-mode";
import { dataUrlToFile } from "@/lib/image-utils";
import { requestEdit, requestGeneration } from "@/services/api/image";
import { imageToDataUrl } from "@/services/image-storage";
import type { PublicSession, QuotaSnapshot } from "@/services/public-session";
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
};

export function publicGenerationInput(session: PublicSession, input: Pick<GenerateImagesInput, "count" | "size" | "quality" | "references">) {
    if (!session.generation.counts.includes(input.count)) throw new Error("当前生成张数不受支持");
    if (!session.generation.sizes.includes(input.size)) throw new Error("当前图片尺寸不受支持");
    if (!session.generation.qualities.includes(input.quality)) throw new Error("当前图片质量不受支持");
    if ((input.references?.length || 0) > session.generation.maxReferenceImages) throw new Error(`参考图最多 ${session.generation.maxReferenceImages} 张`);
}

type PublicBatchResponse = {
    results?: Array<{
        index: number;
        status: "success" | "failed";
        image?: { mimeType: string; data: string };
        errorCode?: string;
    }>;
    quota?: QuotaSnapshot;
    replayed?: boolean;
};

export type ImageGenerationDependencies = {
    mode: AppMode;
    fetch: typeof globalThis.fetch;
    requestGeneration: typeof requestGeneration;
    requestEdit: typeof requestEdit;
};

function publicImage(image: { mimeType: string; data: string }) {
    const dataUrl = image.data.startsWith("data:") ? image.data : `data:${image.mimeType};base64,${image.data}`;
    return { id: nanoid(), dataUrl, mimeType: image.mimeType };
}

async function referenceFiles(references: ReferenceImage[]) {
    return Promise.all(references.map(async (reference) => dataUrlToFile({ ...reference, dataUrl: await imageToDataUrl(reference) })));
}

async function readPublicError(response: Response) {
    try {
        const body = (await response.json()) as { errorCode?: string; error?: { code?: string; message?: string }; message?: string };
        return body.errorCode || body.error?.code || body.error?.message || body.message || `公众生图请求失败：${response.status}`;
    } catch {
        return `公众生图请求失败：${response.status}`;
    }
}

export function createImageGenerationFacade(dependencies: ImageGenerationDependencies) {
    async function generateImages(input: GenerateImagesInput): Promise<GenerationBatch> {
        if (dependencies.mode === "public") {
            if (input.mask) throw new Error("公众模式暂不支持蒙版编辑");
            const requestKey = input.requestKey || crypto.randomUUID();
            const references = input.references || [];
            let body: BodyInit;
            let path: string;
            let headers: HeadersInit | undefined;

            if (references.length) {
                path = "/api/images/edits";
                const form = new FormData();
                form.set("requestKey", requestKey);
                form.set("prompt", input.prompt);
                form.set("count", String(input.count));
                form.set("size", input.size);
                form.set("quality", input.quality);
                for (const file of await referenceFiles(references)) form.append("references", file);
                body = form;
            } else {
                path = "/api/images/generations";
                headers = { "Content-Type": "application/json" };
                body = JSON.stringify({ requestKey, prompt: input.prompt, count: input.count, size: input.size, quality: input.quality });
            }

            const response = await dependencies.fetch(path, { method: "POST", credentials: "same-origin", headers, body, signal: input.signal });
            if (!response.ok) throw new Error(await readPublicError(response));
            const batch = (await response.json()) as PublicBatchResponse;
            return {
                results: (batch.results || []).map((result) => ({
                    index: result.index,
                    status: result.status,
                    ...(result.image ? { image: publicImage(result.image) } : {}),
                    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
                })),
                quota: batch.quota,
                replayed: batch.replayed,
            };
        }

        if (!input.selfHostedConfig) throw new Error("自部署生图需要本地渠道配置");
        const config = { ...input.selfHostedConfig, count: String(input.count), size: input.size, quality: input.quality };
        const images = input.references?.length
            ? await dependencies.requestEdit(config, input.prompt, input.references, input.mask, { signal: input.signal })
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

    return { generateImages, generateSingleImage };
}

const imageGenerationFacade = createImageGenerationFacade({ mode: appMode, fetch: globalThis.fetch.bind(globalThis), requestGeneration, requestEdit });

export const generateImages = imageGenerationFacade.generateImages;
export const generateSingleImage = imageGenerationFacade.generateSingleImage;
