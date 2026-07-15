import { FileText, ImagePlus, Images, Maximize2, Settings2, Video } from "lucide-react";

import { appMode, type AppMode } from "@/lib/app-mode";

const allNavigationTools = [
    {
        slug: "canvas",
        label: "我的画布",
        icon: Maximize2,
    },
    {
        slug: "image",
        label: "生图工作台",
        icon: ImagePlus,
    },
    {
        slug: "video",
        label: "视频创作台",
        icon: Video,
    },
    {
        slug: "prompts",
        label: "提示词库",
        icon: FileText,
    },
    {
        slug: "assets",
        label: "我的素材",
        icon: Images,
    },
    {
        slug: "config",
        label: "配置",
        icon: Settings2,
    },
] as const;

export type NavigationToolSlug = (typeof allNavigationTools)[number]["slug"];

export function navigationToolsFor(mode: AppMode) {
    return mode === "public" ? allNavigationTools.filter((tool) => tool.slug === "image" || tool.slug === "prompts" || tool.slug === "assets") : [...allNavigationTools];
}

export const navigationTools = navigationToolsFor(appMode);
