const port = Number(process.env.MOCK_API_PORT || 3001);
const imageData = Buffer.from(await Bun.file(new URL("../public/icons/icon-192.png", import.meta.url)).arrayBuffer()).toString("base64");
const quota = {
    limit: 10,
    used: 0,
    reserved: 0,
    remaining: 10,
    resetAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
};
const qualities = new Set(["auto", "high", "medium", "low"]);
const presetSizes = new Set(["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "2048x2048", "2048x1152", "1152x2048", "3840x2160", "2160x3840", "auto"]);

const session = {
    mode: "public",
    quota,
    generation: {
        enabled: true,
        modelLabel: "模拟生图",
        maxPromptLength: 4000,
        maxReferenceImages: 4,
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
        prompt: form.get("prompt"),
        count: Number(form.get("count")),
        size: form.get("size"),
        quality: form.get("quality"),
    };
}

async function generate(request, edits) {
    let input;
    try {
        input = await readGenerationInput(request, edits);
    } catch {
        return json({ error: { code: "INVALID_REQUEST", message: "模拟请求格式无效" } }, 400);
    }
    if (!String(input.prompt || "").trim() || !Number.isInteger(input.count) || input.count < 1 || input.count > 4 || !validSize(input.size) || !qualities.has(input.quality)) {
        return json({ error: { code: "INVALID_REQUEST", message: "模拟请求参数无效" } }, 400);
    }
    return json({
        status: "completed",
        replayed: false,
        results: Array.from({ length: input.count }, (_, index) => ({ index, status: "success", image: { mimeType: "image/png", data: imageData } })),
        quota,
    });
}

Bun.serve({
    port,
    fetch(request) {
        const { pathname } = new URL(request.url);
        if (request.method === "GET" && pathname === "/api/session") return json(session);
        if (request.method === "GET" && pathname === "/api/quota") return json(quota);
        if (request.method === "POST" && pathname === "/api/images/generations") return generate(request, false);
        if (request.method === "POST" && pathname === "/api/images/edits") return generate(request, true);
        return json({ error: { code: "NOT_FOUND", message: "模拟接口不存在" } }, 404);
    },
});

console.log(`Mock public API listening on http://localhost:${port}`);
