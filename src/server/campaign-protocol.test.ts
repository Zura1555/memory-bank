import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AssessmentResult, Claim, Selection } from "../shared/protocol.ts";
import { OPERATION_CHECKS } from "../shared/operations.ts";
import {
  EXPOSED_REQUEST_ORDER, buildExposedCampaign, deriveHGate, exposedCreditPlan, gradeCampaign,
  selectionsMatch, verifyRunCapture, writeImmutableCapture,
} from "./campaign-protocol.ts";
import type { CandidateBinding, FixedCampaign, VerifiedRunCapture } from "./campaign-protocol.ts";
import { validateSelections } from "./selections.ts";
import type { Artifact, CorpusSnapshot, IndexedPassage, PastCase, SourceVersion } from "./corpus.ts";

test("credit overlap requires explicit owner approval, preserves holds and never exceeds the run or campaign ceiling", () => {
  const budget = { heldMicroUsd: 1_800_000, reconciledSpendMicroUsd: 1_875_662, availableCreditMicroUsd: 4_319_578, limitMicroUsd: 5_000_000 };
  const original = structuredClone(budget);
  assert.throws(() => exposedCreditPlan(2_420_916, budget, "unreserved"), /Insufficient provider credit/);
  assert.throws(() => exposedCreditPlan(2_420_916, budget, undefined as never));
  const approved = exposedCreditPlan(2_420_916, budget, "owner-accepted-hold-overlap");
  assert.equal(approved.unreservedMicroUsd, 620_916);
  assert.equal(approved.spendableMicroUsd, 2_420_916);
  assert.equal(approved.cappedCreditMicroUsd - budget.reconciledSpendMicroUsd - budget.heldMicroUsd, 1_000_000);
  assert.ok(approved.cappedCreditMicroUsd <= budget.limitMicroUsd);
  assert.deepEqual(budget, original, "Accepting overlap is not a release or reconciliation of old reservations.");
  const unreserved = exposedCreditPlan(3_000_000, budget, "unreserved");
  assert.equal(unreserved.cappedCreditMicroUsd, budget.availableCreditMicroUsd);
  for (const remaining of [999_999, NaN, Infinity]) {
    assert.throws(() => exposedCreditPlan(remaining, budget, "owner-accepted-hold-overlap"), /Insufficient provider credit/);
  }
  assert.throws(() => exposedCreditPlan(2_420_916, { ...budget, limitMicroUsd: 4_000_000 }, "owner-accepted-hold-overlap"), /Insufficient campaign headroom/);
});

const selection = (caseId: string, artifactId: string, versionId: string, passageIds: string[]): Selection => ({
  caseId, artifactId, versionId, passageIds,
});
const testBinding: CandidateBinding = {
  candidateId: "candidate-test",
  sourceInventorySha256: "a".repeat(64),
  corpusManifestSha256: "b".repeat(64),
  corpusCatalogSha256: "c".repeat(64),
  modelProfileSha256: "d".repeat(64),
  campaignFreezeSha256: "e".repeat(64),
};

function exposedKey(requestId: string, request: string, selected: Selection[]) {
  return {
    requestId,
    request,
    expectedConclusion: requestId === "g4" ? "no_useful_precedent" : "precedent_found",
    expectedConditionalWork: selected.map(({ caseId, artifactId, versionId }) => ({
      caseId, artifactId, versionId, disposition: "adapt", reason: "Conditional starting work only.",
    })),
    expectedEvidence: [{
      caseId: selected[0]?.caseId ?? "harbor",
      artifactId: selected[0]?.artifactId ?? "request",
      versionId: selected[0]?.versionId ?? "request-v1",
      lineStart: 1,
      lineEnd: 2,
      sourceExpectation: "Check this evidence independently.",
    }],
    decisiveValuesAndUncertainty: ["Keep the exact limit."],
    acceptableUncertainty: ["State what remains unknown."],
    prohibitedRecommendations: ["Do not make an unsupported guarantee."],
    ...(requestId === "g4" ? { usefulImplementationSources: [] } : {}),
    humanSelectionExpectations: {
      actualSelectionRequired: selected.length > 0,
      substitutionAllowed: false,
      selections: selected,
      briefExpectation: selected.length ? "Keep each selected item conditional." : "Do not submit a brief.",
    },
  };
}

