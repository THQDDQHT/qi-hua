export type Prompt = {
    id: string;
    title: string;
    coverUrl: string;
    prompt: string;
    tags: string[];
    category: string;
    githubUrl: string;
    preview: string;
    createdAt: string;
    updatedAt: string;
};

type PromptSource = {
    category: string;
    githubUrl: string;
    build: () => Promise<Omit<Prompt, "category" | "githubUrl">[]>;
};

const awesomeGptImageRawBase = "https://raw.githubusercontent.com/ZeroLu/awesome-gpt-image/main";
const awesomeGpt4oImagePromptsBase = "https://raw.githubusercontent.com/ImgEdify/Awesome-GPT4o-Image-Prompts/main";
const youMindGptImage2RawBase = "https://raw.githubusercontent.com/YouMind-OpenLab/awesome-gpt-image-2/main";
const youMindNanoBananaProRawBase = "https://raw.githubusercontent.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts/main";
const davidWuGptImage2RawBase = "https://raw.githubusercontent.com/davidwuw0811-boop/awesome-gpt-image2-prompts/main";

const promptSources: PromptSource[] = [
    { category: "awesome-gpt-image", githubUrl: "https://github.com/ZeroLu/awesome-gpt-image", build: buildAwesomeGptImagePrompts },
    { category: "awesome-gpt4o-image-prompts", githubUrl: "https://github.com/ImgEdify/Awesome-GPT4o-Image-Prompts", build: buildAwesomeGpt4oImagePrompts },
    { category: "youmind-gpt-image-2", githubUrl: "https://github.com/YouMind-OpenLab/awesome-gpt-image-2", build: () => buildYouMindPrompts(youMindGptImage2RawBase, "youmind-gpt-image-2", "gpt-image-2") },
    { category: "youmind-nano-banana-pro", githubUrl: "https://github.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts", build: () => buildYouMindPrompts(youMindNanoBananaProRawBase, "youmind-nano-banana-pro", "nano-banana-pro") },
    { category: "davidwu-gpt-image2-prompts", githubUrl: "https://github.com/davidwuw0811-boop/awesome-gpt-image2-prompts", build: buildDavidWuGptImage2Prompts },
];

export const PROMPT_CATEGORIES = promptSources.map(({ category, githubUrl }) => ({ category, githubUrl }));

export async function loadRemotePrompts({ strict = false }: { strict?: boolean } = {}) {
    const settled = await Promise.all(
        promptSources.map(async (source) => {
            try {
                const items = await source.build();
                if (strict && !items.length) throw new Error(`${source.category} 未解析到提示词`);
                return items.map((item) => ({ ...item, category: source.category, githubUrl: source.githubUrl }));
            } catch (error) {
                if (strict) throw error;
                return [];
            }
        }),
    );
    return settled.flat();
}

