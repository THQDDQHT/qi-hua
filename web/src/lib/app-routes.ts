import type { AppMode } from "./app-mode";

export type AppRouteId = "home" | "image" | "video" | "assets" | "prompts" | "canvas" | "canvas-project" | "config";

export type AppRouteDefinition = {
    id: AppRouteId;
    path: string;
};

const selfHostedRoutes: readonly AppRouteDefinition[] = [
    { id: "home", path: "/" },
    { id: "image", path: "/image" },
    { id: "video", path: "/video" },
    { id: "assets", path: "/assets" },
    { id: "prompts", path: "/prompts" },
    { id: "canvas", path: "/canvas" },
    { id: "canvas-project", path: "/canvas/:id" },
    { id: "config", path: "/config" },
];

const publicRoutes: readonly AppRouteDefinition[] = [
    { id: "home", path: "/" },
    { id: "image", path: "/image" },
    { id: "assets", path: "/assets" },
    { id: "prompts", path: "/prompts" },
];

export function routesFor(mode: AppMode): readonly AppRouteDefinition[] {
    return mode === "public" ? publicRoutes : selfHostedRoutes;
}
