import zlib from "node:zlib";
import type {
  AiClient,
  AiImageRequest,
  AiImageResponse,
  AiRequest,
  AiResponse,
} from "@/lib/ai";
import type { DbHandle } from "@/lib/db/client";
import type { EditorialContract, StyleProfile } from "@/lib/db/schema";
import { confirmStyleProfile, saveContract } from "@/lib/repo/editorial";
import { createProject } from "@/lib/repo/projects";
import { insertText } from "@/lib/repo/texts";

/** Records every request and answers via the provided responder. */
export class FakeAiClient implements AiClient {
  requests: AiRequest[] = [];
  imageRequests: AiImageRequest[] = [];

  constructor(
    private responder: (req: AiRequest, callIndex: number) => string,
    /** Image bytes for generateImage; defaults to a small valid PNG. */
    private imageResponder: (req: AiImageRequest) => Buffer = () => fakePng(1024, 768),
  ) {}

  async complete(request: AiRequest): Promise<AiResponse> {
    const text = this.responder(request, this.requests.length);
    this.requests.push(request);
    return {
      text,
      model: "fake/model",
      usage: { promptTokens: 10, completionTokens: 10, costUsd: 0.001 },
    };
  }

  async generateImage(request: AiImageRequest): Promise<AiImageResponse> {
    const data = this.imageResponder(request);
    this.imageRequests.push(request);
    return {
      data,
      mimeType: "image/png",
      model: "fake/image-model",
      usage: { promptTokens: 20, completionTokens: 0, costUsd: 0.01 },
    };
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/** A minimal but valid RGBA PNG of the given pixel size (solid grey). */
export function fakePng(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    for (let x = 0; x < width; x++) {
      const p = rowStart + 1 + x * 4;
      raw[p] = 200;
      raw[p + 1] = 200;
      raw[p + 2] = 200;
      raw[p + 3] = 255;
    }
  }
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A project ready for the master-text stage: prose contract, CONFIRMED
 *  style profile, passA. */
export function seedProseProject(
  handle: DbHandle,
  passAContent: string,
): string {
  const projectId = createProject(handle, { title: "La vida hablada" }).id;
  saveContract(handle.db, {
    projectId,
    mode: "prose",
    rules: "Mantener las historias; quitar muletillas.",
    notes: "",
  });
  confirmStyleProfile(handle.db, projectId, {
    tone: "cálido y directo",
    register: "conversacional",
    person: "primera persona",
    notes: "Nunca usar jerga corporativa.",
    voice: "la del autor hablando a un amigo",
    rhythm: "frases cortas",
    punctuation: "",
    metaphors: "ejemplos cotidianos",
    openings: "",
    excerpts: ["Lo importante es la mesa compartida."],
  });
  insertText(handle.db, {
    projectId,
    stageKey: "passA",
    version: 1,
    content: passAContent,
  });
  return projectId;
}

/** Full typed contract/profile literals for calling engine functions directly. */
export function testContract(projectId: string): EditorialContract {
  return {
    projectId,
    mode: "prose",
    rules: "",
    notes: "",
    signedAt: null,
    tone: null,
    destination: null,
    authorship: null,
    rightsNotes: "",
    legalText: "",
    version: 1,
  };
}

export function testStyleProfile(projectId: string): StyleProfile {
  return {
    projectId,
    tone: "cálido y directo",
    register: "conversacional",
    person: "primera",
    notes: "",
    data: "{}",
    updatedAt: "",
    voice: "",
    rhythm: "",
    punctuation: "",
    metaphors: "",
    openings: "",
    excerpts: "[]",
    status: "confirmed",
    version: 1,
    confirmedAt: null,
    sample: "",
  };
}

/** Six-paragraph cleaned material used across the master-text tests. */
export const PASS_A = [
  "[00:01:12] Bienvenidos al podcast, hoy vamos a hablar de la infancia.",
  "Cuando era chico vivíamos en una casa con patio y limonero.",
  "Mi abuela decía siempre: lo importante es la mesa compartida.",
  "Años después entendí lo del limonero, cuando me fui de casa.",
  "En el trabajo aprendí que nadie construye solo nada que dure.",
  "Mi abuela decía siempre: lo importante es la mesa compartida. Eso vuelve.",
].join("\n\n");