async function buildAwesomeGptImagePrompts() {
    const markdown = await fetchText(awesomeGptImageRawBase, "README.zh-CN.md");
    const items: Omit<Prompt, "category" | "githubUrl">[] = [];
    for (const section of splitBeforeHeading(markdown, "## ")) {
        const tags = tagsFromHeading(firstMatch(section, /^##\s+(.+)$/m));
        for (const block of splitBeforeHeading(section, "### ")) {
            const title = firstMatch(block, /^###\s+(.+)$/m).replace(/\[([^\]]+)]\([^)]+\)/g, "$1").trim();
            const prompt = firstMatch(block, /\*\*提示词:\*\*\s*\r?\n\s*```[\w-]*\r?\n(.*?)\r?\n```/s).trim();
            if (!title || !prompt) continue;
            const images = extractMarkdownImages(awesomeGptImageRawBase, block);
            items.push(defaultPrompt(`awesome-gpt-image-${leftPad(items.length + 1)}`, title, prompt, images[0] || "", tags, markdownPreview(images)));
        }
    }
    return items;
}

async function buildAwesomeGpt4oImagePrompts() {
    const markdown = await fetchText(awesomeGpt4oImagePromptsBase, "README.zh-CN.md");
    const items: Omit<Prompt, "category" | "githubUrl">[] = [];
    for (const block of splitBeforeHeading(markdown, "### ")) {
        const title = firstMatch(block, /^###\s+(.+)$/m).trim();
        const prompt = firstMatch(block, /- \*\*提示词文本：\*\*\s*`(.*?)`/s).trim();
        if (!title || !prompt) continue;
        const images = extractMarkdownImages(awesomeGpt4oImagePromptsBase, block);
        items.push(defaultPrompt(`awesome-gpt4o-image-prompts-${leftPad(items.length + 1)}`, title, prompt, images[0] || "", ["gpt4o"], markdownPreview(images)));
    }
    return items;
}

async function buildYouMindPrompts(baseUrl: string, idPrefix: string, modelTag: string) {
    const markdown = await fetchText(baseUrl, "README_zh.md");
    const items: Omit<Prompt, "category" | "githubUrl">[] = [];
    for (const block of splitBeforeHeading(markdown, "### ")) {
        const title = firstMatch(block, /^###\s+No\.\s*\d+:\s*(.+)$/m).trim();
        const prompt = firstMatch(block, /#### .*?提示词\s*\r?\n\s*```[\w-]*\r?\n(.*?)\r?\n```/s).trim();
        if (!title || !prompt) continue;
        const images = extractMarkdownImages(baseUrl, block);
        items.push(defaultPrompt(`${idPrefix}-${leftPad(items.length + 1)}`, title, prompt, images[0] || "", youMindTags(title, modelTag), markdownPreview(images)));
    }
    return items;
}

async function buildDavidWuGptImage2Prompts() {
    const data = await fetchJson<Array<{ id?: number; title_en?: string; title_cn?: string; category?: string; category_cn?: string; prompt?: string; note?: string; author?: string; source?: string; needs_ref?: boolean; image?: string }>>(davidWuGptImage2RawBase, "prompts.json");
    return data
        .map((item, index) => {
            const title = (item.title_cn || item.title_en || "").trim();
            const prompt = (item.prompt || "").trim();
            if (!title || !prompt) return null;
            const image = absoluteImage(davidWuGptImage2RawBase, item.image || "");
            const preview = [item.title_en, item.note, image ? `![](${image})` : ""].filter(Boolean).join("\n\n");
            return defaultPrompt(`davidwu-gpt-image2-prompts-${leftPad(item.id || index + 1)}`, title, prompt, image, davidWuTags(item), preview);
        })
        .filter((item): item is Omit<Prompt, "category" | "githubUrl"> => Boolean(item));
}

function defaultPrompt(id: string, title: string, prompt: string, coverUrl: string, tags: string[], preview: string): Omit<Prompt, "category" | "githubUrl"> {
    return { id, title, coverUrl, prompt, tags, preview, createdAt: "", updatedAt: "" };
}

async function fetchText(baseUrl: string, file: string) {
    const response = await fetch(`${baseUrl}/${file}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`${file} 拉取失败`);
    return response.text();
}

async function fetchJson<T>(baseUrl: string, file: string) {
    return JSON.parse(await fetchText(baseUrl, file)) as T;
}

function splitBeforeHeading(markdown: string, prefix: string) {
    const blocks: string[] = [];
    let current: string[] = [];
    for (const line of markdown.split("\n")) {
        if (line.startsWith(prefix) && current.length) {
            blocks.push(current.join("\n"));
            current = [];
        }
        current.push(line);
    }
    blocks.push(current.join("\n"));
    return blocks;
}

function firstMatch(value: string, pattern: RegExp) {
    return pattern.exec(value)?.[1] || "";
}

function extractMarkdownImages(baseUrl: string, markdown: string) {
    return Array.from(markdown.matchAll(/!\[[^\]]*]\(([^)]+)\)|<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi), (match) => absoluteImage(baseUrl, match[1] || match[2])).filter(isPreviewImage);
}

function absoluteImage(baseUrl: string, image: string) {
    if (!image) return "";
    const normalizedImage = image.trim().replace(/&amp;/g, "&");
    if (/^https?:\/\//i.test(normalizedImage)) return normalizedImage;
    return `${baseUrl}/${normalizedImage.replace(/^\.?\//, "")}`;
}

function isPreviewImage(image: string) {
    return Boolean(image) && !/(?:img\.)?shields\.io|awesome\.re\/badge|badge\.(?:svg|png)/i.test(image);
}

function tagsFromCategory(category: string) {
    return splitTags(category.replace(/\s+Cases$/i, ""), /\s*(?:&|and)\s*/);
}

function tagsFromHeading(heading: string) {
    return splitTags(heading.replace(/[^\p{L}\p{N}/&、与 ]/gu, ""), /\s*(?:\/|&|、|与)\s*/);
}

function youMindTags(title: string, modelTag: string) {
    const [, prefix] = title.match(/^(.+?) - /) || [];
    return [modelTag, ...tagsFromHeading(prefix || "")];
}

function davidWuTags(item: { category_cn?: string; category?: string; author?: string; source?: string; needs_ref?: boolean }) {
    const tags = splitTags(item.category_cn || item.category || "", /\//);
    if (item.needs_ref) tags.push("需要参考图");
    return tags;
}

function splitTags(value: string, pattern: RegExp) {
    return value
        .split(pattern)
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean);
}

function markdownPreview(images: string[]) {
    return images.filter(Boolean).map((image) => `![](${image})`).join("\n\n");
}

function leftPad(value: number) {
    return String(value).padStart(4, "0");
}