function campaignFixture() {
  const g2 = selection("elm", "adapter", "adapter-v1", ["p-a", "p-b"]);
  const g3 = selection("cedar", "mapping", "mapping-v1", ["p-c"]);
  const protocol = {
    protocolVersion: "issue32-exposed-g-v1",
    requestOrder: [...EXPOSED_REQUEST_ORDER],
    requests: [exposedKey("g2", "request g2", [g2]), exposedKey("g3", "request g3", [g3]), exposedKey("g4", "request g4", [])],
  };
  const requests = ["g2", "g3", "g4"].map((requestId) => ({ requestId, request: `request ${requestId}` }));
  return { campaign: buildExposedCampaign(protocol, requests), g2, g3, protocol, requests };
}

function rawRunCapture(campaign: FixedCampaign, requestId: string, binding: CandidateBinding, selections?: Selection[]) {
  const expected = campaign.cases.find((item) => item.requestId === requestId)!;
  const noBrief = requestId === "g4";
  return {
    schemaVersion: 1,
    requestId,
    campaignFreezeSha256: binding.campaignFreezeSha256,
    candidateId: binding.candidateId,
    sourceInventorySha256: binding.sourceInventorySha256,
    corpusManifestSha256: binding.corpusManifestSha256,
    corpusCatalogSha256: binding.corpusCatalogSha256,
    modelProfileSha256: binding.modelProfileSha256,
    assessmentState: "ready",
    assessmentResult: { conclusion: "captured raw assessment", claimIds: ["c1"] },
    briefState: noBrief ? "not_started" : "ready",
    briefResult: noBrief ? null : { status: "captured raw brief", text: "immutable observed response" },
    selectionSource: noBrief ? "no-brief-submitted" : "persisted-job-record",
    selections: selections ?? expected.selections,
  };
}

function verifiedCaptures(campaign: FixedCampaign, binding: CandidateBinding): VerifiedRunCapture[] {
  return campaign.cases.map((item, index) => verifyRunCapture(
    rawRunCapture(campaign, item.requestId, binding), (index + 1).toString(16).padStart(64, "0"), campaign, binding,
  ));
}

function gradeSubmission(campaign: FixedCampaign, binding: CandidateBinding, overrides: {
  omit?: string; uncertain?: string; verdict?: string; actualSelections?: Selection[];
  order?: string[]; reviewerId?: string;
} = {}) {
  return {
    schemaVersion: 1,
    campaignFreezeSha256: binding.campaignFreezeSha256,
    candidate: {
      candidateId: binding.candidateId,
      sourceInventorySha256: binding.sourceInventorySha256,
      corpusManifestSha256: binding.corpusManifestSha256,
      corpusCatalogSha256: binding.corpusCatalogSha256,
      modelProfileSha256: binding.modelProfileSha256,
    },
    graderIdentity: {
      reviewerId: overrides.reviewerId ?? "independent-reviewer-17",
      role: "independent-grader",
      reviewedAt: "2026-10-18T12:00:00Z",
      independenceAttested: true,
    },
    requestOrder: overrides.order ?? [...EXPOSED_REQUEST_ORDER],
    cases: (overrides.order ?? [...EXPOSED_REQUEST_ORDER]).map((requestId) => {
      const expected = campaign.cases.find((item) => item.requestId === requestId)!;
      return {
        requestId,
        ...(overrides.actualSelections && requestId === "g2" ? { actualSelections: overrides.actualSelections } : {}),
        grades: expected.criteria.filter((criterion) => criterion.criterionId !== overrides.omit).map((criterion) => ({
          criterionId: criterion.criterionId,
          verdict: criterion.criterionId === overrides.uncertain ? "uncertain" : overrides.verdict ?? "pass",
          rationale: `Independent check for ${criterion.criterionId}.`,
        })),
      };
    }),
  };
}

