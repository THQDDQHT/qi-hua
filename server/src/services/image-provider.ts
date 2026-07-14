import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import type { ServerConfig } from "../config";
import { PublicGenerationError } from "../domain/public-generation";

export type ProviderImage = {
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  data: string;
};

export interface ImageProvider {
  generateSlot(input: {
    prompt: string;
    size: string;
    quality: string;
    signal: AbortSignal;
  }): Promise<ProviderImage>;
  editSlot(input: {
    prompt: string;
    size: string;
    quality: string;
    references: File[];
    signal: AbortSignal;
  }): Promise<ProviderImage>;
}

const MAX_PROVIDER_RESPONSE_BYTES = 24 * 1024 * 1024;
const MAX_PROVIDER_IMAGE_BYTES = 16 * 1024 * 1024;

type Fetcher = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;
type ProviderResponse = { data?: Array<{ b64_json?: unknown }> };

function endpoint(baseUrl: string, path: string) {
  const normalized = baseUrl.replace(/\/+$/, "");
  return `${/(?:\/v1|\/api\/v3|\/api\/plan\/v3)$/i.test(normalized) ? normalized : `${normalized}/v1`}${path}`;
}

function providerError(
  code: "PROVIDER_REJECTED" | "PROVIDER_TIMEOUT" | "SERVICE_UNAVAILABLE",
): never {
  throw new PublicGenerationError(code);
}

async function readLimitedBody(response: Response) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_PROVIDER_RESPONSE_BYTES) {
    providerError("SERVICE_UNAVAILABLE");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PROVIDER_RESPONSE_BYTES) {
      await reader.cancel();
      providerError("SERVICE_UNAVAILABLE");
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  chunks.forEach((chunk) => {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return new TextDecoder().decode(body);
}

function decodeBase64(value: string) {
  const normalized = value.replace(/\s/g, "");
  if (!normalized || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    providerError("SERVICE_UNAVAILABLE");
  }
  const bytes = Uint8Array.from(Buffer.from(normalized, "base64"));
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_PROVIDER_IMAGE_BYTES) {
    providerError("SERVICE_UNAVAILABLE");
  }
  return bytes;
}

async function parseProviderResponse(response: Response): Promise<ProviderImage> {
  if (!response.ok) {
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      providerError("PROVIDER_REJECTED");
    }
    providerError("SERVICE_UNAVAILABLE");
  }

  let payload: ProviderResponse;
  try {
    payload = JSON.parse(await readLimitedBody(response)) as ProviderResponse;
  } catch (error) {
    if (error instanceof PublicGenerationError) throw error;
    providerError("SERVICE_UNAVAILABLE");
  }

  const data = payload.data?.[0]?.b64_json;
  if (typeof data !== "string") providerError("SERVICE_UNAVAILABLE");
  const bytes = decodeBase64(data);
  const detected = await fileTypeFromBuffer(bytes);
  if (
    detected?.mime !== "image/jpeg"
    && detected?.mime !== "image/png"
    && detected?.mime !== "image/webp"
  ) {
    providerError("SERVICE_UNAVAILABLE");
  }
  try {
    await sharp(bytes, { failOn: "error" }).metadata();
  } catch {
    providerError("SERVICE_UNAVAILABLE");
  }
  return { mimeType: detected.mime, data };
}

export function createImageProvider(
  config: Pick<ServerConfig, "aiBaseUrl" | "aiApiKey" | "aiModel">,
  fetcher: Fetcher = fetch,
): ImageProvider {
  async function execute(url: string, body: BodyInit, signal: AbortSignal) {
    try {
      const response = await fetcher(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.aiApiKey}`,
          ...(typeof body === "string" ? { "Content-Type": "application/json" } : {}),
        },
        body,
        signal,
      });
      return await parseProviderResponse(response);
    } catch (error) {
      if (error instanceof PublicGenerationError) throw error;
      if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        providerError("PROVIDER_TIMEOUT");
      }
      providerError("SERVICE_UNAVAILABLE");
    }
  }

  return {
    generateSlot(input) {
      return execute(
        endpoint(config.aiBaseUrl, "/images/generations"),
        JSON.stringify({
          model: config.aiModel,
          prompt: input.prompt,
          n: 1,
          size: input.size,
          quality: input.quality,
          response_format: "b64_json",
        }),
        input.signal,
      );
    },
    editSlot(input) {
      const body = new FormData();
      body.set("model", config.aiModel);
      body.set("prompt", input.prompt);
      body.set("n", "1");
      body.set("size", input.size);
      body.set("quality", input.quality);
      body.set("response_format", "b64_json");
      input.references.forEach((reference) => body.append("image", reference));
      return execute(endpoint(config.aiBaseUrl, "/images/edits"), body, input.signal);
    },
  };
}
