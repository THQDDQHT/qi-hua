import assert from "node:assert/strict";

import { createPublicSessionStore } from "../src/stores/use-public-session-store";
import type { PublicSessionClient } from "../src/services/public-session";

const quota = { limit: 10, used: 2, reserved: 1, remaining: 7, resetAt: "2026-07-15T16:00:00.000Z" };
const session = {
    mode: "public" as const,
    quota,
    generation: { modelLabel: "免费生图模型", counts: [1, 2, 3, 4], sizes: ["1:1"], qualities: ["auto"], maxPromptLength: 4000, maxReferenceImages: 4 },
};

let sessionCalls = 0;
let resolveSession!: (value: typeof session) => void;
const client: PublicSessionClient = {
    loadSession: () => {
        sessionCalls += 1;
        return new Promise((resolve) => {
            resolveSession = resolve;
        });
    },
    loadQuota: async () => ({ ...quota, used: 3, remaining: 6 }),
};
const store = createPublicSessionStore(client);
const first = store.getState().initialize();
const second = store.getState().initialize();
assert.equal(sessionCalls, 1, "concurrent initialization is single-flight");
assert.equal(first, second, "callers share the same initialization promise");
resolveSession(session);
await first;
assert.equal(store.getState().status, "ready");
assert.deepEqual(store.getState().quota, quota);

await store.getState().refreshQuota();
assert.equal(store.getState().quota?.remaining, 6);
assert.equal(store.getState().session?.quota.remaining, 6);

const unavailable = createPublicSessionStore({
    loadSession: async () => {
        throw new Error("cookies blocked");
    },
    loadQuota: async () => quota,
});
assert.equal(await unavailable.getState().initialize(), null);
assert.equal(unavailable.getState().status, "unavailable");
assert.equal(unavailable.getState().error, "cookies blocked");

console.log("public session store tests passed");
