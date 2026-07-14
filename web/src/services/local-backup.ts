import localforage from "localforage";
import { saveAs } from "file-saver";

import { createZip } from "@/lib/zip";
import { useAssetStore } from "@/stores/use-asset-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

const imageLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });
const videoLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "video_generation_logs" });
const imageFileStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" });
const mediaFileStore = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });

export const LOCAL_BACKUP_VERSION = 1;
export const LOCAL_BACKUP_EXCLUDED = ["config", "apiKey", "password", "webdav"] as const;

type BackupBlob = {
    storageKey: string;
    blob: Blob;
};

type BackupFile = {
    storageKey: string;
    path: string;
    mimeType: string;
    bytes: number;
};

export type LocalBackupResult = {
    blob: Blob;
    fileCount: number;
    byteCount: number;
};

/** Export only the local creative data allowlist; config and credentials never enter the archive. */
export async function createLocalBackup(): Promise<LocalBackupResult> {
    await Promise.all([waitForHydration(useCanvasStore), waitForHydration(useAssetStore)]);

    const [imageLogs, videoLogs, storedBlobs] = await Promise.all([readStore(imageLogStore), readStore(videoLogStore), readAllBlobs()]);
    const canvas = useCanvasStore.getState().projects;
    const assets = useAssetStore.getState().assets;
    const files: BackupFile[] = [];
    const zipFiles: { name: string; data: BlobPart }[] = [];

    for (const { storageKey, blob } of storedBlobs) {
        const path = `files/${safeFileName(storageKey)}.${fileExtension(blob.type, storageKey)}`;
        files.push({ storageKey, path, mimeType: blob.type || "application/octet-stream", bytes: blob.size });
        zipFiles.push({ name: path, data: blob });
    }

    const data = {
        canvas: sanitize(canvas),
        assets: sanitize(assets),
        generationLogs: {
            image: sanitize(imageLogs),
            video: sanitize(videoLogs),
        },
    };
    const manifest = {
        app: "infinite-canvas" as const,
        type: "local-backup" as const,
        version: LOCAL_BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        whitelist: ["canvas", "assets", "generationLogs", "blobs"],
        excluded: LOCAL_BACKUP_EXCLUDED,
        files,
        counts: {
            projects: canvas.length,
            assets: assets.length,
            imageLogs: imageLogs.length,
            videoLogs: videoLogs.length,
            blobs: files.length,
        },
    };

    const archive = await createZip([
        { name: "manifest.json", data: JSON.stringify(manifest, null, 2) },
        { name: "data.json", data: JSON.stringify(data, null, 2) },
        ...zipFiles,
    ]);
    return { blob: archive, fileCount: files.length, byteCount: files.reduce((total, file) => total + file.bytes, 0) };
}

export async function downloadLocalBackup() {
    const result = await createLocalBackup();
    const date = new Date().toISOString().slice(0, 10);
    saveAs(result.blob, `无限画布-本地备份-${date}.zip`);
    return result;
}

async function readAllBlobs() {
    const byKey = new Map<string, Blob>();
    await Promise.all([readBlobStore(imageFileStore, byKey), readBlobStore(mediaFileStore, byKey)]);
    return Array.from(byKey, ([storageKey, blob]) => ({ storageKey, blob } satisfies BackupBlob));
}

async function readBlobStore(store: typeof imageFileStore, byKey: Map<string, Blob>) {
    await store.iterate<unknown, void>((value, key) => {
        if (isBlob(value)) byKey.set(key, value);
    });
}

async function readStore<T>(store: typeof imageLogStore) {
    const values: T[] = [];
    await store.iterate<T, void>((value) => values.push(value));
    return values;
}

function isBlob(value: unknown): value is Blob {
    return Boolean(value && typeof value === "object" && "size" in value && typeof (value as Blob).arrayBuffer === "function");
}

function sanitize<T>(value: T): T {
    if (Array.isArray(value)) return value.map((item) => sanitize(item)) as T;
    if (!value || typeof value !== "object") return value;
    const result: Record<string, unknown> = {};
    Object.entries(value).forEach(([key, item]) => {
        if (/^(?:api.?key|password|secret|token|config|webdav)$/i.test(key)) return;
        result[key] = sanitize(item);
    });
    return result as T;
}

function waitForHydration<T extends { hydrated: boolean }>(store: { getState: () => T; subscribe: (listener: (state: T) => void) => () => void }) {
    if (store.getState().hydrated) return Promise.resolve();
    return new Promise<void>((resolve) => {
        const unsubscribe = store.subscribe((state) => {
            if (!state.hydrated) return;
            unsubscribe();
            resolve();
        });
    });
}

function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_");
}

function fileExtension(mimeType: string, storageKey: string) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("webm")) return "webm";
    if (mimeType.includes("wav")) return "wav";
    if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
    return storageKey.startsWith("image:") ? "png" : "bin";
}
