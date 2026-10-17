import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { app } from "./http.ts";
import type { Env } from "./env.ts";
import type { SourceCatalogEntry } from "../shared/protocol.ts";

test("source browsing preserves exact identities and withholds passages for missing, corrupt, and incomplete originals", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../corpus/manifest.json", import.meta.url), "utf8"));
  const pastCase = manifest.cases[0];
  const artifact = pastCase.artifacts[0];
  const version = artifact.versions[0];
  // A distinct retained version must not rescue access to the older missing original.
  const newer = structuredClone(pastCase.artifacts[1].versions[0]);
  newer.versionId = "newer-source-version";
  newer.passages.forEach((passage: { passageId: string }, index: number) => { passage.passageId = `newer-passage-${index}`; });
  artifact.versions.push(newer);
  let unavailable: "missing" | "corrupt" | null = null;
  const env = { ORIGINALS: { get: async (key: string) => {
    if (key === version.sourcePath && unavailable === "missing") return null;
    const bytes = key === "corpus/manifest.json"
      ? Buffer.from(JSON.stringify(manifest))
      : key === version.sourcePath && unavailable === "corrupt"
        ? Buffer.from("Not the retained original")
        : await readFile(new URL(`../../corpus/originals/${key.split("/originals/")[1]}`, import.meta.url));
    return { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
  } } } as unknown as Env;
  async function source(versionId = version.versionId) {
    const response = await app.request("http://localhost/api/sources", {}, env);
    assert.equal(response.status, 200);
    const { sources } = await response.json() as { sources: SourceCatalogEntry[] };
    return sources.find((entry) => entry.versionId === versionId)!;
  }
  const available = await source();
  assert.equal(available.caseId, pastCase.caseId);
  assert.equal(available.artifactId, artifact.artifactId);
  assert.equal(available.fictional, true);
  assert.equal(available.availability, "available");
  assert.deepEqual(available.passages, version.passages.map((passage: { passageId: string; sourceKind: string }) => ({
    caseId: pastCase.caseId, artifactId: artifact.artifactId, versionId: version.versionId,
    passageId: passage.passageId, sourceKind: passage.sourceKind,
  })));
  assert.equal(Object.hasOwn(available, "sourcePath"), false);
  for (const retained of [version, newer]) {
    const original = await app.request(`http://localhost/api/evidence/originals/${retained.versionId}`, {}, env);
    assert.equal(original.status, 200);
    assert.equal(original.headers.get("content-type"), retained.mimeType);
    assert.equal(original.headers.get("content-disposition"), `attachment; filename="${retained.versionId}"`);
    const expected = await readFile(new URL(`../../corpus/originals/${retained.sourcePath.split("/originals/")[1]}`, import.meta.url));
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), expected);
    const response = await app.request(`http://localhost/api/evidence/passages/${retained.passages[0].passageId}`, {}, env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ...retained.passages[0], caseId: pastCase.caseId, artifactId: artifact.artifactId,
      versionId: retained.versionId, title: artifact.title, fictional: true, statedDate: retained.statedDate,
    });
  }
  for (const failure of ["missing", "corrupt"] as const) {
    unavailable = failure;
    const withheld = await source();
    assert.equal(withheld.availability, "unavailable");
    assert.deepEqual(withheld.passages, []);
    assert.deepEqual(withheld.exclusionReasons, ["The exact original is unavailable or could not be verified."]);
    const original = await app.request(`http://localhost/api/evidence/originals/${version.versionId}`, {}, env);
    assert.equal(original.status, 503);
    const passage = await app.request(`http://localhost/api/evidence/passages/${version.passages[0].passageId}`, {}, env);
    assert.equal(passage.status, 503);
    assert.equal((await source(newer.versionId)).availability, "available");
  }
  unavailable = null;
  version.extractionStatus = "incomplete";
  version.exclusionReasons = ["Extraction requires a curator review."];
  const incomplete = await source();
  assert.equal(incomplete.availability, "incomplete");
  assert.deepEqual(incomplete.passages, []);
  assert.deepEqual(incomplete.exclusionReasons, version.exclusionReasons);
  for (const path of [`originals/${version.versionId}`, `passages/${version.passages[0].passageId}`]) {
    assert.equal((await app.request(`http://localhost/api/evidence/${path}`, {}, env)).status, 503);
  }
  assert.equal((await source(newer.versionId)).availability, "available");
});
