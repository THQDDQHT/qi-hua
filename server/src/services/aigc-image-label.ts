import { createHash } from "node:crypto";
import sharp from "sharp";
import type { ProviderImage } from "./image-provider";

const CONTENT_PRODUCER = "Qihua";

function createProduceId(requestId: string, index: number) {
  return createHash("sha256").update(`${requestId}:${index}`).digest("hex").slice(0, 32);
}

function createAigcMetadata(requestId: string, index: number) {
  const produceId = createProduceId(requestId, index);
  return JSON.stringify({
    Label: "1",
    ContentProducer: CONTENT_PRODUCER,
    ProduceID: produceId,
    ReservedCode1: "",
    ContentPropagator: CONTENT_PRODUCER,
    PropagateID: produceId,
    ReservedCode2: "",
  });
}

function createXmp(metadata: string) {
  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
    <x:xmpmeta xmlns:x="adobe:ns:meta/">
      <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
        <rdf:Description rdf:about="" xmlns:TC260="http://www.tc260.org.cn/ns/AIGC/1.0/">
          <TC260:AIGC>${metadata}</TC260:AIGC>
        </rdf:Description>
      </rdf:RDF>
    </x:xmpmeta>
  <?xpacket end="w"?>`;
}

export async function addAigcImageLabel(
  image: ProviderImage,
  requestId: string,
  index: number,
): Promise<ProviderImage> {
  const inputMetadata = await sharp(image.bytes, { failOn: "error" }).metadata();
  if (!inputMetadata.width || !inputMetadata.height) throw new Error("generated image has no dimensions");

  const metadata = createAigcMetadata(requestId, index);
  const output = sharp(image.bytes, { failOn: "error" })
    .rotate()
    .withXmp(createXmp(metadata));

  if (image.mimeType === "image/png") {
    const bytes = await output.png({ compressionLevel: 9 }).toBuffer();
    return { mimeType: image.mimeType, bytes };
  }

  const bytes = image.mimeType === "image/jpeg"
    ? await output.jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer()
    : await output.webp({ quality: 95 }).toBuffer();
  return { mimeType: image.mimeType, bytes };
}
