import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { zipSync, strToU8 } from "fflate";
import { app } from "./http.ts";
import type { Env } from "./env.ts";
import { attachmentRequest, createUpload, deleteUpload, expireUploads, listUploads, processUpload, searchUploads, updateUpload, uploadDetail, uploadOriginal, uploadOwner } from "./uploads.ts";
import { UPLOAD_LIMIT, type PrivateSourceDetail } from "../shared/uploads.ts";

function storage() {
  const objects = new Map<string, { body: Uint8Array; etag: string }>();
  let revision = 0;
  const vectors = new Map<string, VectorizeVector>();
  let visible = false;
  let calls = 0;
  const env = {
    ORIGINALS: {
      async get(key: string) {
        const item = objects.get(key);
        if (!item) return null;
        return { size: item.body.length, etag: item.etag, arrayBuffer: async () => item.body.slice().buffer,
          json: async () => JSON.parse(new TextDecoder().decode(item.body)) };
      },
      async head(key: string) { return objects.get(key) ?? null; },
      async put(key: string, body: string | Uint8Array, options?: { onlyIf?: { etagMatches?: string } }) {
        if (options?.onlyIf?.etagMatches && objects.get(key)?.etag !== options.onlyIf.etagMatches) return null;
        const item = { body: typeof body === "string" ? new TextEncoder().encode(body) : body.slice(), etag: String(++revision) };
        objects.set(key, item);
        return item;
      },
      async list({ prefix }: { prefix: string }) { return { objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).sort().map((key) => ({ key })), truncated: false }; },
      async delete(keys: string | string[]) { for (const key of typeof keys === "string" ? [keys] : keys) objects.delete(key); },
    },
    AI: { async run(_model: string, input: { text: string[] }) { calls++; return { data: input.text.map(() => Array(768).fill(0.1)) }; } },
    VECTORIZE: {
      async upsert(entries: VectorizeVector[]) { for (const entry of entries) vectors.set(entry.id, entry); return { mutationId: "accepted-not-yet-visible" }; },
      async getByIds(ids: string[]) { return visible ? ids.flatMap((id) => vectors.has(id) ? [vectors.get(id)!] : []) : []; },
      // Deliberately return even foreign IDs: server-side resolution must still enforce ownership.
      async query() { return { matches: [...vectors.keys()].map((id) => ({ id, score: 1 })) }; },
      async deleteByIds(ids: string[]) { for (const id of ids) vectors.delete(id); },
    },
    SEARCH_RATE_LIMITER: { async limit() { return { success: true }; } },
  } as unknown as Env;
  return { env, objects, vectors, reveal: () => { visible = true; }, calls: () => calls };
}
const authorization = `Bearer ${"a".repeat(43)}`;
const otherAuthorization = `Bearer ${"b".repeat(43)}`;
function uploadRequest(name: string, bytes: string | Uint8Array): Request {
  return new Request("http://localhost/api/uploads", { method: "POST", headers: { "X-File-Name": encodeURIComponent(name) }, body: bytes as BodyInit });
}