function selectionFixture(role: "starting_point" | "context_only" | "not_relevant") {
  const caseId = "case-1";
  const artifactId = "artifact-1";
  const passages = ["p-cited", "p-uncited"].map((passageId) => ({
    passageId,
    excerpt: passageId,
    sourceKind: "native" as const,
    location: { type: "text" as const, startLine: 1, endLine: 1 },
  }));
  const selectedVersion: SourceVersion = {
    versionId: "source-v1", sourcePath: "corpus/originals/case-1/source.md", mimeType: "text/markdown",
    sha256: "a".repeat(64), statedDate: null, importedAt: "2026-01-01T00:00:00Z", extractionStatus: "complete",
    exclusionReasons: [], passages,
  };
  const otherVersion: SourceVersion = {
    ...selectedVersion,
    versionId: "source-v2",
    sha256: "b".repeat(64),
    passages: [{ ...passages[0], passageId: "p-v2" }],
  };
  const artifact: Artifact = { artifactId, title: "Artifact", fictional: true, versions: [selectedVersion, otherVersion] };
  const pastCase: PastCase = { caseId, title: "Case", fictional: true, artifacts: [artifact], records: [] };
  const indexed = (passageId: string, sourceVersionId: string): IndexedPassage => ({
    caseId, artifactId, versionId: sourceVersionId, passageId, title: "Artifact", fictional: true, statedDate: null,
    excerpt: passageId, sourceKind: "native", location: { type: "text", startLine: 1, endLine: 1 },
  });
  const sourceMap = new Map([
    ["source-v1", { version: selectedVersion, artifact, pastCase }],
    ["source-v2", { version: otherVersion, artifact, pastCase }],
  ]);
  const passageMap = new Map([
    ["p-cited", indexed("p-cited", "source-v1")],
    ["p-uncited", indexed("p-uncited", "source-v1")],
    ["p-v2", indexed("p-v2", "source-v2")],
  ]);
  const corpus: CorpusSnapshot = {
    manifest: { schemaVersion: 2, corpusVersion: "test", cases: [pastCase] },
    manifestSha256: "c".repeat(64), availableVersions: new Set(["source-v1", "source-v2"]),
    caseAvailability: new Map([[caseId, "available"]]), passages: passageMap, versions: sourceMap,
  };
  const sourceRefs = [{ caseId, artifactId, versionId: "source-v1", passageId: "p-cited" }];
  const historyClaim: Claim = {
    claimId: "history", text: "Recorded source history.", kind: "source_fact",
    sourceRefs, requestQuotes: [], dependsOnClaimIds: [],
  };
  const operationClaim: Claim = {
    claimId: "operation", text: "The historical operation is data mapping.", kind: "interpretation",
    sourceRefs, requestQuotes: [], dependsOnClaimIds: [historyClaim.claimId],
  };
  const dispositionClaim: Claim = {
    claimId: "decision", text: "Adapt this checked source.", kind: "recommendation",
    sourceRefs, requestQuotes: [], dependsOnClaimIds: [historyClaim.claimId, operationClaim.claimId],
  };
  const adaptationClaim: Claim = {
    claimId: "adaptation", text: "Adapt the recorded mapping to the client.", kind: "recommendation",
    sourceRefs, requestQuotes: [], dependsOnClaimIds: [dispositionClaim.claimId, historyClaim.claimId],
  };
  const checkClaim: Claim = {
    claimId: "check", text: OPERATION_CHECKS.data_mapping.field_identity, kind: "recommendation",
    sourceRefs, requestQuotes: [], dependsOnClaimIds: [dispositionClaim.claimId, historyClaim.claimId],
  };
  const artifactClaims = [historyClaim, operationClaim, dispositionClaim, adaptationClaim, checkClaim];
  const assessment: AssessmentResult = {
    conclusion: "precedent_found", clarifyingClaimIds: [], comparisons: [],
    missingEvidenceRequests: [], missingEvidenceReview: { verdict: "supported", reason: null, claimIds: [] },
    requestConstraints: { product_version: [], environment: [], scale: [], identity_access: [], recovery_operations: [] },
    artifactReviews: [{
      caseId, artifactId, role, verdict: "supported", reasons: [],
      claimFindings: [historyClaim, operationClaim, adaptationClaim, checkClaim].map((claim) => ({ claimId: claim.claimId, verdict: "supported" as const, reason: null })),
      decision: {
        disposition: "adapt", operation: "data_mapping", historicalEvidence: sourceRefs, requestQuotes: [],
        adaptations: [{ text: adaptationClaim.text, sourceRefs, requestQuotes: [] }],
        checks: [{ kind: "field_identity", text: checkClaim.text, sourceRefs, requestQuotes: [] }],
        obligations: [],
      },
    }],
    nextActions: [],
    cases: [{
      caseId, availability: "available", outcome: "unknown", outcomeClaimIds: [], claimIds: artifactClaims.map((claim) => claim.claimId),
      artifactWork: [{
        artifactId, availability: "available", exclusionReasons: [], disposition: "adapt", dispositionClaimId: "decision",
        claimIds: artifactClaims.map((claim) => claim.claimId), blockerClaimIds: [], verificationClaimIds: ["check"],
      }],
    }],
    leads: [], contrasts: [], claims: artifactClaims, withheldClaimCount: 0,
  };
  return { caseId, artifactId, assessment, corpus };
}

