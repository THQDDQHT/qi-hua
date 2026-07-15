import { createHash } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import sharp, { type Metadata } from "sharp";
import { PublicGenerationError } from "../domain/public-generation";

export const GENERATION_POLICY = {
  counts: [1, 2, 3, 4] as const,
  sizes: ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "2048x2048", "2048x1152", "1152x2048", "3840x2160", "2160x3840", "auto"] as const,
  qualities: ["auto", "high", "medium", "low"] as const,
  maxPromptLength: 4000,
  maxRequestKeyLength: 128,
  maxReferenceImages: 1,
  maxReferenceBytes: 10 * 1024 * 1024,
  maxTotalReferenceBytes: 20 * 1024 * 1024,
  maxReferencePixels: 8_294_400,
  maxReferenceEdge: 3840,
  maxOutputPixels: 8_294_400,
  maxOutputEdge: 3840,
} as const;

type FixedGenerationSize = (typeof GENERATION_POLICY.sizes)[number];
export type GenerationSize = FixedGenerationSize | `${number}x${number}`;
export type GenerationQuality = (typeof GENERATION_POLICY.qualities)[number];
type GenerationCount = (typeof GENERATION_POLICY.counts)[number];

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

function isGenerationSize(value: unknown): value is GenerationSize {
  if (typeof value !== "string") return false;
  if (GENERATION_POLICY.sizes.includes(value as FixedGenerationSize)) return true;
  const match = value.match(/^([1-9]\d*)x([1-9]\d*)$/);
  if (!match) return false;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return Number.isSafeInteger(width)
    && Number.isSafeInteger(height)
    && Math.max(width, height) <= GENERATION_POLICY.maxOutputEdge
    && width * height <= GENERATION_POLICY.maxOutputPixels;
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
  if (!Number.isSafeInteger(count) || !GENERATION_POLICY.counts.includes(count as GenerationCount)) {
    invalid("count 必须是 1 到 4 的安全整数");
  }
  if (!isGenerationSize(size)) {
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
    invalid(`参考图最多 ${GENERATION_POLICY.maxReferenceImages} 张`, "REQUEST_TOO_LARGE");
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