test("private sources enforce ownership, observed indexing, exact originals and seven-day expiry", async (t) => {
  const { env, objects, vectors, reveal } = storage();
  const owner = await uploadOwner(authorization);
  const otherOwner = await uploadOwner(otherAuthorization);
  const content = "The client's sandbox import must reconcile 120 records.\nNo production writes are authorized.";
  const source = await createUpload(env, owner, uploadRequest("client-request.md", content));
  assert.equal((await app.request("http://localhost/api/uploads", {}, env)).status, 404);
  assert.deepEqual(await listUploads(env, otherOwner), []);
  for (const suffix of ["", "/original"]) {
    assert.equal((await app.request(`http://localhost/api/uploads/${source.id}${suffix}`, { headers: { Authorization: otherAuthorization } }, env)).status, 404);
  }
  await assert.rejects(attachmentRequest(env, otherOwner, "Request", [source.id]), { code: "UPLOAD_NOT_FOUND" });
  await processUpload(env, owner, source.id);
  assert.equal((await uploadDetail(env, owner, source.id)).state, "indexing", "accepted mutation is not proof of visible vectors");
  reveal();
  assert.equal((await uploadDetail(env, owner, source.id)).state, "indexed");
  assert.equal((await uploadOriginal(env, owner, source.id)).headers.get("content-disposition"), "attachment; filename*=UTF-8''client-request.md");
  assert.equal(await (await uploadOriginal(env, owner, source.id)).text(), content);
  assert.deepEqual((await searchUploads(env, owner, "sandbox")).map((match) => match.excerpt), [content]);
  assert.deepEqual(await searchUploads(env, otherOwner, "sandbox"), []);
  assert.equal(await attachmentRequest(env, owner, "Check this request.", [source.id]), `Check this request.\n\nAttached new-client context — client-request.md (native text; not checked historical evidence):\n${content}`);
  const originalKey = [...objects.keys()].find((key) => key.includes(`/originals/${source.id}`))!;
  const original = objects.get(originalKey)!;
  objects.set(originalKey, { body: strToU8("substituted content"), etag: "changed" });
  await assert.rejects(uploadOriginal(env, owner, source.id), { code: "UPLOAD_ORIGINAL_UNAVAILABLE" });
  objects.set(originalKey, original);
  t.mock.method(Date, "now", () => Date.parse(source.expiresAt) + 1);
  await assert.rejects(uploadDetail(env, owner, source.id), { code: "UPLOAD_NOT_FOUND" });
  await assert.rejects(attachmentRequest(env, owner, "Request", [source.id]), { code: "UPLOAD_NOT_FOUND" });
  await expireUploads(env);
  assert.deepEqual([...objects.keys()], []);
  assert.equal(vectors.size, 0);
});

test("format, byte and extraction limits reject unsafe input without truncation", async () => {
  const { env, objects } = storage();
  const owner = await uploadOwner(authorization);
  for (const [name, bytes, code] of [
    ["payload.html", "<script>bad()</script>", "UPLOAD_TYPE_NOT_SUPPORTED"],
    ["fake.pdf", "not a pdf", "UPLOAD_FORMAT_MISMATCH"],
    ["bad.txt", new Uint8Array([255, 254, 0]), "UPLOAD_UTF8_REQUIRED"],
    ["../secret.txt", "text", "INVALID_UPLOAD_NAME"],
    ["large.txt", new Uint8Array(UPLOAD_LIMIT + 1), "UPLOAD_TOO_LARGE"],
  ] as const) await assert.rejects(createUpload(env, owner, uploadRequest(name, bytes)), { code });
  assert.equal(objects.size, 0);
  const source = await createUpload(env, owner, uploadRequest("too-much-context.txt", "é".repeat(9000)));
  await processUpload(env, owner, source.id);
  await assert.rejects(attachmentRequest(env, owner, "Request", [source.id]), { code: "ATTACHED_REQUEST_TOO_LARGE" });
  const oversized = await createUpload(env, owner, uploadRequest("large-content.txt", "x".repeat(65537)));
  await processUpload(env, owner, oversized.id);
  assert.equal((await uploadDetail(env, owner, oversized.id)).state, "needs_review");
  assert.equal((await uploadDetail(env, owner, oversized.id)).hasText, false);
  assert.equal(await (await uploadOriginal(env, owner, oversized.id)).text(), "x".repeat(65537));
});