test("the fixed campaign freezes only g2 to g4 and grades every rubric leaf", () => {
  const { campaign, g2, g3, protocol, requests } = campaignFixture();
  assert.deepEqual(campaign.requestOrder, ["g2", "g3", "g4"]);
  assert.deepEqual(campaign.cases.map((item) => item.requestId), ["g2", "g3", "g4"]);
  assert.deepEqual(campaign.cases[0].selections, [g2]);
  assert.deepEqual(campaign.cases[1].selections, [g3]);
  assert.deepEqual(campaign.cases[2].selections, []);
  assert.ok(campaign.cases[0].criteria.some((item) => item.criterionId === "expectedEvidence[0].lineStart"));
  assert.ok(campaign.cases[0].criteria.some((item) => item.criterionId === "expectedEvidence[0].sourceExpectation"));
  assert.ok(campaign.cases[2].criteria.some((item) => item.criterionId === "usefulImplementationSources"));
  assert.throws(() => buildExposedCampaign({ ...protocol, requests: [exposedKey("g1", "request g1", [])] }, requests));
  assert.throws(() => buildExposedCampaign(protocol, [...requests, { requestId: "g1", request: "not allowed" }]));
});

test("selection equality catches every missing or extra exact passage identity", () => {
  const expected = [selection("case", "artifact", "v1", ["p-a", "p-b"])];
  assert.equal(selectionsMatch(expected, [selection("case", "artifact", "v1", ["p-b", "p-a"])]), true);
  assert.equal(selectionsMatch(expected, [selection("case", "artifact", "v1", ["p-a"])]), false);
  assert.equal(selectionsMatch(expected, [selection("case", "artifact", "v1", ["p-a", "p-b", "p-extra"])]), false);
  assert.equal(selectionsMatch(expected, [selection("case", "artifact", "v2", ["p-a", "p-b"])]), false);
  assert.equal(selectionsMatch(expected, [selection("case", "artifact", "v1", ["p-a", "p-b"]), selection("other", "artifact", "v1", ["p-c"])]), false);
});

