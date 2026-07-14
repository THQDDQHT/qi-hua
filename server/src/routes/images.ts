import type { Hono } from "hono";
import type { AppEnv } from "../app";
import { PublicGenerationError } from "../domain/public-generation";
import type { createGenerationService } from "../services/generation-service";
import { errorStatus } from "../services/generation-service";
import { GENERATION_POLICY, validateGenerationInput, validateReferenceImages } from "../services/image-validation";

const MAX_MULTIPART_BYTES = GENERATION_POLICY.maxTotalReferenceBytes + 2 * 1024 * 1024;
type GenerationService = ReturnType<typeof createGenerationService>;

function errorBody(error: PublicGenerationError) {
  return { error: { code: error.code, message: error.message } };
}

function parseCount(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return value;
  return Number(value);
}

export function registerImageRoutes(app: Hono<AppEnv>, generationService: GenerationService) {
  app.post("/api/images/generations", async (context) => {
    try {
      if (!context.get("config").publicGenerationEnabled) {
        throw new PublicGenerationError("PUBLIC_GENERATION_OFF", "公众生图暂时关闭");
      }
      const body = await context.req.json<Record<string, unknown>>().catch(() => {
        throw new PublicGenerationError("INVALID_REQUEST", "请求体必须是 JSON");
      });
      const generation = validateGenerationInput(body);
      const result = await generationService.execute({
        operation: "generation",
        generation,
        references: [],
        clientId: context.get("clientId"),
        ipHash: context.get("ipHash"),
        quotaDate: context.get("quotaDate"),
      });
      return context.json(result, result.status === "running" ? 202 : 200);
    } catch (error) {
      if (error instanceof PublicGenerationError) {
        return context.json(errorBody(error), errorStatus(error.code));
      }
      return context.json(errorBody(new PublicGenerationError("SERVICE_UNAVAILABLE")), 503);
    }
  });

  app.post("/api/images/edits", async (context) => {
    try {
      if (!context.get("config").publicGenerationEnabled) {
        throw new PublicGenerationError("PUBLIC_GENERATION_OFF", "公众生图暂时关闭");
      }
      const contentLength = Number(context.req.header("content-length") ?? 0);
      if (Number.isFinite(contentLength) && contentLength > MAX_MULTIPART_BYTES) {
        throw new PublicGenerationError("REQUEST_TOO_LARGE", "请求体不能超过 22MB");
      }
      const form = await context.req.formData().catch(() => {
        throw new PublicGenerationError("INVALID_REQUEST", "请求体必须是 multipart/form-data");
      });
      const generation = validateGenerationInput({
        requestKey: form.get("requestKey"),
        prompt: form.get("prompt"),
        count: parseCount(form.get("count")),
        size: form.get("size"),
        quality: form.get("quality"),
      });
      const files = form.getAll("references");
      if (files.some((value) => !(value instanceof File))) {
        throw new PublicGenerationError("INVALID_IMAGE", "参考图字段无效");
      }
      const references = await validateReferenceImages(files as File[]);
      const result = await generationService.execute({
        operation: "edit",
        generation,
        references,
        clientId: context.get("clientId"),
        ipHash: context.get("ipHash"),
        quotaDate: context.get("quotaDate"),
      });
      return context.json(result, result.status === "running" ? 202 : 200);
    } catch (error) {
      if (error instanceof PublicGenerationError) {
        return context.json(errorBody(error), errorStatus(error.code));
      }
      return context.json(errorBody(new PublicGenerationError("SERVICE_UNAVAILABLE")), 503);
    }
  });
}
