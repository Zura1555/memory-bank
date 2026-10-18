import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import { loadCorpus } from "./corpus.ts";
import { capabilityHash } from "./auth.ts";
import { HttpFailure } from "./errors.ts";
import type { Env } from "./env.ts";
import { UPLOAD_LIMIT, UPLOAD_TEXT_LIMIT, uploadTypes, type PrivateSource, type PrivateSourceDetail, type PrivateSearchMatch } from "../shared/uploads.ts";

const RETENTION = 7 * 24 * 60 * 60 * 1000;
const PROCESS_TIMEOUT = 5 * 60 * 1000;
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const prefix = (owner: string) => `private-uploads/${owner}/`;
const recordKey = (owner: string, id: string) => `${prefix(owner)}records/${id}.json`;
const originalKey = (owner: string, id: string) => `${prefix(owner)}originals/${id}`;
const namespace = (owner: string) => `u-${owner.slice(0, 60)}`;
const vectorId = (id: string, chunk: number) => `u-${id.replaceAll("-", "")}-${chunk}`;
const metadata = (source: PrivateSourceDetail) => ({ expiresAt: source.expiresAt });
const publicView = ({ text: _text, ...source }: PrivateSourceDetail): PrivateSource => source;

export async function uploadOwner(authorization: string | null): Promise<string> {
  try { return (await capabilityHash(authorization)).toString("hex"); }
  catch { throw new HttpFailure(404, "UPLOAD_NOT_FOUND"); }
}

export async function limitUploads(env: Env, ip: string | undefined): Promise<void> {
  if (!env.SEARCH_RATE_LIMITER || !ip) throw new HttpFailure(503, "UPLOAD_UNAVAILABLE", true);
  if (!(await env.SEARCH_RATE_LIMITER.limit({ key: `uploads:${ip}` })).success) throw new HttpFailure(429, "UPLOAD_RATE_LIMITED");
}

function checkedId(id: string): string {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(id)) throw new HttpFailure(404, "UPLOAD_NOT_FOUND");
  return id;
}

async function stored(env: Env, owner: string, id: string) {
  const object = await env.ORIGINALS.get(recordKey(owner, checkedId(id)));
  if (!object) throw new HttpFailure(404, "UPLOAD_NOT_FOUND");
  const source = await object.json<PrivateSourceDetail>();
  // Existing retained uploads acquire organization fields when read; original bytes never change.
  source.caseId ??= null;
  source.notes ??= "";
  if (Date.parse(source.expiresAt) <= Date.now()) throw new HttpFailure(404, "UPLOAD_NOT_FOUND");
  return { source, etag: object.etag };
}

function activity(source: PrivateSourceDetail, state: PrivateSourceDetail["state"], message: string): void {
  source.state = state;
  source.updatedAt = new Date().toISOString();
  source.activity = [...source.activity.slice(-39), { at: source.updatedAt, state, message }];
}

function interrupted(source: PrivateSourceDetail): PrivateSourceDetail {
  if (["extracting", "indexing"].includes(source.state) && Date.now() - Date.parse(source.updatedAt) > PROCESS_TIMEOUT) {
    return { ...source, state: "failed", error: "Processing did not finish. Choose Process again to make an explicit new attempt." };
  }
  return source;
}

function textChunks(text: string): string[] {
  // Bound embedding input without silently dropping any of the extracted text.
  return text.match(/[\s\S]{1,800}/gu) ?? [];
}

