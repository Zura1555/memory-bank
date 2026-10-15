import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { EvidenceUnavailable, knowledgeCards, loadManifest, modelCorpus, type CorpusManifest, type CorpusSnapshot } from "./corpus.ts";
import type { Env } from "./env.ts";

function manifestEnv(manifest: unknown): Env {
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  return { ORIGINALS: { get: async () => ({ size: bytes.byteLength, arrayBuffer: async () => bytes.buffer }) } } as unknown as Env;
}

async function publishedManifest(): Promise<CorpusManifest> {
  const value: unknown = JSON.parse(await readFile(new URL("../../corpus/manifest.json", import.meta.url), "utf8"));
  return (await loadManifest(manifestEnv(value))).manifest;
}

test("superseded advice stays historical even when its correction's original becomes unavailable", async () => {
  const manifest = await publishedManifest();
  const grove = manifest.cases.find((item) => item.caseId === "grove-scoped-access")!;
  const correction = grove.records.find((item) => item.supersedesId)!;
  const checklist = grove.artifacts.find((item) => item.artifactId === "access-checklist")!.versions[0];
  correction.evidence = [{ caseId: grove.caseId, artifactId: "access-checklist", versionId: checklist.versionId, passageId: checklist.passages[0].passageId }];
  const availableVersions = new Set(manifest.cases.flatMap((item) => item.artifacts.flatMap((artifact) => artifact.versions.map((version) => version.versionId))));
  const snapshot: CorpusSnapshot = {
    manifest, manifestSha256: "a".repeat(64), availableVersions,
    passages: new Map(), versions: new Map(), caseAvailability: new Map(manifest.cases.map((item) => [item.caseId, "available"])),
  };
  assert.equal(knowledgeCards(snapshot, grove.caseId).find((item) => item.recordId === correction.supersedesId)?.supersededById, correction.recordId);
  availableVersions.delete(checklist.versionId);
  const cards = knowledgeCards(snapshot, grove.caseId);
  assert.equal(cards.some((item) => item.recordId === correction.recordId), false);
  assert.equal(cards.find((item) => item.recordId === correction.supersedesId)?.supersededById, correction.recordId);
  const context = modelCorpus(snapshot).find((item) => item.caseId === grove.caseId)!;
  assert.equal(context.records.find((item) => item.recordId === correction.supersedesId)?.supersededById, correction.recordId);
});

test("runtime rejects corrupt knowledge identities, review metadata, and supersession graphs", async () => {
  const original = await publishedManifest();
  const mutations: Array<(manifest: CorpusManifest) => void> = [
    (manifest) => { const records = manifest.cases[4].records; records.push(structuredClone(records[0])); },
    (manifest) => { manifest.cases[4].records[0].evidence[0].artifactId = "request"; },
    (manifest) => { manifest.cases[4].records[0].evidence[0].versionId = "request-2025-01-14"; },
    (manifest) => { manifest.cases[4].records[0].evidence[0].passageId = "missing"; },
    (manifest) => { manifest.cases[4].records[1].supersedesId = "missing"; },
    (manifest) => { manifest.cases[4].records[0].supersedesId = manifest.cases[4].records[1].recordId; },
    (manifest) => { manifest.cases[4].records[2].supersedesId = manifest.cases[4].records[0].recordId; },
    (manifest) => { const records = manifest.cases[4].records; records.push({ ...records[1], recordId: "another-correction" }); },
    (manifest) => { manifest.cases[4].records[0].reviewedAt = "2026-02-30"; },
    (manifest) => { Reflect.set(manifest.cases[4].records[0], "reviewStatus", "draft"); },
    (manifest) => { manifest.cases[4].artifacts[1].versions[0].extractionStatus = "incomplete"; },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(original);
    mutate(candidate);
    await assert.rejects(loadManifest(manifestEnv(candidate)), EvidenceUnavailable);
  }
});
