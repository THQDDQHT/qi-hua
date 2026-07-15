import assert from "node:assert/strict";

import { IMAGE_GENERATION_COUNTS, normalizeImageGenerationCount } from "../src/lib/image-generation-policy";

assert.deepEqual(IMAGE_GENERATION_COUNTS, [1, 2, 3, 4]);
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