async function bytesFrom(request: Request): Promise<Uint8Array> {
  if (request.headers.get("content-encoding") && request.headers.get("content-encoding") !== "identity") throw new HttpFailure(415, "UNSUPPORTED_CONTENT_ENCODING");
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > UPLOAD_LIMIT)) throw new HttpFailure(413, "UPLOAD_TOO_LARGE");
  if (!request.body) throw new HttpFailure(400, "EMPTY_UPLOAD");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > UPLOAD_LIMIT) { await reader.cancel(); throw new HttpFailure(413, "UPLOAD_TOO_LARGE"); }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  if (!size) throw new HttpFailure(400, "EMPTY_UPLOAD");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function checkFormat(bytes: Uint8Array, extension: string): void {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 12));
  const valid = extension === "pdf" ? head.startsWith("%PDF-")
    : ["docx", "pptx", "xlsx"].includes(extension) ? head.startsWith("PK\x03\x04")
    : extension === "png" ? bytes[0] === 137 && head.slice(1, 4) === "PNG"
    : ["jpg", "jpeg"].includes(extension) ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : extension === "webp" ? head.startsWith("RIFF") && head.slice(8) === "WEBP"
    : extension === "gif" ? /^GIF8[79]a/u.test(head)
    : extension === "bmp" ? head.startsWith("BM")
    : ["tif", "tiff"].includes(extension) ? head.startsWith("II\x2a\0") || head.startsWith("MM\0\x2a")
    : true;
  if (!valid) throw new HttpFailure(415, "UPLOAD_FORMAT_MISMATCH");
  if (["txt", "md", "markdown", "csv"].includes(extension)) {
    try { if (new TextDecoder("utf-8", { fatal: true }).decode(bytes).includes("\0")) throw new Error(); }
    catch { throw new HttpFailure(415, "UPLOAD_UTF8_REQUIRED"); }
  }
}

export async function createUpload(env: Env, owner: string, request: Request): Promise<PrivateSource> {
  let name: string;
  try { name = decodeURIComponent(request.headers.get("X-File-Name") ?? "").normalize("NFC"); }
  catch { throw new HttpFailure(400, "INVALID_UPLOAD_NAME"); }
  if (!name || name.length > 180 || /[\x00-\x1f\x7f/\\]/u.test(name)) throw new HttpFailure(400, "INVALID_UPLOAD_NAME");
  const extension = name.split(".").pop()!.toLowerCase();
  const mimeType = uploadTypes[extension];
  if (!mimeType) throw new HttpFailure(415, "UPLOAD_TYPE_NOT_SUPPORTED");
  const inventory = await listUploads(env, owner);
  if (inventory.length >= 100) throw new HttpFailure(409, "UPLOAD_LIBRARY_FULL");
  const bytes = await bytesFrom(request);
  checkFormat(bytes, extension);
  const now = new Date().toISOString();
  const source: PrivateSourceDetail = {
    id: crypto.randomUUID(), name, mimeType, size: bytes.byteLength,
    caseId: null, notes: "",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    createdAt: now, updatedAt: now, expiresAt: new Date(Date.now() + RETENTION).toISOString(),
    state: "pending", hasText: false, text: null, chunkCount: 0,
    textKind: mimeType.startsWith("image/") ? "visual_interpretation" : mimeType.startsWith("text/") ? "native_text" : "converted_text",
    warning: mimeType.startsWith("image/") ? "AI visual interpretation is not an audited transcription. Review it against the original before using it."
      : mimeType.startsWith("text/") ? null : "Text conversion is not audited and may omit visual layout, embedded content, comments, or formula context. Review the original.",
    error: null, activity: [{ at: now, state: "pending", message: "Original retained privately for seven days." }],
  };
  const expiryKey = `private-upload-expiry/${source.expiresAt}/${owner}/${source.id}`;
  try {
    await env.ORIGINALS.put(originalKey(owner, source.id), bytes, { customMetadata: metadata(source) });
    await env.ORIGINALS.put(recordKey(owner, source.id), JSON.stringify(source), { customMetadata: metadata(source) });
    await env.ORIGINALS.put(expiryKey, JSON.stringify({ owner, id: source.id }));
  } catch (error) {
    await env.ORIGINALS.delete([originalKey(owner, source.id), recordKey(owner, source.id), expiryKey]);
    throw error;
  }
  return publicView(source);
}

