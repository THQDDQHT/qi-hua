export const IMAGE_GENERATION_COUNTS = [1, 2, 3, 4] as const;
export const IMAGE_GENERATION_COUNT_MIN = IMAGE_GENERATION_COUNTS[0];
export const IMAGE_GENERATION_COUNT_MAX = IMAGE_GENERATION_COUNTS[IMAGE_GENERATION_COUNTS.length - 1];
export const IMAGE_GENERATION_REFERENCE_LIMIT = 1;

export type ImageGenerationCount = (typeof IMAGE_GENERATION_COUNTS)[number];

export function assertImageGenerationReferenceLimit(references: readonly unknown[]): void {
    if (references.length > IMAGE_GENERATION_REFERENCE_LIMIT) {
        throw new Error(`图片生成最多使用 ${IMAGE_GENERATION_REFERENCE_LIMIT} 张参考图`);
    }
}

export function selectImageGenerationReferences<T>(references: readonly T[]): T[] {
    return references.slice(0, IMAGE_GENERATION_REFERENCE_LIMIT);
}

export function normalizeImageGenerationCount(value: unknown, fallback: ImageGenerationCount = IMAGE_GENERATION_COUNT_MIN): ImageGenerationCount {
    const normalizedFallback = normalizeFallback(fallback);
    if (value === "" || value === null || value === undefined) return normalizedFallback;
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return normalizedFallback;
    return Math.min(IMAGE_GENERATION_COUNT_MAX, Math.max(IMAGE_GENERATION_COUNT_MIN, Math.floor(number))) as ImageGenerationCount;
}

function normalizeFallback(value: number): ImageGenerationCount {
    if (!Number.isFinite(value) || value <= 0) return IMAGE_GENERATION_COUNT_MIN;
    return Math.min(IMAGE_GENERATION_COUNT_MAX, Math.max(IMAGE_GENERATION_COUNT_MIN, Math.floor(value))) as ImageGenerationCount;
}
