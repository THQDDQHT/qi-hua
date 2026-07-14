import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { createImageProvider } from "../src/services/image-provider";
import { startFakeImageProvider } from "./helpers/fake-image-provider";

async function pngBase64() {
  return (await sharp({
    create: { width: 2, height: 2, channels: 3, background: "red" },
  }).png().toBuffer()).toString("base64");
}

function config(baseUrl: string) {
  return { aiBaseUrl: baseUrl, aiApiKey: "secret", aiModel: "real-model" };
}

describe("ImageProvider", () => {
  test("通过真实 HTTP 固定上游配置并返回已验证图片", async () => {
    const fake = startFakeImageProvider(async () => Response.json({ data: [{ b64_json: await pngBase64() }] }));
    try {
      const provider = createImageProvider(config(fake.baseUrl) as never);
      const image = await provider.generateSlot({
        prompt: "cat",
        size: "1:1",
        quality: "high",
        signal: new AbortController().signal,
      });

      expect(image.mimeType).toBe("image/png");
      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0]).toMatchObject({
        method: "POST",
        path: "/v1/images/generations",
        authorization: "Bearer secret",
        contentType: "application/json",
      });
      expect(JSON.parse(fake.requests[0].body)).toMatchObject({
        model: "real-model",
        prompt: "cat",
        n: 1,
        response_format: "b64_json",
      });
    } finally {
      await fake.stop();
    }
  });

  test("编辑请求使用 multipart 并携带参考图", async () => {
    const fake = startFakeImageProvider(async () => Response.json({ data: [{ b64_json: await pngBase64() }] }));
    try {
      const bytes = await sharp({
        create: { width: 2, height: 2, channels: 3, background: "blue" },
      }).png().toBuffer();
      const provider = createImageProvider(config(fake.baseUrl) as never);

      await provider.editSlot({
        prompt: "edit cat",
        size: "1:1",
        quality: "medium",
        references: [new File([bytes], "reference.png", { type: "image/png" })],
        signal: new AbortController().signal,
      });

      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0].path).toBe("/v1/images/edits");
      expect(fake.requests[0].contentType).toStartWith("multipart/form-data; boundary=");
      expect(fake.requests[0].body).toContain("real-model");
      expect(fake.requests[0].body).toContain("edit cat");
      expect(fake.requests[0].body).toContain("reference.png");
      expect(fake.requests[0].body).toContain("b64_json");
    } finally {
      await fake.stop();
    }
  });

  test.each([
    [401, "PROVIDER_REJECTED"],
    [429, "SERVICE_UNAVAILABLE"],
    [500, "SERVICE_UNAVAILABLE"],
  ])("将 HTTP %s 转为受控错误且不暴露响应正文", async (status, code) => {
    const fake = startFakeImageProvider(() => new Response("private provider body", { status }));
    try {
      const provider = createImageProvider(config(fake.baseUrl) as never);
      let caught: unknown;
      try {
        await provider.generateSlot({
          prompt: "cat",
          size: "1:1",
          quality: "high",
          signal: new AbortController().signal,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code });
      expect(String((caught as Error).message)).not.toContain("private provider body");
    } finally {
      await fake.stop();
    }
  });

  test("拒绝空图片和非法图片", async () => {
    for (const payload of [
      { data: [] },
      { data: [{ b64_json: Buffer.from("not image").toString("base64") }] },
    ]) {
      const fake = startFakeImageProvider(() => Response.json(payload));
      try {
        const provider = createImageProvider(config(fake.baseUrl) as never);
        await expect(provider.generateSlot({
          prompt: "cat",
          size: "1:1",
          quality: "high",
          signal: new AbortController().signal,
        })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
      } finally {
        await fake.stop();
      }
    }
  });

  test("真实 HTTP 延迟响应被中止后映射为超时", async () => {
    const fake = startFakeImageProvider(async (request) => {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000);
        request.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      return Response.json({ data: [] });
    });
    try {
      const controller = new AbortController();
      const provider = createImageProvider(config(fake.baseUrl) as never);
      const pending = provider.generateSlot({
        prompt: "cat",
        size: "1:1",
        quality: "high",
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 10);

      await expect(pending).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
    } finally {
      await fake.stop();
    }
  });
});