test("grades use hashed run captures, not reviewer-supplied selections, and every criterion must pass", () => {
  const { campaign } = campaignFixture();
  const captures = verifiedCaptures(campaign, testBinding);
  const passing = gradeCampaign(campaign, captures, gradeSubmission(campaign, testBinding), "f".repeat(64));
  assert.equal(passing.passed, true);
  assert.ok(passing.cases.every((item) => item.runCaptureSha256 && item.criteria.every((grade) => grade.verdict === "pass")));
  assert.equal(passing.graderIdentity?.reviewerId, "independent-reviewer-17");

  const missing = gradeCampaign(campaign, captures, gradeSubmission(campaign, testBinding, { omit: campaign.cases[1].criteria[1].criterionId }), "f".repeat(64));
  assert.equal(missing.passed, false);
  assert.ok(missing.cases[1].criteria.some((item) => item.verdict === "missing"));

  const uncertain = gradeCampaign(campaign, captures, gradeSubmission(campaign, testBinding, { uncertain: campaign.cases[0].criteria[0].criterionId }), "f".repeat(64));
  assert.equal(uncertain.passed, false);
  assert.equal(uncertain.cases[0].criteria[0].verdict, "uncertain");

  const badVerdict = gradeCampaign(campaign, captures, gradeSubmission(campaign, testBinding, { verdict: "maybe" }), "f".repeat(64));
  assert.equal(badVerdict.passed, false);
  assert.ok(badVerdict.errors.includes("MALFORMED_OR_UNIDENTIFIED_GRADES"));

  const manualSelections = gradeCampaign(campaign, captures, gradeSubmission(campaign, testBinding, {
    actualSelections: [selection("elm", "adapter", "adapter-v1", ["p-a"])],
  }), "f".repeat(64));
  assert.equal(manualSelections.passed, false);
  assert.ok(manualSelections.errors.includes("MALFORMED_OR_UNIDENTIFIED_GRADES"));

  const wrongCapture = rawRunCapture(campaign, "g2", testBinding, [selection("elm", "adapter", "adapter-v1", ["p-a"])]);
  const mismatch = [verifyRunCapture(wrongCapture, "1".repeat(64), campaign, testBinding), ...captures.slice(1)];
  assert.equal(gradeCampaign(campaign, mismatch, gradeSubmission(campaign, testBinding), "f".repeat(64)).cases[0].selectionCheck, "fail");
  const g4WithBrief = rawRunCapture(campaign, "g4", testBinding);
  g4WithBrief.briefState = "ready";
  g4WithBrief.briefResult = { status: "unexpected", text: "Unexpected captured brief." };
  g4WithBrief.selectionSource = "persisted-job-record";
  assert.throws(() => verifyRunCapture(g4WithBrief, "2".repeat(64), campaign, testBinding), /RUN_CAPTURE_STATE_MISMATCH/);
  assert.equal(gradeCampaign(campaign, [], gradeSubmission(campaign, testBinding), "f".repeat(64)).passed, false);
});

