import assert from "node:assert/strict";

import { createImageGenerationFacade } from "../src/services/image-generation";

const quota = {
    limit: 10,
    used: 1,
    reserved: 0,
    remaining: 9,
    resetAt: "2026-07-19T00:00:00.000Z",
};

const generationInput = {
    requestKey: "request-key",
    prompt: "一只猫",
    count: 1,
    size: "1:1",
    quality: "high",
};

function publicFacade(fetch: typeof globalThis.fetch, pollDelaysMs: readonly number[] = [0]) {
    return createImageGenerationFacade({
        mode: "public",
        fetch,
        requestGeneration: async () => [],
        requestEdit: async () => [],
        pollDelaysMs,
    });
}

function pathOf(input: RequestInfo | URL) {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.pathname;
    return new URL(input.url).pathname;
}

{
    let calls = 0;
    const facade = publicFacade((async () => {
        calls += 1;
        return Response.json({
            status: "completed",
            replayed: false,
            results: [{ index: 0, status: "success", image: { mimeType: "image/png", data: "AQID" } }],
            quota,
        });
    }) as typeof fetch);

    const batch = await facade.generateImages(generationInput);
    assert.equal(calls, 1, "旧同步协议只发送一次请求");
    assert.equal(batch.results[0]?.image?.dataUrl, "data:image/png;base64,AQID");
    assert.deepEqual(batch.quota, quota);
}

{
    let getCalls = 0;
    const facade = publicFacade((async (input, init) => {
        const path = pathOf(input);
        if (init?.method === "POST") {
            return Response.json({ taskId: "async-task", status: "queued", replayed: false, expiresAt: "2099-01-01T00:00:00.000Z", pollAfterMs: 0 }, { status: 202 });
        }
        assert.equal(path, "/api/images/tasks/async-task");
        getCalls += 1;
        if (getCalls === 1) return Response.json({ taskId: "async-task", status: "queued", pollAfterMs: 0 });
        if (getCalls === 2) return Response.json({ taskId: "async-task", status: "running", pollAfterMs: 0 });
        return Response.json({
            taskId: "async-task",
            status: "completed",
            results: [{ index: 0, status: "success", image: { mimeType: "image/webp", data: "BAUG" } }],
            quota,
        });
    }) as typeof fetch);

    const batch = await facade.generateImages(generationInput);
    assert.equal(getCalls, 3, "异步协议持续查询至终态");
    assert.equal(batch.results[0]?.image?.dataUrl, "data:image/webp;base64,BAUG");
    assert.equal(batch.replayed, false, "提交响应的重放标记传递到最终结果");
}

{
    let taskGets = 0;
    const facade = publicFacade((async (input) => {
        assert.equal(pathOf(input), "/api/images/tasks/shared-task");
        taskGets += 1;
        if (taskGets === 1) return Response.json({ taskId: "shared-task", status: "running", pollAfterMs: 0 });
        return Response.json({ taskId: "shared-task", status: "completed", results: [{ index: 0, status: "failed", errorCode: "PROVIDER_REJECTED" }], quota });
    }) as typeof fetch);

    const [first, second] = await Promise.all([facade.resumePublicGeneration("shared-task"), facade.resumePublicGeneration("shared-task")]);
    assert.equal(taskGets, 2, "同一任务的并发恢复共享一条轮询链");
    assert.deepEqual(first, second);
}

{
    let taskGets = 0;
    const facade = publicFacade((async (input) => {
        assert.equal(pathOf(input), "/api/images/tasks/retry-task");
        taskGets += 1;
        if (taskGets === 1) return Response.json({ error: { code: "TEMPORARY", message: "edge timeout" } }, { status: 524 });
        if (taskGets === 2) throw new TypeError("network unavailable");
        if (taskGets === 3) return Response.json({ error: { code: "RATE_LIMITED", message: "slow down" } }, { status: 429 });
        return Response.json({ taskId: "retry-task", status: "completed", results: [], quota });
    }) as typeof fetch);

    await facade.resumePublicGeneration("retry-task");
    assert.equal(taskGets, 4, "网络错误、524 和 429 都会继续轮询");
}

{
    let taskGets = 0;
    const facade = publicFacade((async () => {
        taskGets += 1;
        return Response.json({ error: { code: "NOT_FOUND", message: "任务不存在" } }, { status: 404 });
    }) as typeof fetch);

    await assert.rejects(facade.resumePublicGeneration("missing-task"), (error: unknown) => error instanceof Error && error.message === "任务不存在");
    assert.equal(taskGets, 1, "普通 4xx 不重试");
}

