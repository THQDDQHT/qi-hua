const port = Number(process.env.MOCK_API_PORT || 3001);
const imageBytes = new Uint8Array(await Bun.file(new URL("../public/icons/icon-192.png", import.meta.url)).arrayBuffer());
const quota = {
    limit: 10,
    used: 0,
    reserved: 0,
    remaining: 10,
    resetAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
};
const qualities = new Set(["auto", "high", "medium", "low"]);
const presetSizes = new Set(["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "2048x2048", "2048x1152", "1152x2048", "3840x2160", "2160x3840", "auto"]);
const tasks = new Map();
const requestTasks = new Map();

const session = {
    mode: "public",
    quota,
    generation: {
        enabled: true,
        modelLabel: "模拟生图",
        maxPromptLength: 4000,
        maxReferenceImages: 1,
    },
};

const json = (body, status = 200) =>
    Response.json(body, {
        status,
        headers: { "cache-control": "no-store" },
    });

function validSize(value) {
    if (presetSizes.has(value)) return true;
    const match = String(value || "").match(/^([1-9]\d*)x([1-9]\d*)$/);
    if (!match) return false;
    const width = Number(match[1]);
    const height = Number(match[2]);
    return Math.max(width, height) <= 3840 && width * height <= 8_294_400;
}

async function readGenerationInput(request, edits) {
    if (!edits) return request.json();
    const form = await request.formData();
    return {
        requestKey: form.get("requestKey"),
        prompt: form.get("prompt"),
        count: Number(form.get("count")),
        size: form.get("size"),
        quality: form.get("quality"),
        references: form.getAll("references"),
    };
}

async function createTask(request, edits) {
    let input;
    try {
        input = await readGenerationInput(request, edits);
    } catch {
        return json({ error: { code: "INVALID_REQUEST", message: "模拟请求格式无效" } }, 400);
    }
    if (!String(input.requestKey || "").trim() || !String(input.prompt || "").trim() || !Number.isInteger(input.count) || input.count < 1 || input.count > 4 || !validSize(input.size) || !qualities.has(input.quality)) {
        return json({ error: { code: "INVALID_REQUEST", message: "模拟请求参数无效" } }, 400);
    }
    if (edits && !input.references.length) return json({ error: { code: "INVALID_IMAGE", message: "至少需要一张参考图" } }, 400);
    if (edits && input.references.length > 1) return json({ error: { code: "REQUEST_TOO_LARGE", message: "参考图最多 1 张" } }, 413);

    const existingTaskId = requestTasks.get(input.requestKey);
    const existing = existingTaskId ? tasks.get(existingTaskId) : null;
    if (existing) {
        return json({ taskId: existing.id, status: existing.status, replayed: true, expiresAt: existing.expiresAt, pollAfterMs: 250 }, 202);
    }

    const id = crypto.randomUUID();
    const task = {
        id,
        count: input.count,
        status: "queued",
        polls: 0,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    };
    tasks.set(id, task);
    requestTasks.set(input.requestKey, id);
    return json({ taskId: id, status: task.status, replayed: false, expiresAt: task.expiresAt, pollAfterMs: 250 }, 202);
}

function taskState(task) {
    task.polls += 1;
    if (task.polls === 1) {
        task.status = "running";
        return { taskId: task.id, status: task.status, expiresAt: task.expiresAt, pollAfterMs: 250 };
    }
    task.status = "completed";
    return {
        taskId: task.id,
        status: task.status,
        expiresAt: task.expiresAt,
        results: Array.from({ length: task.count }, (_, index) => ({
            index,
            status: "success",
            image: { mimeType: "image/png", url: `/api/images/tasks/${encodeURIComponent(task.id)}/results/${index}` },
        })),
        quota,
    };
}

Bun.serve({
    port,
    async fetch(request) {
        const { pathname } = new URL(request.url);
        if (request.method === "GET" && pathname === "/api/session") return json(session);
        if (request.method === "GET" && pathname === "/api/quota") return json(quota);
        if (request.method === "POST" && pathname === "/api/images/generations") return createTask(request, false);
        if (request.method === "POST" && pathname === "/api/images/edits") return createTask(request, true);

        const resultMatch = pathname.match(/^\/api\/images\/tasks\/([^/]+)\/results\/(\d+)$/);
        if (request.method === "GET" && resultMatch) {
            const task = tasks.get(decodeURIComponent(resultMatch[1]));
            const index = Number(resultMatch[2]);
            if (!task || task.status !== "completed" || !Number.isInteger(index) || index < 0 || index >= task.count) {
                return json({ error: { code: "NOT_FOUND", message: "模拟图片不存在" } }, 404);
            }
            return new Response(imageBytes, { headers: { "cache-control": "no-store", "content-type": "image/png" } });
        }

        const taskMatch = pathname.match(/^\/api\/images\/tasks\/([^/]+)$/);
        if (request.method === "GET" && taskMatch) {
            const task = tasks.get(decodeURIComponent(taskMatch[1]));
            return task ? json(taskState(task)) : json({ error: { code: "NOT_FOUND", message: "模拟任务不存在" } }, 404);
        }
        return json({ error: { code: "NOT_FOUND", message: "模拟接口不存在" } }, 404);
    },
});

console.log(`Mock public API listening on http://localhost:${port}`);
