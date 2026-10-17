import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { app } from "./http.ts";
import type { Env } from "./env.ts";
import type { PassageSearchResponse } from "../shared/protocol.ts";

test("semantic search returns only current verified passages and fails closed for stale indexes", async () => {
  const manifestBytes = await readFile(new URL("../../corpus/manifest.json", import.meta.url));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const firstCase = manifest.cases[0];
  const target = firstCase.artifacts[0].versions[0].passages[0];
  const otherCasePassage = manifest.cases[1].artifacts[0].versions[0].passages[0];
  let matches = [
    { id: otherCasePassage.passageId },
    { id: "stale-or-unknown-passage" },
    { id: target.passageId },
  ];
  let embeddingCalls = 0;
  let vectorQueries = 0;
  let observedNamespace = "";
  const env = {
    ORIGINALS: { get: async (key: string) => {
      const bytes = key === "corpus/manifest.json"
        ? manifestBytes
        : await readFile(new URL(`../../corpus/originals/${key.split("/originals/")[1]}`, import.meta.url));
      return {
        size: bytes.byteLength,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
      };
    } },
    AI: { run: async (_model: string, input: { text: string }) => {
      embeddingCalls++;
      assert.equal(input.text, "recovery steps");
      return { data: [Array(768).fill(0.25)] };
    } },
    VECTORIZE: { query: async (_vector: number[], options: { namespace: string }) => {
      vectorQueries++;
      observedNamespace = options.namespace;
      return { matches };
    } },
    SEARCH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  } as unknown as Env;
  const request = (mimeType = "text/markdown") => app.request("http://localhost/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.1" },
    body: JSON.stringify({ query: " recovery steps ", caseId: firstCase.caseId, mimeType }),
  }, env);

  const response = await request();
  assert.equal(response.status, 200);
  const body = await response.json() as PassageSearchResponse;
  assert.equal(body.results.length, 1);
  assert.deepEqual(body.results[0], {
    ...target,
    caseId: firstCase.caseId,
    artifactId: firstCase.artifacts[0].artifactId,
    versionId: firstCase.artifacts[0].versions[0].versionId,
    title: firstCase.artifacts[0].title,
    fictional: true,
    statedDate: firstCase.artifacts[0].versions[0].statedDate,
  });
  assert.equal(observedNamespace, createHash("sha256").update(manifestBytes).digest("hex"));

  matches = [];
  const stale = await request();
  assert.equal(stale.status, 503);
  assert.deepEqual(await stale.json(), { error: { code: "SEARCH_INDEX_NOT_READY", message: "The request could not be completed.", retryable: true } });

  const noEligiblePassages = await request("application/pdf");
  assert.equal(noEligiblePassages.status, 200);
  assert.deepEqual(await noEligiblePassages.json(), { results: [] });
  assert.equal(embeddingCalls, 2);
  assert.equal(vectorQueries, 2);
});
