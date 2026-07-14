import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { PublicGenerationError, type PublicGenerationErrorCode } from "../src/domain/public-generation";
import { validateGenerationInput, validateReferenceImages } from "../src/services/image-validation";
import { createGenerationFingerprint } from "../src/services/generation-fingerprint";

function expectCode(callback: () => unknown, code: PublicGenerationErrorCode) {
  expect(callback).toThrow(PublicGenerationError);
  try { callback(); } catch (error) { expect((error as PublicGenerationError).code).toBe(code); }
}

describe("图片输入校验", () => {
  test("拒绝空提示词、非法数量和未知枚举", () => {
    const base = { requestKey: "key", prompt: "cat", count: 1, size: "1:1", quality: "high" };
    expectCode(() => validateGenerationInput({ ...base, prompt: "   " }), "INVALID_REQUEST");
    expectCode(() => validateGenerationInput({ ...base, count: 5 }), "INVALID_REQUEST");
    expectCode(() => validateGenerationInput({ ...base, size: "custom" }), "INVALID_REQUEST");
  });

  test("保留提示词原始字节并匹配固定指纹向量", () => {
    const generation = validateGenerationInput({
      requestKey: "key",
      prompt: "cat\nblue",
      count: 2,
      size: "1:1",
      quality: "high",
    });
    const fingerprint = createGenerationFingerprint({
      secret: "0123456789abcdef0123456789abcdef",
      operation: "generation",
      generation,
      references: [],
    });
    expect(Buffer.from(fingerprint).toString("hex")).toBe("4d9d1cf77dde2b2421ae8109ee3482f647a70477d9053439cd47e34dc8936b58");
  });

  test("按真实内容识别图片并兼容空 MIME", async () => {
    const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: "red" } }).png().toBuffer();
    const [reference] = await validateReferenceImages([new File([bytes], "photo", { type: "" })]);
    expect(reference.mimeType).toBe("image/png");
    expect(reference.digest.byteLength).toBe(32);
  });

  test("拒绝伪装文件和超长边图片", async () => {
    await expect(validateReferenceImages([new File(["not image"], "fake.png", { type: "image/png" })]))
      .rejects.toMatchObject({ code: "INVALID_IMAGE" });
    const bytes = await sharp({ create: { width: 3841, height: 1, channels: 3, background: "red" } }).png().toBuffer();
    await expect(validateReferenceImages([new File([bytes], "wide.png")]))
      .rejects.toMatchObject({ code: "INVALID_IMAGE" });
  });
});
