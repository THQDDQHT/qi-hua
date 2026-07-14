export type AppMode = "public" | "self-hosted";

export type AppCapability =
    | "imageGeneration"
    | "canvas"
    | "assets"
    | "prompts"
    | "videoGeneration"
    | "audioGeneration"
    | "textGeneration"
    | "webdav"
    | "agent"
    | "channelConfig";

const capabilityMatrix: Record<AppMode, Readonly<Record<AppCapability, boolean>>> = {
    public: {
        imageGeneration: true,
        canvas: true,
        assets: true,
        prompts: true,
        videoGeneration: false,
        audioGeneration: false,
        textGeneration: false,
        webdav: false,
        agent: false,
        channelConfig: false,
    },
    "self-hosted": {
        imageGeneration: true,
        canvas: true,
        assets: true,
        prompts: true,
        videoGeneration: true,
        audioGeneration: true,
        textGeneration: true,
        webdav: true,
        agent: true,
        channelConfig: true,
    },
};

export function resolveAppMode(value: unknown): AppMode {
    return value === "public" ? "public" : "self-hosted";
}

export function capabilitiesFor(mode: AppMode) {
    return capabilityMatrix[mode];
}

export function hasCapability(capability: AppCapability, mode: AppMode = appMode) {
    return capabilityMatrix[mode][capability];
}

export const appMode = resolveAppMode(import.meta.env.VITE_APP_MODE);
export const appCapabilities = capabilitiesFor(appMode);
