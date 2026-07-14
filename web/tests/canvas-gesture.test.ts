import assert from "node:assert/strict";

import { hasTouchMoved, panViewport, pinchViewport, touchDistance, touchMidpoint } from "../src/lib/canvas/canvas-gesture";

assert.equal(touchDistance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
assert.deepEqual(touchMidpoint({ x: 10, y: 20 }, { x: 30, y: 40 }), { x: 20, y: 30 });
assert.deepEqual(panViewport({ x: 10, y: 20, k: 2 }, { x: 100, y: 120 }, { x: 130, y: 90 }), { x: 40, y: -10, k: 2 });

const pinched = pinchViewport(
    { x: 0, y: 0, k: 1 },
    { x: 100, y: 100 },
    { x: 200, y: 100 },
    { x: 80, y: 100 },
    { x: 220, y: 100 },
);
assert.equal(pinched.k, 1.4);
assert.deepEqual({ x: Math.round(pinched.x * 100) / 100, y: Math.round(pinched.y * 100) / 100 }, { x: -60, y: -40 });
assert.equal(hasTouchMoved({ x: 0, y: 0 }, { x: 6, y: 6 }), true);
assert.equal(hasTouchMoved({ x: 0, y: 0 }, { x: 5, y: 5 }), false);

console.log("canvas gesture tests passed");
