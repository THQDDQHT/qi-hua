// 与 server GENERATION_POLICY（server/src/services/image-validation.ts）保持一致的常量。
export const GENERATION_SIZES = ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"] as const;
export type GenerationSize = (typeof GENERATION_SIZES)[number];

export const GENERATION_QUALITIES = ["auto", "high", "medium", "low"] as const;
export type GenerationQuality = (typeof GENERATION_QUALITIES)[number];

export const SIZE_LABELS: Record<GenerationSize, string> = {
  auto: "智能",
  "1:1": "1:1 方形",
  "3:2": "3:2 横版",
  "2:3": "2:3 竖版",
  "4:3": "4:3 横版",
  "3:4": "3:4 竖版",
  "16:9": "16:9 宽幅",
  "9:16": "9:16 长图",
};

export const QUALITY_LABELS: Record<GenerationQuality, string> = {
  auto: "自动",
  high: "高清",
  medium: "标准",
  low: "快速",
};

export const MAX_PROMPT_LENGTH = 4000;