test("upload limits accept 25 MiB originals and cap retained files at 100", async () => {
  const { env, objects } = storage();
  const owner = await uploadOwner(authorization);
  const oversized = new Uint8Array(UPLOAD_LIMIT + 1).fill(0x61);
  await assert.rejects(createUpload(env, owner, uploadRequest("over-limit.txt", oversized)), { code: "UPLOAD_TOO_LARGE" });
  assert.equal(objects.size, 0);

  const bytes = new Uint8Array(UPLOAD_LIMIT).fill(0x61);
  const source = await createUpload(env, owner, uploadRequest("exact-limit.txt", bytes));
  assert.equal(source.size, UPLOAD_LIMIT);
  const original = await uploadOriginal(env, owner, source.id);
  assert.equal(original.headers.get("content-length"), String(UPLOAD_LIMIT));
  assert.equal(createHash("sha256").update(new Uint8Array(await original.arrayBuffer())).digest("hex"), source.sha256);

  for (let index = 1; index < 100; index++) {
    await createUpload(env, owner, uploadRequest(`retained-${index}.txt`, "x"));
  }
  assert.equal((await listUploads(env, owner)).length, 100);
  await assert.rejects(createUpload(env, owner, uploadRequest("one-too-many.txt", "x")), { code: "UPLOAD_LIBRARY_FULL" });
});

test("PPTX extraction includes slide text and notes while disallowing XML entity declarations", async () => {
  const { env } = storage();
  const owner = await uploadOwner(authorization);
  const xml = (text: string) => strToU8(`<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:sld>`);
  const bytes = zipSync({
    "ppt/slides/slide1.xml": xml("Production writes are prohibited."),
    "ppt/notesSlides/notesSlide1.xml": xml("Sandbox testing only."),
    "ppt/slides/slide2.xml": strToU8('<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>00120</a:t></a:r></a:p><a:p><a:r><a:t xml:space="preserve">No pro</a:t></a:r><a:r><a:t>duction writes.</a:t></a:r></a:p></p:sld>'),
  });
  const source = await createUpload(env, owner, uploadRequest("scope.pptx", bytes));
  await processUpload(env, owner, source.id);
  const detail = await uploadDetail(env, owner, source.id);
  assert.match(detail.text!, /Production writes are prohibited\./u);
  assert.match(detail.text!, /Sandbox testing only\./u);
  assert.match(detail.text!, /00120\nNo production writes\./u);
  const malicious = await createUpload(env, owner, uploadRequest("entity.pptx", zipSync({ "ppt/slides/slide1.xml": strToU8('<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]><x>&secret;</x>') })));
  await processUpload(env, owner, malicious.id);
  assert.equal((await uploadDetail(env, owner, malicious.id)).state, "failed");
  assert.equal((await uploadDetail(env, owner, malicious.id)).hasText, false);
});

test("failed indexing retains usable extracted context and requires an explicit retry", async () => {
  const { env, calls, reveal } = storage();
  const owner = await uploadOwner(authorization);
  const source = await createUpload(env, owner, uploadRequest("context.csv", "field,value\nenvironment,sandbox"));
  const ai = env.AI!;
  env.AI = { run: async () => { throw new Error("provider failure"); } } as unknown as Ai;
  await processUpload(env, owner, source.id);
  const failed = await uploadDetail(env, owner, source.id);
  assert.equal(failed.state, "failed");
  assert.equal(failed.hasText, true);
  assert.match(await attachmentRequest(env, owner, "Request", [source.id]), /environment,sandbox/u);
  assert.equal(calls(), 0);
  env.AI = ai;
  await processUpload(env, owner, source.id);
  reveal();
  assert.equal((await uploadDetail(env, owner, source.id)).state, "indexed");
  assert.equal(calls(), 1);
});

test("a competing processing request cannot dispatch a second embedding attempt", async () => {
  const { env } = storage();
  const owner = await uploadOwner(authorization);
  const source = await createUpload(env, owner, uploadRequest("request.txt", "Sandbox access only."));
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  env.AI = { run: async () => { calls++; entered(); await blocked; return { data: [Array(768).fill(0.1)] }; } } as unknown as Ai;
  const processing = processUpload(env, owner, source.id);
  await started;
  await assert.rejects(processUpload(env, owner, source.id), { code: "UPLOAD_PROCESSING" });
  release();
  await processing;
  assert.equal(calls, 1);
  assert.equal((await uploadDetail(env, owner, source.id)).hasText, true);
});