{
    let taskGets = 0;
    const facade = publicFacade((async () => {
        taskGets += 1;
        return Response.json({ taskId: "abort-task", status: "running", pollAfterMs: 100 });
    }) as typeof fetch, [100]);
    const controller = new AbortController();
    const pending = facade.resumePublicGeneration("abort-task", { signal: controller.signal });
    while (taskGets === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();

    await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
    const callsAfterAbort = taskGets;
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(taskGets, callsAfterAbort, "取消等待后不再查询任务");
}

{
    const methods: string[] = [];
    const requestedPaths: string[] = [];
    const facade = publicFacade((async (input, init) => {
        methods.push(init?.method || "GET");
        requestedPaths.push(pathOf(input));
        if (pathOf(input) === "/api/images/tasks/recovered-task") {
            return Response.json({
                taskId: "recovered-task",
                status: "completed",
                results: [
                    { index: 0, status: "success", image: { mimeType: "image/png", url: "/api/images/tasks/recovered-task/results/0" } },
                    { index: 1, status: "success", image: { mimeType: "image/png", url: "/api/images/tasks/recovered-task/results/1" } },
                ],
                quota,
            });
        }
        return new Response(new Uint8Array(pathOf(input).endsWith("/0") ? [1, 2, 3] : [4, 5, 6]), { headers: { "Content-Type": "image/png" } });
    }) as typeof fetch);

    const batch = await facade.resumePublicGeneration("recovered-task");
    assert.deepEqual(methods, ["GET", "GET", "GET"], "恢复任务只发送 GET");
    assert.deepEqual(requestedPaths, ["/api/images/tasks/recovered-task", "/api/images/tasks/recovered-task/results/0", "/api/images/tasks/recovered-task/results/1"]);
    assert.equal(batch.results[0]?.image?.dataUrl, "data:image/png;base64,AQID");
    assert.equal(batch.results[1]?.image?.dataUrl, "data:image/png;base64,BAUG");
}

{
    const requestedPaths: string[] = [];
    const facade = publicFacade((async (input) => {
        requestedPaths.push(pathOf(input));
        return Response.json({
            taskId: "safe-task",
            status: "completed",
            results: [{ index: 0, status: "success", image: { mimeType: "image/png", url: "/api/images/tasks/another-task/results/0" } }],
            quota,
        });
    }) as typeof fetch);

    await assert.rejects(facade.resumePublicGeneration("safe-task"), /不受信任的图片地址/);
    assert.deepEqual(requestedPaths, ["/api/images/tasks/safe-task"], "错误图片地址不能触发第二次请求");
}

{
    let imageGets = 0;
    const facade = publicFacade((async (input) => {
        const path = pathOf(input);
        if (path === "/api/images/tasks/image-retry-task") {
            return Response.json({
                taskId: "image-retry-task",
                status: "completed",
                results: [{ index: 0, status: "success", image: { mimeType: "image/png", url: "/api/images/tasks/image-retry-task/results/0" } }],
                quota,
            });
        }
        imageGets += 1;
        if (imageGets === 1) return Response.json({ error: { code: "TEMPORARY", message: "暂时不可用" } }, { status: 503 });
        return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/png" } });
    }) as typeof fetch);

    const batch = await facade.resumePublicGeneration("image-retry-task");
    assert.equal(imageGets, 2, "图片结果暂时失败后会重试");
    assert.equal(batch.results[0]?.image?.dataUrl, "data:image/png;base64,AQID");
}

for (const testCase of [
    {
        taskId: "large-image-task",
        response: () => new Response(new Uint8Array([1]), { headers: { "Content-Length": String(16 * 1024 * 1024 + 1), "Content-Type": "image/png" } }),
        error: /16MiB/,
    },
    {
        taskId: "invalid-mime-task",
        response: () => new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/gif" } }),
        error: /仅支持 JPEG、PNG 或 WebP/,
    },
]) {
    const facade = publicFacade((async (input) => {
        const path = pathOf(input);
        if (path === `/api/images/tasks/${testCase.taskId}`) {
            return Response.json({
                taskId: testCase.taskId,
                status: "completed",
                results: [{ index: 0, status: "success", image: { mimeType: "image/png", url: `/api/images/tasks/${testCase.taskId}/results/0` } }],
                quota,
            });
        }
        return testCase.response();
    }) as typeof fetch);

    await assert.rejects(facade.resumePublicGeneration(testCase.taskId), testCase.error);
}

{
    let taskGets = 0;
    const facade = publicFacade((async () => {
        taskGets += 1;
        if (taskGets === 1) return Response.json({ taskId: "shared-abort-task", status: "running", pollAfterMs: 20 });
        return Response.json({
            taskId: "shared-abort-task",
            status: "completed",
            results: [{ index: 0, status: "success", image: { mimeType: "image/png", data: "AQID" } }],
            quota,
        });
    }) as typeof fetch, [20]);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = facade.resumePublicGeneration("shared-abort-task", { signal: firstController.signal });
    const second = facade.resumePublicGeneration("shared-abort-task", { signal: secondController.signal });
    while (taskGets === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    firstController.abort();

    await assert.rejects(first, (error: unknown) => error instanceof Error && error.name === "AbortError");
    const batch = await second;
    assert.equal(taskGets, 2, "取消一个订阅者不会中止共享轮询");
    assert.equal(batch.results[0]?.status, "success");
}

{
    let publicFetchCalls = 0;
    let localGenerationCalls = 0;
    const facade = createImageGenerationFacade({
        mode: "self-hosted",
        fetch: (async () => {
            publicFetchCalls += 1;
            throw new Error("不应调用公众接口");
        }) as typeof fetch,
        requestGeneration: async () => {
            localGenerationCalls += 1;
            return [{ id: "local-image", dataUrl: "data:image/png;base64,AQID" }];
        },
        requestEdit: async () => [],
    });

    const batch = await facade.generateImages({ ...generationInput, selfHostedConfig: {} as never });
    assert.equal(publicFetchCalls, 0);
    assert.equal(localGenerationCalls, 1);
    assert.equal(batch.results[0]?.image?.id, "local-image");
}

console.log("async image generation tests passed");
