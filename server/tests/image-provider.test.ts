import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { createImageProvider } from "../src/services/image-provider";

const config = { aiBaseUrl: "https://provider.example/v1", aiApiKey: "secret", aiModel: "real-model" };

async function pngBase64() {
  return (await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer()).toString("base64");
}

describe("ImageProvider", () => {
  test("固定上游配置并返回已验证图片", async () => {
    let request: Request | undefined;
    const provider = createImageProvider(config as never, async (input, init) => {
      request = new Request(input, init);
      return Response.json({ data: [{ b64_json: await pngBase64() }] });
    });
    const image = await provider.generateSlot({ prompt: "cat", size: "1:1", quality: "high", signal: new AbortController().signal });
    expect(image.mimeType).toBe("image/png");
    expect(request?.url).toBe("https://provider.example/v1/images/generations");
    expect(request?.headers.get("authorization")).toBe("Bearer secret");
    expect(await request?.json()).toMatchObject({ model: "real-model", n: 1, response_format: "b64_json" });
  });

  test.each([
    [401, "PROVIDER_REJECTED"],
    [429, "SERVICE_UNAVAILABLE"],
    [500, "SERVICE_UNAVAILABLE"],
  ])("将 HTTP %s 转为受控错误", async (status, code) => {
    const provider = createImageProvider(config as never, async () => new Response("private provider body", { status }));
    await expect(provider.generateSlot({ prompt: "cat", size: "1:1", quality: "high", signal: new AbortController().signal }))
      .rejects.toMatchObject({ code });
  });

  test("拒绝空图片和非法图片", async () => {
    const empty = createImageProvider(config as never, async () => Response.json({ data: [] }));
    await expect(empty.generateSlot({ prompt: "cat", size: "1:1", quality: "high", signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    const invalid = createImageProvider(config as never, async () => Response.json({ data: [{ b64_json: Buffer.from("not image").toString("base64") }] }));
    await expect(invalid.generateSlot({ prompt: "cat", size: "1:1", quality: "high", signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });

  test("中止信号映射为超时", async () => {
    const controller = new AbortController();
    const provider = createImageProvider(config as never, async (_input, init) => {
      controller.abort();
      init?.signal?.throwIfAborted();
      return new Response();
    });
    await expect(provider.generateSlot({ prompt: "cat", size: "1:1", quality: "high", signal: controller.signal }))
      .rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
  });
});