test("failure captures are exclusive and preserve their original bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "issue32-capture-"));
  try {
    const original = { passed: false, reason: "criterion missing" };
    const digest = await writeImmutableCapture(directory, "grade-result.json", original);
    const bytes = await readFile(join(directory, "grade-result.json"));
    assert.equal(bytes.toString(), `${JSON.stringify(original, null, 2)}\n`);
    assert.equal(digest, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(await readFile(join(directory, "grade-result.json.sha256"), "utf8"), `${digest}  grade-result.json\n`);
    await assert.rejects(writeImmutableCapture(directory, "grade-result.json", { passed: true }), { code: "EEXIST" });
    assert.deepEqual(await readFile(join(directory, "grade-result.json")), bytes);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("the h gate requires exposed pass and separate authorization bound to full candidate identity", () => {
  const sha = "a".repeat(64);
  const pass = {
    requestOrder: ["g2", "g3", "g4"], passed: true, captureSha256: sha,
    campaignFreezeSha256: testBinding.campaignFreezeSha256, candidateId: testBinding.candidateId,
    sourceInventorySha256: testBinding.sourceInventorySha256, corpusManifestSha256: testBinding.corpusManifestSha256,
    corpusCatalogSha256: testBinding.corpusCatalogSha256, modelProfileSha256: testBinding.modelProfileSha256,
  };
  const authorization = {
    authorizationId: "approval-1", authorizedBy: "operator", authorizedAt: "2026-10-18T12:00:00Z",
    scope: "h-one-shot" as const, exposedPassSha256: sha,
    campaignFreezeSha256: pass.campaignFreezeSha256, candidateId: pass.candidateId,
    sourceInventorySha256: pass.sourceInventorySha256, corpusManifestSha256: pass.corpusManifestSha256,
    corpusCatalogSha256: pass.corpusCatalogSha256, modelProfileSha256: pass.modelProfileSha256,
  };
  assert.equal(deriveHGate(null, authorization).status, "blocked");
  assert.equal(deriveHGate({ ...pass, passed: false }, authorization).status, "blocked");
  assert.equal(deriveHGate(pass, null).status, "blocked");
  assert.equal(deriveHGate(pass, { ...authorization, exposedPassSha256: "b".repeat(64) }).status, "blocked");
  assert.equal(deriveHGate(pass, { ...authorization, modelProfileSha256: "f".repeat(64) }).status, "blocked");
  assert.equal(deriveHGate(pass, authorization).status, "eligible");
});


test("selection allows uncited genuine passages only from the checked exact version", () => {
  const fixture = selectionFixture("starting_point");
  const selected = selection(fixture.caseId, fixture.artifactId, "source-v1", ["p-uncited"]);
  assert.deepEqual(validateSelections([selected], fixture.assessment, fixture.corpus), [selected]);
  const uncheckedVersion = selection(fixture.caseId, fixture.artifactId, "source-v2", ["p-v2"]);
  assert.throws(() => validateSelections([uncheckedVersion], fixture.assessment, fixture.corpus), /UNAVAILABLE_OR_UNCHECKED_SELECTION/);
});

test("context-only, rejected, and unchecked-decision artifacts cannot be selected", () => {
  for (const role of ["context_only", "not_relevant"] as const) {
    const fixture = selectionFixture(role);
    assert.throws(() => validateSelections([selection(fixture.caseId, fixture.artifactId, "source-v1", ["p-cited"])], fixture.assessment, fixture.corpus), /UNAVAILABLE_OR_UNCHECKED_SELECTION/);
  }
  const unchecked = selectionFixture("starting_point");
  unchecked.assessment.cases[0].artifactWork[0].disposition = null;
  unchecked.assessment.cases[0].artifactWork[0].dispositionClaimId = null;
  assert.throws(() => validateSelections([selection(unchecked.caseId, unchecked.artifactId, "source-v1", ["p-cited"])], unchecked.assessment, unchecked.corpus), /UNAVAILABLE_OR_UNCHECKED_SELECTION/);
});

test("offline campaign preparation preserves frozen captures and defaults to no provider access", async () => {
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), "issue32-offline-cli-"));
  try {
    const protocol = JSON.parse(await readFile(join(repo, "evaluation/issue32-exposed-g-protocol.json"), "utf8"));
    const requests = join(directory, "requests.json");
    await writeFile(requests, JSON.stringify(protocol.requests.map(({ requestId, request }: { requestId: string; request: string }) => ({ requestId, request }))));
    const out = join(directory, "freeze");
    const args = ["--experimental-strip-types", "scripts/issue32-campaign.mjs", "prepare", "--repo", repo,
      "--protocol", "evaluation/issue32-exposed-g-protocol.json", "--profile", "evaluation/issue32-exposed-runtime-profile.json",
      "--requests", requests, "--out", out];
    const prepared = spawnSync(process.execPath, args, { cwd: repo, encoding: "utf8" });
    assert.equal(prepared.status, 0, prepared.stderr);
    const result = JSON.parse(prepared.stdout);
    assert.equal(result.providerCalls, 0);
    assert.equal(result.hGate.status, "blocked");
    const capture = await readFile(join(out, "campaign-freeze.json"));
    assert.equal(await readFile(join(out, "campaign-freeze.json.sha256"), "utf8"),
      `${createHash("sha256").update(capture).digest("hex")}  campaign-freeze.json\n`);
    const repeated = spawnSync(process.execPath, args, { cwd: repo, encoding: "utf8" });
    assert.notEqual(repeated.status, 0);
    assert.deepEqual(await readFile(join(out, "campaign-freeze.json")), capture);
    const unauthorized = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/issue32-run-exposed.mjs"], { cwd: repo, encoding: "utf8" });
    assert.notEqual(unauthorized.status, 0);
    assert.deepEqual(JSON.parse(unauthorized.stderr), { error: "MISSING_OPTION:--mode", providerCalls: 0 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
