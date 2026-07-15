import assert from "node:assert/strict";

import { createImageGenerationFacade, publicGenerationInput } from "../src/services/image-generation";
import type { ReferenceImage } from "../src/types/image";

const references: ReferenceImage[] = [
    { id: "first", name: "first.png", type: "image/png", dataUrl: "data:image/png;base64,AA==" },
    { id: "second", name: "second.png", type: "image/png", dataUrl: "data:image/png;base64,AA==" },
];

const session = {
    mode: "public" as const,
    quota: { limit: 10, used: 0, reserved: 0, remaining: 10, resetAt: "2026-07-16T00:00:00.000Z" },
    generation: { enabled: true, modelLabel: "test", maxPromptLength: 4000, maxReferenceImages: 4 },
};

assert.throws(() => publicGenerationInput(session, { count: 1, size: "auto", quality: "auto", references }), /最多使用 1 张参考图/);

let fetchCalls = 0;
const publicFacade = createImageGenerationFacade({
    mode: "public",
    fetch: (async () => {
        fetchCalls += 1;
        return new Response();
    }) as typeof fetch,
    requestGeneration: async () => [],
    requestEdit: async () => [],
});
await assert.rejects(
    publicFacade.generateImages({ prompt: "test", count: 1, size: "auto", quality: "auto", references }),
    /最多使用 1 张参考图/,
);
assert.equal(fetchCalls, 0, "public 多参考图不应发起网络请求");

let editCalls = 0;
const selfHostedFacade = createImageGenerationFacade({
    mode: "self-hosted",
    fetch,
    requestGeneration: async () => [],
    requestEdit: async () => {
        editCalls += 1;
        return [];
    },
});
await assert.rejects(
    selfHostedFacade.generateImages({
        prompt: "test",
        count: 4,
        size: "auto",
        quality: "auto",
        references,
        selfHostedConfig: {} as never,
    }),
    /最多使用 1 张参考图/,
);
assert.equal(editCalls, 0, "self-hosted 多参考图不应调用编辑接口");

console.log("image generation reference limit tests passed");
