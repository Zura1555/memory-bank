import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Claim, SourceRef } from "../shared/protocol.ts";
import { knowledgeCards, type CorpusManifest, type CorpusSnapshot, type SourceHistoryRecord } from "./corpus.ts";
import { applySourceHistoryQualifications, invalidSourceHistoryQualifications, isSourceHistoryQualification, sourceVerifiedRecords } from "./source-history.ts";

async function fixture(): Promise<CorpusSnapshot> {
  const manifest = JSON.parse(await readFile(new URL("../../corpus/manifest.json", import.meta.url), "utf8")) as CorpusManifest;
  return {
    manifest,
    manifestSha256: "a".repeat(64),
    availableVersions: new Set(manifest.cases.flatMap((pastCase) => pastCase.artifacts.flatMap((artifact) => artifact.versions.map((version) => version.versionId)))),
    caseAvailability: new Map<string, "available" | "partial" | "unavailable">(manifest.cases.map((pastCase): [string, "available" | "partial" | "unavailable"] => [pastCase.caseId, "available"])),
    passages: new Map(),
    versions: new Map(),
  };
}

function historyRecord(snapshot: CorpusSnapshot, recordId: string): SourceHistoryRecord {
  const record = snapshot.manifest.cases.flatMap((pastCase) => pastCase.records).find((item) => item.recordId === recordId);
  assert.ok(record?.kind === "source_fact");
  return record;
}

function claim(claimId: string, sourceRefs: SourceRef[]): Claim {
  return { claimId, text: "historical observation", kind: "interpretation", sourceRefs, requestQuotes: [], dependsOnClaimIds: [] };
}

function qualificationId(record: SourceHistoryRecord): string {
  return `source-history-${record.recordId}`;
}

test("verified source inventory stays separate from human knowledge cards", async () => {
  const snapshot = await fixture();
  const cards: Array<{ kind: string }> = knowledgeCards(snapshot);
  assert.equal(cards.some((record) => record.kind === "source_fact"), false);
});

test("Elm total claims receive exact qualifications preserving both unreconciled reports", async () => {
  const snapshot = await fixture();
  const record = historyRecord(snapshot, "elm-batch-count-discrepancy");
  const original = claim("elm-total", [record.evidence[0]]);
  const claims = [original];
  const before = structuredClone(claims);
  const result = applySourceHistoryQualifications(snapshot, claims);
  const historical = result.find((item) => item.claimId === "elm-total")!;
  const qualification = result.find((item) => item.claimId === qualificationId(record))!;
  assert.deepEqual(historical.dependsOnClaimIds, [qualificationId(record)]);

  assert.deepEqual(qualification.sourceRefs, record.evidence);
  assert.match(qualification.text, /four intentionally malformed amounts/);
  assert.match(qualification.text, /two rejects/);
  assert.match(qualification.text, /598 of 600/);
  assert.match(qualification.text, /unreconciled/);
  assert.deepEqual(claims, before);
  assert.notEqual(result, claims);
  assert.equal(isSourceHistoryQualification(snapshot, qualification), true);
  assert.equal(invalidSourceHistoryQualifications(snapshot, result).size, 0);
});

test("Elm limitation claims include the source's distinct production limits", async () => {
  const snapshot = await fixture();
  const record = historyRecord(snapshot, "elm-sandbox-limitations");
  const input = claim("elm-limit", [record.evidence[3]]);
  const result = applySourceHistoryQualifications(snapshot, [input]);
  const qualification = result.find((item) => item.claimId === qualificationId(record))!;

  assert.deepEqual(result[0].dependsOnClaimIds, [qualificationId(record)]);
  assert.match(qualification.text, /Production authorization.*unknown/);
  assert.match(qualification.text, /delivery acceptance remains pending/);
  assert.match(qualification.text, /No generic retry policy was validated/);
  assert.equal(invalidSourceHistoryQualifications(snapshot, result).size, 0);
});

test("Ibis successful history carries the initial failure, corrected archive, and remaining limits", async () => {
  const snapshot = await fixture();
  const record = historyRecord(snapshot, "ibis-recovery-correction-history");
  const result = applySourceHistoryQualifications(snapshot, [claim("ibis-success", [record.evidence[1]])]);
  const qualification = result.find((item) => item.claimId === qualificationId(record))!;

  assert.deepEqual(result[0].dependsOnClaimIds, [qualificationId(record)]);
  assert.equal(qualification.text, record.assertion);
  assert.deepEqual(qualification.sourceRefs, record.evidence);
  assert.match(qualification.text, /first recovery attempt failed/);
  assert.match(qualification.text, /corrected test archive/);
  assert.match(qualification.text, /replayed one test batch/);
  assert.match(qualification.text, /Production alert routing, readiness, and recovery outcomes are not established/);
  assert.equal(invalidSourceHistoryQualifications(snapshot, result).size, 0);
});

test("qualification matching is exact, dependencies fail closed, and prose keywords do not trigger it", async () => {
  const snapshot = await fixture();
  const record = historyRecord(snapshot, "elm-batch-count-discrepancy");
  const wrongVersion = { ...record.evidence[0], versionId: "notes-2025-04-18" };
  const unrelated = { ...claim("unrelated", [wrongVersion]), text: "598 of 600" };
  const untouched = applySourceHistoryQualifications(snapshot, [unrelated]);
  assert.equal(untouched.length, 1);
  assert.equal(invalidSourceHistoryQualifications(snapshot, untouched).size, 0);

  const sourceClaim = claim("missing-dependency", [record.evidence[0]]);
  assert.ok(invalidSourceHistoryQualifications(snapshot, [sourceClaim]).has(sourceClaim.claimId));
  const qualified = applySourceHistoryQualifications(snapshot, [sourceClaim]);
  const withoutDependency = qualified.map((item) => item.claimId === sourceClaim.claimId ? { ...item, dependsOnClaimIds: [] } : item);
  assert.ok(invalidSourceHistoryQualifications(snapshot, withoutDependency).has(sourceClaim.claimId));

  const falseQualification = { ...qualified[1], text: "Adjusted historical totals" };
  assert.equal(isSourceHistoryQualification(snapshot, falseQualification), false);
  assert.ok(invalidSourceHistoryQualifications(snapshot, [qualified[0], falseQualification]).has(sourceClaim.claimId));
  assert.throws(() => applySourceHistoryQualifications(snapshot, [{ ...sourceClaim, claimId: qualificationId(record) }]), /reserved source-history/);
});

test("unavailable qualification evidence hides inventory and invalidates an existing success capture", async () => {
  const snapshot = await fixture();
  const record = historyRecord(snapshot, "ibis-recovery-correction-history");
  const trigger = claim("stored-ibis-success", [record.evidence[1]]);
  const stored = applySourceHistoryQualifications(snapshot, [trigger]);
  const qualification = stored.find((item) => item.claimId === qualificationId(record))!;

  snapshot.availableVersions.delete(record.evidence[3].versionId);
  assert.equal(sourceVerifiedRecords(snapshot).some((item) => item.recordId === record.recordId), false);
  assert.equal(isSourceHistoryQualification(snapshot, qualification), false);
  const invalid = invalidSourceHistoryQualifications(snapshot, stored);
  assert.ok(invalid.has(trigger.claimId));
  assert.ok(invalid.has(qualification.claimId));
  assert.deepEqual(stored.find((item) => item.claimId === trigger.claimId)!.dependsOnClaimIds, [qualificationId(record)]);
});
