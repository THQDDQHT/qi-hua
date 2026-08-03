import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type {
  GenerationReferenceManifest,
  GenerationResultManifestItem,
} from "../domain/public-generation";
import { addAigcImageLabel } from "./aigc-image-label";
import type { ProviderImage } from "./image-provider";
import type { ValidatedReference } from "./image-validation";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESULT_FILENAME_PATTERN = /^executions\/[0-9a-f-]{36}\/[0-3]\.(?:jpg|png|webp)$/i;
const REFERENCE_FILENAME_PATTERN = /^reference\.(?:jpg|png|webp)$/;

function extension(mimeType: string) {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  throw new TypeError("unsupported image mime type");
}

function validId(value: string) {
  if (!UUID_PATTERN.test(value)) throw new TypeError("invalid generation storage id");
  return value;
}

export function createGenerationStorage(rootDirectory: string) {
  const root = resolve(rootDirectory);

  function requestDirectory(requestId: string) {
    return join(root, validId(requestId));
  }

  function controlledPath(requestId: string, filename: string) {
    const requestRoot = requestDirectory(requestId);
    const target = resolve(requestRoot, filename);
    if (target !== requestRoot && !target.startsWith(`${requestRoot}${sep}`)) {
      throw new TypeError("generation storage path escaped request directory");
    }
    return target;
  }

  async function atomicWrite(target: string, bytes: Uint8Array) {
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { flag: "wx" });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async function writeReference(
    requestId: string,
    reference: ValidatedReference,
  ): Promise<GenerationReferenceManifest> {
    const filename = `reference.${extension(reference.mimeType)}`;
    await atomicWrite(controlledPath(requestId, filename), reference.bytes);
    return { filename, mimeType: reference.mimeType };
  }

  async function readReference(
    requestId: string,
    manifest: GenerationReferenceManifest,
  ): Promise<File> {
    if (!REFERENCE_FILENAME_PATTERN.test(manifest.filename)) {
      throw new TypeError("invalid reference filename");
    }
    const file = Bun.file(controlledPath(requestId, manifest.filename));
    if (!(await file.exists())) throw new Error("reference image is unavailable");
    return new File([await file.arrayBuffer()], manifest.filename, { type: manifest.mimeType });
  }

  async function writeResult(
    requestId: string,
    executionId: string,
    index: number,
    image: ProviderImage,
  ): Promise<Extract<GenerationResultManifestItem, { status: "success" }>> {
    if (!Number.isSafeInteger(index) || index < 0 || index > 3) {
      throw new TypeError("invalid generation result index");
    }
    const labeledImage = await addAigcImageLabel(image, requestId, index);
    const filename = `executions/${validId(executionId)}/${index}.${extension(labeledImage.mimeType)}`;
    await atomicWrite(controlledPath(requestId, filename), labeledImage.bytes);
    return { index, status: "success", filename, mimeType: labeledImage.mimeType };
  }

  async function openResult(
    requestId: string,
    result: Extract<GenerationResultManifestItem, { status: "success" }>,
  ) {
    if (!RESULT_FILENAME_PATTERN.test(result.filename)) {
      throw new TypeError("invalid generation result filename");
    }
    const file = Bun.file(controlledPath(requestId, result.filename));
    if (!(await file.exists())) throw new Error("generation result is unavailable");
    return file;
  }

  function removeRequest(requestId: string) {
    return rm(requestDirectory(requestId), { recursive: true, force: true });
  }

  function removeExecution(requestId: string, executionId: string) {
    return rm(controlledPath(requestId, `executions/${validId(executionId)}`), {
      recursive: true,
      force: true,
    });
  }

  async function checkReady() {
    await mkdir(root, { recursive: true });
    const filename = join(root, `.ready-${crypto.randomUUID()}`);
    try {
      await writeFile(filename, "ok", { flag: "wx" });
      if (await Bun.file(filename).text() !== "ok") throw new Error("generation storage is unreadable");
    } finally {
      await rm(filename, { force: true }).catch(() => undefined);
    }
  }

  async function findStaleRequestDirectories(olderThan: Date, limit: number) {
    await mkdir(root, { recursive: true });
    const entries = await readdir(root, { withFileTypes: true });
    const candidates: string[] = [];
    for (const entry of entries) {
      if (candidates.length >= limit) break;
      if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
      const metadata = await stat(join(root, entry.name));
      if (metadata.mtime.getTime() <= olderThan.getTime()) candidates.push(entry.name);
    }
    return candidates;
  }

  return {
    writeReference,
    readReference,
    writeResult,
    openResult,
    removeRequest,
    removeExecution,
    checkReady,
    findStaleRequestDirectories,
  };
}

export type GenerationStorage = ReturnType<typeof createGenerationStorage>;
