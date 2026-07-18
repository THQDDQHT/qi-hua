import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

import { loadRemotePrompts, type Prompt } from "../../../web/src/services/api/prompt-sources";

const sharp = createRequire(join(process.cwd(), "package.json"))("sharp");
const dataDirectory = process.env.PROMPT_LIBRARY_DIR || "/data/prompt-library";
const coversDirectory = join(dataDirectory, "covers");
const manifestPath = join(dataDirectory, "manifest.json");
const promptsPath = join(dataDirectory, "prompts.json");
const allowedHosts = new Set([
    "github.com",
    "raw.githubusercontent.com",
    "pbs.twimg.com",
    "cdn.imgedify.com",
    "cms-assets.youmind.com",
    "marketing-assets.youmind.com",
]);
const concurrency = 6;
const timeoutMs = 45_000;
const maxAttempts = 3;
const maxImageBytes = 25 * 1024 * 1024;

type ManifestImage = {
    sourceUrl: string;
    localUrl: string;
    sha256: string;
};

type Manifest = {
    version: 1;
    generatedAt: string;
    images: Record<string, ManifestImage>;
};

await mkdir(coversDirectory, { recursive: true });

const previousManifest = await readManifest();
const remotePrompts = await loadRemotePrompts({ strict: true });
const sourceUrls = Array.from(new Set(remotePrompts.map((item) => item.coverUrl).filter(Boolean)));
const syncedImages = new Map<string, ManifestImage>();

await runWithConcurrency(sourceUrls, concurrency, async (sourceUrl, index) => {
    const reused = await reuseImage(sourceUrl, previousManifest.images[sourceUrl]);
    const image = reused || (await downloadImage(sourceUrl));
    syncedImages.set(sourceUrl, image);
    console.log(`[${index + 1}/${sourceUrls.length}] ${reused ? "复用" : "下载"} ${sourceUrl}`);
});

const prompts = remotePrompts.map((prompt) => localizePrompt(prompt, syncedImages.get(prompt.coverUrl)?.localUrl || ""));
const manifest: Manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    images: Object.fromEntries(sourceUrls.map((sourceUrl) => [sourceUrl, syncedImages.get(sourceUrl)!])),
};

await writeLibraryAtomically(prompts, manifest);
console.log(`提示词库同步完成：${prompts.length} 条提示词，${sourceUrls.length} 张本地封面，${prompts.filter((item) => !item.coverUrl).length} 条无封面。`);

async function readManifest(): Promise<Manifest> {
    try {
        const value = JSON.parse(await readFile(manifestPath, "utf8")) as Partial<Manifest>;
        if (value.version === 1 && value.images && typeof value.images === "object") return value as Manifest;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("现有提示词清单不可用，将重新同步全部封面。", error);
    }
    return { version: 1, generatedAt: "", images: {} };
}

async function reuseImage(sourceUrl: string, image?: ManifestImage) {
    if (!image || image.sourceUrl !== sourceUrl || !/^\/prompt-library\/covers\/[a-f0-9]{64}\.webp$/.test(image.localUrl)) return null;
    const fileName = image.localUrl.slice("/prompt-library/covers/".length);
    try {
        await access(join(coversDirectory, fileName));
        return image;
    } catch {
        return null;
    }
}

async function downloadImage(sourceUrl: string): Promise<ManifestImage> {
    validateSourceUrl(sourceUrl);
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            const input = await fetchImage(sourceUrl);
            const output = await sharp(input, { failOn: "error", limitInputPixels: 40_000_000 }).rotate().resize(640, 480, { fit: "cover" }).webp({ quality: 76, effort: 4 }).toBuffer();
            const sha256 = createHash("sha256").update(output).digest("hex");
            const fileName = `${sha256}.webp`;
            await writeFileAtomically(join(coversDirectory, fileName), output);
            return { sourceUrl, localUrl: `/prompt-library/covers/${fileName}`, sha256 };
        } catch (error) {
            lastError = error;
            if (attempt < maxAttempts) await Bun.sleep(attempt * 1_000);
        }
    }
    throw new Error(`封面同步失败：${sourceUrl}`, { cause: lastError });
}

function validateSourceUrl(sourceUrl: string) {
    const url = new URL(sourceUrl);
    if (url.protocol !== "https:" || !allowedHosts.has(url.hostname.toLowerCase())) throw new Error(`不允许下载此图片地址：${sourceUrl}`);
}

async function fetchImage(sourceUrl: string) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(sourceUrl, { cache: "no-store", redirect: "follow", signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const contentLength = Number(response.headers.get("content-length") || 0);
        if (contentLength > maxImageBytes) throw new Error("图片超过 25MB 上限");
        if (!response.body) throw new Error("图片响应为空");

        const chunks: Uint8Array[] = [];
        const reader = response.body.getReader();
        let size = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxImageBytes) {
                await reader.cancel();
                throw new Error("图片超过 25MB 上限");
            }
            chunks.push(value);
        }

        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return bytes;
    } finally {
        clearTimeout(timeout);
    }
}

function localizePrompt(prompt: Prompt, localUrl: string): Prompt {
    const previewText = prompt.preview
        .replace(/!\[[^\]]*]\([^)]+\)/g, "")
        .replace(/<img\b[^>]*>/gi, "")
        .trim();
    return {
        ...prompt,
        coverUrl: localUrl,
        preview: [previewText, localUrl ? `![](${localUrl})` : ""].filter(Boolean).join("\n\n"),
    };
}

async function runWithConcurrency<T>(items: T[], limit: number, task: (item: T, index: number) => Promise<void>) {
    let nextIndex = 0;
    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (nextIndex < items.length) {
                const index = nextIndex;
                nextIndex += 1;
                await task(items[index], index);
            }
        }),
    );
}

async function writeLibraryAtomically(prompts: Prompt[], manifest: Manifest) {
    const suffix = `${process.pid}-${Date.now()}`;
    const manifestTempPath = `${manifestPath}.${suffix}.tmp`;
    const promptsTempPath = `${promptsPath}.${suffix}.tmp`;
    try {
        await Promise.all([
            writeFile(manifestTempPath, `${JSON.stringify(manifest, null, 2)}\n`),
            writeFile(promptsTempPath, `${JSON.stringify({ version: 1, generatedAt: manifest.generatedAt, items: prompts })}\n`),
        ]);
        await rename(manifestTempPath, manifestPath);
        await rename(promptsTempPath, promptsPath);
    } finally {
        await Promise.all([unlink(manifestTempPath).catch(() => undefined), unlink(promptsTempPath).catch(() => undefined)]);
    }
}

async function writeFileAtomically(path: string, content: Uint8Array) {
    try {
        await access(path);
        return;
    } catch {
        const tempPath = `${path}.${process.pid}-${randomUUID()}.tmp`;
        try {
            await writeFile(tempPath, content);
            await rename(tempPath, path);
        } finally {
            await unlink(tempPath).catch(() => undefined);
        }
    }
}
