import { createHmac } from "node:crypto";
import type { GenerationInput, ValidatedReference } from "./image-validation";

export type GenerationOperation = "generation" | "edit";

const PREFIX = new TextEncoder().encode("infinite-canvas/public-image-idempotency/v1\0");

function field(value: string) {
  const bytes = new TextEncoder().encode(value);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, bytes.byteLength, false);
  return [length, bytes];
}

export function createGenerationFingerprint(input: {
  secret: string;
  operation: GenerationOperation;
  generation: GenerationInput;
  references?: readonly ValidatedReference[];
}): Uint8Array {
  const references = input.references ?? [];
  if (input.operation === "generation" && references.length !== 0) {
    throw new TypeError("generation 指纹不能包含参考图");
  }
  if (input.operation === "edit" && references.length === 0) {
    throw new TypeError("edit 指纹必须包含参考图");
  }

  const chunks = [
    PREFIX,
    ...field(input.operation),
    ...field(input.generation.prompt),
    Uint8Array.of(input.generation.count),
    ...field(input.generation.size),
    ...field(input.generation.quality),
    Uint8Array.of(references.length),
    ...references.map((reference) => reference.digest),
  ];

  const hmac = createHmac("sha256", input.secret);
  chunks.forEach((chunk) => hmac.update(chunk));
  return hmac.digest();
}
