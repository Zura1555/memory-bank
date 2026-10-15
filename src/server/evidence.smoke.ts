import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PassageView } from "../shared/protocol.ts";

const manifest = JSON.parse(await readFile(new URL("../../corpus/manifest.json", import.meta.url), "utf8"));
const pastCase = manifest.cases[0];
const artifact = pastCase.artifacts[0];
const version = artifact.versions[0];
const passage = version.passages[0];
assert.equal(version.extractionStatus, "complete");
const headers = { "Sec-Fetch-Mode": "navigate", Accept: "text/html" };
const base = "http://127.0.0.1:8787/api/evidence";

// Navigation requests must reach the evidence API, not the SPA index fallback.
const original = await fetch(`${base}/originals/${encodeURIComponent(version.versionId)}`, {
  headers,
  signal: AbortSignal.timeout(5_000),
});
assert.equal(original.status, 200);
assert.equal(original.headers.get("content-type"), version.mimeType);
assert.equal(original.headers.get("content-disposition"), `attachment; filename="${version.versionId}"`);
assert.equal(createHash("sha256").update(new Uint8Array(await original.arrayBuffer())).digest("hex"), version.sha256);

const response = await fetch(`${base}/passages/${encodeURIComponent(passage.passageId)}`, {
  headers,
  signal: AbortSignal.timeout(5_000),
});
assert.equal(response.status, 200);
const checked = await response.json() as PassageView;
assert.equal(checked.caseId, pastCase.caseId);
assert.equal(checked.artifactId, artifact.artifactId);
assert.equal(checked.versionId, version.versionId);
assert.equal(checked.passageId, passage.passageId);
assert.equal(checked.excerpt, passage.excerpt);
assert.equal(checked.fictional, true);
console.log("Evidence navigation reaches the API; exact-original SHA-256 and passage identity match. No model jobs submitted.");
