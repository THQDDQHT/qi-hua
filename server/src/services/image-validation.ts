import { createHash } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import sharp, { type Metadata } from "sharp";
import { PublicGenerationError } from "../domain/public-generation";

export const GENERATION_POLICY = {
  counts: [1, 2, 3, 4] as const,
  sizes: ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"] as const,
  qualities: ["auto", "high", "medium", "low"] as const,
  maxPromptLength: 4000,
  maxRequestKeyLength: 128,
  maxReferenceImages: 4,
  maxReferenceBytes: 10 * 1024 * 1024,
  maxTotalReferenceBytes: 20 * 1024 * 1024,
  maxReferencePixels: 8_294_400,
  maxReferenceEdge: 3840,
} as const;

export type GenerationSize = (typeof GENERATION_POLICY.sizes)[number];
export type GenerationQuality = (typeof GENERATION_POLICY.qualities)[number];

export type GenerationInput = {
  requestKey: string;
  prompt: string;
  count: number;
  size: GenerationSize;
  quality: GenerationQuality;
};

export type ValidatedReference = {
  file: File;
  bytes: Uint8Array;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  digest: Uint8Array;
};

function invalid(
  message: string,
  code: "INVALID_REQUEST" | "INVALID_IMAGE" | "REQUEST_TOO_LARGE" = "INVALID_REQUEST",
): never {
  throw new PublicGenerationError(code, message);
}

function stringField(value: unknown, name: string) {
  if (typeof value !== "string") invalid(`${name} 必须是字符串`);
  return value;
}

export function validateGenerationInput(value: Record<string, unknown>): GenerationInput {
  const requestKey = stringField(value.requestKey, "requestKey");
  const prompt = stringField(value.prompt, "prompt");
  const count = value.count;
  const size = value.size;
  const quality = value.quality;

  if (!requestKey.trim() || requestKey.length > GENERATION_POLICY.maxRequestKeyLength) {
    invalid("requestKey 不能为空且最长 128 个字符");
  }
  if (!prompt.trim() || prompt.length > GENERATION_POLICY.maxPromptLength) {
    invalid("提示词不能为空且最长 4000 个字符");
  }
  if (!Number.isSafeInteger(count) || !GENERATION_POLICY.counts.includes(count as 1 | 2 | 3 | 4)) {
    invalid("count 必须是 1 到 4 的安全整数");
  }
  if (typeof size !== "string" || !GENERATION_POLICY.sizes.includes(size as GenerationSize)) {
    invalid("size 不在允许列表中");
  }
  if (typeof quality !== "string" || !GENERATION_POLICY.qualities.includes(quality as GenerationQuality)) {
    invalid("quality 不在允许列表中");
  }

  return {
    requestKey,
    prompt,
    count: count as number,
    size: size as GenerationSize,
    quality: quality as GenerationQuality,
  };
}

export async function validateReferenceImages(files: readonly File[]): Promise<ValidatedReference[]> {
  if (files.length < 1) invalid("至少需要一张参考图", "INVALID_IMAGE");
  if (files.length > GENERATION_POLICY.maxReferenceImages) {
    invalid("参考图最多 4 张", "REQUEST_TOO_LARGE");
  }

  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (totalBytes > GENERATION_POLICY.maxTotalReferenceBytes) {
    invalid("参考图总量不能超过 20MB", "REQUEST_TOO_LARGE");
  }

  const validated: ValidatedReference[] = [];
  for (const file of files) {
    if (file.size > GENERATION_POLICY.maxReferenceBytes) {
      invalid("单张参考图不能超过 10MB", "REQUEST_TOO_LARGE");
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const detected = await fileTypeFromBuffer(bytes);
    if (
      detected?.mime !== "image/jpeg"
      && detected?.mime !== "image/png"
      && detected?.mime !== "image/webp"
    ) {
      invalid("参考图必须是有效的 JPEG、PNG 或 WebP", "INVALID_IMAGE");
    }

    let metadata: Metadata;
    try {
      metadata = await sharp(bytes, { failOn: "error", limitInputPixels: GENERATION_POLICY.maxReferencePixels }).metadata();
    } catch {
      invalid("参考图无法解码或像素超限", "INVALID_IMAGE");
    }

    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (width < 1 || height < 1) invalid("参考图缺少有效尺寸", "INVALID_IMAGE");
    if (
      Math.max(width, height) > GENERATION_POLICY.maxReferenceEdge
      || width * height > GENERATION_POLICY.maxReferencePixels
    ) {
      invalid("参考图尺寸超过限制", "INVALID_IMAGE");
    }

    validated.push({
      file: new File([bytes], file.name || "reference", { type: detected.mime }),
      bytes,
      mimeType: detected.mime,
      digest: createHash("sha256").update(bytes).digest(),
    });
  }

  return validated;
}