test("private source organization is owned, bounded, durable, and never changes original bytes or expiry", async () => {
  const { env, objects } = storage();
  const owner = await uploadOwner(authorization);
  const source = await createUpload(env, owner, uploadRequest("review.txt", "Only sandbox access is authorized."));
  const manifest = await readFile(new URL("../../corpus/manifest.json", import.meta.url), "utf8");
  await env.ORIGINALS.put("corpus/manifest.json", manifest);
  const caseId = JSON.parse(manifest).cases[0].caseId;
  const headers = { Authorization: authorization, "Content-Type": "application/json", "CF-Connecting-IP": "127.0.0.1" };
  const path = `http://localhost/api/uploads/${source.id}`;
  assert.equal((await app.request(path, { method: "PATCH", headers: { ...headers, Authorization: otherAuthorization }, body: JSON.stringify({ notes: "foreign edit" }) }, env)).status, 404);
  assert.equal((await app.request(path, { method: "DELETE", headers: { ...headers, Authorization: otherAuthorization } }, env)).status, 404);
  assert.equal((await app.request(path, { method: "PATCH", headers, body: JSON.stringify({ notes: "x".repeat(4001) }) }, env)).status, 400);
  assert.equal((await app.request(path, { method: "PATCH", headers, body: JSON.stringify({ state: "indexed" }) }, env)).status, 400);
  assert.equal((await app.request(path, { method: "PATCH", headers, body: JSON.stringify({ caseId: "unknown-case" }) }, env)).status, 404);
  assert.equal((await app.request(path, { method: "PATCH", headers, body: JSON.stringify({ caseId, notes: "Review the original before reuse.", previousNotes: "" }) }, env)).status, 200);
  await assert.rejects(updateUpload(env, owner, source.id, { notes: "A stale editor must not overwrite these notes.", previousNotes: "" }), { code: "UPLOAD_CHANGED" });
  await processUpload(env, owner, source.id);
  const retained = (await listUploads(env, owner))[0];
  assert.equal(retained.caseId, caseId);
  assert.equal(retained.notes, "Review the original before reuse.");
  assert.equal(retained.expiresAt, source.expiresAt);
  assert.equal(await (await uploadOriginal(env, owner, source.id)).text(), "Only sandbox access is authorized.");
  await assert.rejects(updateUpload(env, owner, source.id, { notes: "during indexing", previousNotes: retained.notes }), { code: "UPLOAD_PROCESSING" });
  assert.equal((await app.request(path, { method: "DELETE", headers }, env)).status, 200);
  assert.deepEqual(await listUploads(env, owner), []);
  await assert.rejects(uploadOriginal(env, owner, source.id), { code: "UPLOAD_NOT_FOUND" });
  await assert.rejects(attachmentRequest(env, owner, "Request", [source.id]), { code: "UPLOAD_NOT_FOUND" });
  assert.equal([...objects.keys()].some((key) => key.includes(`/originals/${source.id}`)), false);
});

test("deletion during embedding prevents content resurrection and retains cleanup after vector failures", async () => {
  const { env, objects, vectors } = storage();
  const owner = await uploadOwner(authorization);
  const source = await createUpload(env, owner, uploadRequest("delete-during-processing.txt", "A private client request."));
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  env.AI = { run: async () => { entered(); await blocked; return { data: [Array(768).fill(0.1)] }; } } as unknown as Ai;
  const processing = processUpload(env, owner, source.id);
  await started;
  env.VECTORIZE!.deleteByIds = async () => { throw new Error("temporary vector outage"); };
  await deleteUpload(env, owner, source.id);
  release();
  await processing;
  assert.deepEqual(await listUploads(env, owner), []);
  assert.equal(vectors.size, 0);
  assert.equal([...objects.keys()].some((key) => key.includes("/records/")), false);
  assert.equal([...objects.keys()].some((key) => key.startsWith("private-upload-expiry/")), true);
  env.VECTORIZE!.deleteByIds = async () => ({ mutationId: "removed" });
  await expireUploads(env);
  assert.equal([...objects.keys()].filter((key) => key.startsWith("private-upload-expiry/")).length, 1, "the original seven-day marker remains to sweep late in-flight vectors");
});