export async function listUploads(env: Env, owner: string): Promise<PrivateSource[]> {
  const objects = await env.ORIGINALS.list({ prefix: `${prefix(owner)}records/`, limit: 1000 });
  const entries = await Promise.all(objects.objects.map(async (object) => {
    try { return publicView(await uploadDetail(env, owner, object.key.split("/").pop()!.slice(0, -5))); }
    catch (error) { if (error instanceof HttpFailure && error.status === 404) return null; throw error; }
  }));
  return entries.filter((item): item is PrivateSource => item !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function uploadDetail(env: Env, owner: string, id: string): Promise<PrivateSourceDetail> {
  const { source, etag } = await stored(env, owner, id);
  if (source.state === "indexing" && env.VECTORIZE) {
    try {
      const ids = Array.from({ length: source.chunkCount }, (_, index) => vectorId(id, index));
      const found: VectorizeVector[] = [];
      for (let offset = 0; offset < ids.length; offset += 20) found.push(...await env.VECTORIZE.getByIds(ids.slice(offset, offset + 20)));
      if (ids.length && ids.every((key) => found.some((item) => item.id === key && item.namespace === namespace(owner)))) {
        activity(source, "indexed", "Every retained chunk was observed in this browser's Vectorize namespace.");
        await env.ORIGINALS.put(recordKey(owner, id), JSON.stringify(source), { onlyIf: { etagMatches: etag }, customMetadata: metadata(source) });
        return source;
      }
    } catch { /* Keep indexing unconfirmed; a service failure is not evidence of success. */ }
  }
  return interrupted(source);
}

export async function uploadOriginal(env: Env, owner: string, id: string): Promise<Response> {
  const { source } = await stored(env, owner, id);
  const object = await env.ORIGINALS.get(originalKey(owner, id));
  if (!object) throw new HttpFailure(503, "UPLOAD_ORIGINAL_UNAVAILABLE");
  const bytes = await object.arrayBuffer();
  if (createHash("sha256").update(new Uint8Array(bytes)).digest("hex") !== source.sha256) throw new HttpFailure(503, "UPLOAD_ORIGINAL_UNAVAILABLE");
  return new Response(bytes, { headers: {
    "Content-Type": source.mimeType, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(source.name)}`,
    "Content-Length": String(bytes.byteLength), "Cache-Control": "no-store",
  } });
}

const organizationSchema = z.object({
  caseId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u).nullable().optional(),
  notes: z.string().max(4000).optional(),
  previousNotes: z.string().max(4000).optional(),
}).strict().refine((value) => (value.notes !== undefined || value.caseId !== undefined) && (value.notes === undefined || value.previousNotes !== undefined));

export async function updateUpload(env: Env, owner: string, id: string, input: unknown): Promise<PrivateSource> {
  const { source, etag } = await stored(env, owner, id);
  const parsed = organizationSchema.safeParse(input);
  if (!parsed.success) throw new HttpFailure(400, "INVALID_REQUEST");
  if (["extracting", "indexing"].includes(interrupted(source).state)) throw new HttpFailure(409, "UPLOAD_PROCESSING");
  if (parsed.data.notes !== undefined && parsed.data.previousNotes !== source.notes) throw new HttpFailure(409, "UPLOAD_CHANGED");
  if (parsed.data.caseId && !(await loadCorpus(env)).manifest.cases.some((item) => item.caseId === parsed.data.caseId)) throw new HttpFailure(404, "CASE_NOT_FOUND");
  const { previousNotes: _previousNotes, ...changes } = parsed.data;
  Object.assign(source, changes);
  activity(source, interrupted(source).state, parsed.data.notes !== undefined ? "Private source notes updated." : "Private source case assignment updated; this remains unreviewed client context.");
  const saved = await env.ORIGINALS.put(recordKey(owner, id), JSON.stringify(source), { onlyIf: { etagMatches: etag }, customMetadata: metadata(source) });
  if (!saved) throw new HttpFailure(409, "UPLOAD_CHANGED");
  return publicView(source);
}

export async function deleteUpload(env: Env, owner: string, id: string): Promise<void> {
  const { source, etag } = await stored(env, owner, id);
  // Expire first: concurrent processing cannot overwrite this revision or restore access.
  source.expiresAt = new Date().toISOString();
  const saved = await env.ORIGINALS.put(recordKey(owner, id), JSON.stringify(source), { onlyIf: { etagMatches: etag }, customMetadata: metadata(source) });
  if (!saved) throw new HttpFailure(409, "UPLOAD_CHANGED");
  const marker = `private-upload-expiry/${source.expiresAt}/${owner}/${id}`;
  await env.ORIGINALS.put(marker, JSON.stringify({ owner, id }));
  await env.ORIGINALS.delete([recordKey(owner, id), originalKey(owner, id)]);
  try {
    if (env.VECTORIZE) {
      await env.VECTORIZE.deleteByIds(Array.from({ length: 128 }, (_, chunk) => vectorId(id, chunk)));
      await env.ORIGINALS.delete(marker);
    }
  } catch { /* Content access is revoked; the retained marker retries vector cleanup. */ }
  // Keep the original expiry marker to sweep any late, in-flight vector mutation as well.
}

function presentationText(bytes: Uint8Array): string {
  let total = 0;
  let count = 0;
  const entries = unzipSync(bytes, { filter: (entry) => {
    if (++count > 2000 || entry.originalSize > 4 * 1024 * 1024 || (total += entry.originalSize) > 16 * 1024 * 1024) throw new Error("PPTX decompression limit exceeded.");
    return /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+|comments\/comment\d+)\.xml$/u.test(entry.name);
  } });
  const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, preserveOrder: true, parseTagValue: false, trimValues: false });
  function collect(node: unknown): string {
    if (!node || typeof node !== "object") return "";
    if (Array.isArray(node)) return node.map(collect).join("");
    return Object.entries(node).map(([key, value]) => key === "#text" ? String(value)
      : key === "br" ? "\n" : key === "tab" ? "\t" : collect(value) + (key === "p" ? "\n" : "")).join("");
  }
  return Object.keys(entries).sort((a, b) => a.localeCompare(b, "en", { numeric: true })).map((name) => {
    const xml = new TextDecoder("utf-8", { fatal: true }).decode(entries[name]);
    if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) throw new Error("XML document types and entities are not accepted.");
    const content = collect(parser.parse(xml)).trim();
    return content ? `${name}\n${content}` : "";
  }).filter(Boolean).join("\n\n");
}

async function extract(env: Env, source: PrivateSourceDetail, bytes: Uint8Array): Promise<string> {
  if (source.mimeType.startsWith("text/")) return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (source.name.toLowerCase().endsWith(".pptx")) return presentationText(bytes);
  if (source.mimeType === "image/tiff") throw new Error("TIFF original retained. Automatic TIFF interpretation is unavailable; upload a reviewed UTF-8 transcription to use its content.");
  if (!env.AI) throw new Error("Cloudflare document conversion is unavailable. Original retained; choose Process again when the service is available.");
  const result = await env.AI.toMarkdown({ name: source.name, blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: source.mimeType }) });
  if (result.format === "error" || typeof result.data !== "string") throw new Error("Document conversion failed. Inspect the original and choose Process again, or upload a reviewed text version.");
  return result.data;
}

async function embeddings(env: Env, texts: string[]): Promise<number[][]> {
  if (!env.AI || !env.VECTORIZE) throw new Error("Cloudflare indexing is unavailable. Extracted content and the original remain available.");
  const result: unknown = await env.AI.run(EMBEDDING_MODEL, { text: texts });
  const vectors = typeof result === "object" && result !== null && "data" in result ? result.data : null;
  if (!Array.isArray(vectors) || vectors.length !== texts.length || vectors.some((vector) => !Array.isArray(vector) || vector.length !== 768 || vector.some((number) => typeof number !== "number" || !Number.isFinite(number)))) throw new Error("The embedding service returned invalid vectors. No indexing success was recorded.");
  return vectors as number[][];
}

export async function processUpload(env: Env, owner: string, id: string): Promise<void> {
  let { source, etag } = await stored(env, owner, id);
  if (["extracting", "indexing"].includes(source.state) && Date.now() - Date.parse(source.updatedAt) < PROCESS_TIMEOUT) throw new HttpFailure(409, "UPLOAD_PROCESSING");
  if (source.state === "indexed") return;
  source.error = null;
  activity(source, "extracting", source.hasText ? "Reusing retained extraction for an explicit indexing attempt." : "Extracting content; the original stays unchanged.");
  const save = async (): Promise<boolean> => {
    if (Date.parse(source.expiresAt) <= Date.now()) return false;
    const object = await env.ORIGINALS.put(recordKey(owner, id), JSON.stringify(source), { onlyIf: { etagMatches: etag }, customMetadata: metadata(source) });
    if (!object) return false;
    etag = object.etag;
    return true;
  };
  if (!await save()) return;
  try {
    if (source.text === null) {
      const object = await env.ORIGINALS.get(originalKey(owner, id));
      if (!object) throw new Error("The original is unavailable; upload the file again.");
      const bytes = new Uint8Array(await object.arrayBuffer());
      if (createHash("sha256").update(bytes).digest("hex") !== source.sha256) throw new Error("The retained original failed its integrity check; upload the file again.");
      const text = (await extract(env, source, bytes)).trim();
      if (!text || new TextEncoder().encode(text).byteLength > UPLOAD_TEXT_LIMIT) {
        activity(source, "needs_review", "Extraction is empty or exceeds the 64 KiB text limit. No content was truncated or indexed.");
        source.error = "Upload a smaller document or a reviewed text transcription. The exact original remains available.";
        await save();
        return;
      }
      source.text = text;
      source.hasText = true;
    }
    const chunks = textChunks(source.text);
    source.chunkCount = chunks.length;
    activity(source, "indexing", `Extracted ${chunks.length} chunks. Waiting for Vectorize to confirm every chunk.`);
    if (!await save()) return;
    const vectors: VectorizeVector[] = [];
    for (let offset = 0; offset < chunks.length; offset += 16) {
      const batch = chunks.slice(offset, offset + 16);
      const values = await embeddings(env, batch);
      values.forEach((vector, index) => vectors.push({ id: vectorId(id, offset + index), namespace: namespace(owner), values: vector }));
    }
    if (Date.parse(source.expiresAt) <= Date.now() || !(await env.ORIGINALS.head(recordKey(owner, id)))) return;
    await env.VECTORIZE!.upsert(vectors);
    activity(source, "indexing", "Vectorize accepted the chunks; visibility is being confirmed, not assumed.");
    await save();
  } catch (error) {
    source.error = error instanceof Error && /^(Cloudflare|TIFF|Document conversion|The (embedding|retained|original)|XML|PPTX)/u.test(error.message)
      ? error.message : "Processing failed. The original is retained. Choose Process again for an explicit new attempt.";
    activity(source, source.mimeType === "image/tiff" ? "needs_review" : "failed", source.hasText ? "Indexing failed; extracted content remains available." : "Extraction failed; no content was indexed.");
    await save();
  }
}

export async function attachmentRequest(env: Env, owner: string, request: string, ids: string[]): Promise<string> {
  const parts = [request];
  for (const id of new Set(ids)) {
    const { source } = await stored(env, owner, id);
    if (!source.hasText || !source.text) throw new HttpFailure(409, "UPLOAD_TEXT_NOT_READY");
    parts.push(`Attached new-client context — ${source.name} (${source.textKind.replaceAll("_", " ")}; not checked historical evidence):\n${source.text}`);
  }
  const combined = parts.join("\n\n");
  if (new TextEncoder().encode(combined).byteLength > 16 * 1024) throw new HttpFailure(413, "ATTACHED_REQUEST_TOO_LARGE");
  return combined;
}

export async function searchUploads(env: Env, owner: string, query: string): Promise<PrivateSearchMatch[]> {
  const [vector] = await embeddings(env, [query]);
  const response = await env.VECTORIZE!.query(vector, { namespace: namespace(owner), topK: 20 });
  const sources = await listUploads(env, owner);
  const candidates = await Promise.all(sources.filter((source) => source.state === "indexed").map((source) => stored(env, owner, source.id)));
  const allowed = new Map<string, PrivateSearchMatch>();
  for (const { source } of candidates) textChunks(source.text!).forEach((excerpt, chunk) => allowed.set(vectorId(source.id, chunk), { sourceId: source.id, name: source.name, chunk, excerpt }));
  return response.matches.flatMap((match) => allowed.has(match.id) ? [allowed.get(match.id)!] : []);
}

export async function expireUploads(env: Env): Promise<void> {
  const markers = await env.ORIGINALS.list({ prefix: "private-upload-expiry/", limit: 1000 });
  for (const marker of markers.objects) {
    const date = marker.key.split("/")[1];
    if (Date.parse(date) > Date.now()) break;
    const object = await env.ORIGINALS.get(marker.key);
    if (!object) continue;
    const { owner, id } = await object.json<{ owner: string; id: string }>();
    // Remove content first. If vector deletion fails, retain the marker for the next cron.
    await env.ORIGINALS.delete([recordKey(owner, id), originalKey(owner, id)]);
    if (!env.VECTORIZE) continue;
    await env.VECTORIZE.deleteByIds(Array.from({ length: 128 }, (_, chunk) => vectorId(id, chunk)));
    await env.ORIGINALS.delete(marker.key);
  }
}
