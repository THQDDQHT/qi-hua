import type { Hono } from "hono";
import type { AppEnv } from "../app";
import { PublicGenerationError } from "../domain/public-generation";
import type { createGenerationApiService } from "../services/generation-service";
import { errorStatus } from "../services/generation-service";
import { GENERATION_POLICY, validateGenerationInput, validateReferenceImages } from "../services/image-validation";

const MAX_MULTIPART_BYTES = GENERATION_POLICY.maxTotalReferenceBytes + 2 * 1024 * 1024;
type GenerationService = ReturnType<typeof createGenerationApiService>;

function errorBody(error: PublicGenerationError) {
  return { error: { code: error.code, message: error.message } };
}

function parseCount(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return value;
  return Number(value);
}

async function handle<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    const controlled = error instanceof PublicGenerationError
      ? error : new PublicGenerationError("SERVICE_UNAVAILABLE");
    return Response.json(errorBody(controlled), { status: errorStatus(controlled.code) });
  }
}

export function registerImageRoutes(app: Hono<AppEnv>, generationService: GenerationService) {
  app.post("/api/images/generations", (context) => handle(async () => {
    if (!context.get("config").publicGenerationEnabled) {
      throw new PublicGenerationError("PUBLIC_GENERATION_OFF", "公众生图暂时关闭");
    }
    const body = await context.req.json<Record<string, unknown>>().catch(() => {
      throw new PublicGenerationError("INVALID_REQUEST", "请求体必须是 JSON");
    });
    const result = await generationService.submit({
      operation: "generation",
      generation: validateGenerationInput(body),
      references: [],
      clientId: context.get("clientId"),
      ipHash: context.get("ipHash"),
      quotaDate: context.get("quotaDate"),
    });
    return context.json(result, 202, {
      Location: `/api/images/tasks/${result.taskId}`,
      "Retry-After": "2",
    });
  }));

  app.post("/api/images/edits", (context) => handle(async () => {
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
    // 小程序 wx.uploadFile 只能以 file 字段上传单文件，浏览器端用 references 字段。
    let files = form.getAll("references");
    if (files.length === 0) {
      const single = form.get("file");
      if (single !== null) files = [single];
    }
    if (files.some((value) => !(value instanceof File))) {
      throw new PublicGenerationError("INVALID_IMAGE", "参考图字段无效");
    }
    const result = await generationService.submit({
      operation: "edit",
      generation,
      references: await validateReferenceImages(files as File[]),
      clientId: context.get("clientId"),
      ipHash: context.get("ipHash"),
      quotaDate: context.get("quotaDate"),
    });
    return context.json(result, 202, {
      Location: `/api/images/tasks/${result.taskId}`,
      "Retry-After": "2",
    });
  }));

  app.get("/api/images/tasks/:taskId", (context) => handle(async () => context.json(
    await generationService.getTask({
      requestId: context.req.param("taskId"),
      clientId: context.get("clientId"),
      quotaDate: context.get("quotaDate"),
      resetAt: context.get("resetAt"),
    }),
  )));

  app.get("/api/images/tasks/:taskId/results/:index", (context) => handle(async () => {
    const result = await generationService.getResult({
      requestId: context.req.param("taskId"),
      clientId: context.get("clientId"),
      index: Number(context.req.param("index")),
    });
    return new Response(result.file, {
      headers: {
        "Content-Type": result.mimeType,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }));
}
