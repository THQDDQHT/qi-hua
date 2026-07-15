import assert from "node:assert/strict";

import {
    assertImageGenerationReferenceLimit,
    IMAGE_GENERATION_COUNTS,
    IMAGE_GENERATION_REFERENCE_LIMIT,
    normalizeImageGenerationCount,
    selectImageGenerationReferences,
} from "../src/lib/image-generation-policy";

assert.deepEqual(IMAGE_GENERATION_COUNTS, [1, 2, 3, 4]);
assert.equal(IMAGE_GENERATION_REFERENCE_LIMIT, 1);
assert.doesNotThrow(() => assertImageGenerationReferenceLimit([]));
assert.doesNotThrow(() => assertImageGenerationReferenceLimit(["reference"]));
assert.throws(() => assertImageGenerationReferenceLimit(["first", "second"]), /最多使用 1 张参考图/);
assert.deepEqual(selectImageGenerationReferences(["first", "second"]), ["first"]);
assert.equal(normalizeImageGenerationCount(1), 1);
assert.equal(normalizeImageGenerationCount("4"), 4);
assert.equal(normalizeImageGenerationCount(5), 4);
assert.equal(normalizeImageGenerationCount("15"), 4);
assert.equal(normalizeImageGenerationCount(3.9), 3);
assert.equal(normalizeImageGenerationCount(0), 1);
assert.equal(normalizeImageGenerationCount(-3), 1);
assert.equal(normalizeImageGenerationCount("", 3), 3);
assert.equal(normalizeImageGenerationCount(undefined, 3), 3);
assert.equal(normalizeImageGenerationCount("abc"), 1);

console.log("image generation policy tests passed");
