import assert from "node:assert/strict";
import test from "node:test";
import type { AssessmentResult, Claim, Selection, SupportVerdict } from "../shared/protocol.ts";
import type { AssessmentDraft, BriefDraft } from "./schemas.ts";
import { buildCheckedBrief, GateFailure, validateAssessmentDraft, validateBriefDraft, validateSupportReview } from "./gates.ts";
import { validateSelections } from "./selections.ts";
import type { Artifact, CorpusSnapshot, PastCase, SourceVersion } from "./corpus.ts";

function fixture(): CorpusSnapshot {
  const cases: PastCase[] = [];
  const availableVersions = new Set<string>();
  const caseAvailability = new Map<string, "available" | "partial" | "unavailable">();
  const passages = new Map();
  const versions = new Map<string, { version: SourceVersion; artifact: Artifact; pastCase: PastCase }>();
  for (let index = 1; index <= 8; index++) {
    const caseId = `case-${index}`;
    const pastCase: PastCase = { caseId, title: `Fictional case ${index}`, fictional: true, artifacts: [] };
    const artifactIds = index === 1 ? ["request", "handover"] : ["request"];
    for (const artifactId of artifactIds) {
      const sourceVersions = index === 1 && artifactId === "request" ? ["request-v1", "request-v2"] : [`${artifactId}-v1-${caseId}`];
      const artifact: Artifact = { artifactId, title: artifactId, fictional: true, versions: [] };
      for (const versionId of sourceVersions) {
        const passageId = `p-${versionId}`;
        const version: SourceVersion = {
          versionId,
          sourcePath: `corpora/test-v1/originals/${caseId}/${artifactId}.txt`,
          mimeType: "text/plain",
          sha256: "a".repeat(64),
          statedDate: null,
          importedAt: "2026-10-14T00:00:00.000Z",
          extractionStatus: "complete",
          exclusionReasons: [],
          passages: [{ passageId, excerpt: `Evidence from ${versionId}`, sourceKind: "native", location: { type: "text", startLine: 1, endLine: 1 } }],
        };
        artifact.versions.push(version);
        availableVersions.add(versionId);
        passages.set(passageId, {
          caseId,
          artifactId,
          versionId,
          passageId,
          title: artifact.title,
          fictional: true,
          statedDate: null,
          excerpt: version.passages[0].excerpt,
          sourceKind: "native",
          location: version.passages[0].location,
        });
        versions.set(versionId, { version, artifact, pastCase });
      }
      pastCase.artifacts.push(artifact);
    }
    cases.push(pastCase);
    caseAvailability.set(caseId, "available");
  }
  return {
    manifest: { schemaVersion: 1, corpusVersion: "test-v1", cases },
    manifestSha256: "b".repeat(64),
    availableVersions,
    caseAvailability,
    passages,
    versions,
  };
}

function assessmentDraft(corpus: CorpusSnapshot): AssessmentDraft {
  const claims: Claim[] = corpus.manifest.cases.flatMap((pastCase, index) => {
    const artifact = pastCase.artifacts[0];
    const version = artifact.versions[0];
    const passage = version.passages[0];
    const sourceRefs = [{ caseId: pastCase.caseId, artifactId: artifact.artifactId, versionId: version.versionId, passageId: passage.passageId }];
    return [
      {
        claimId: `claim-${index + 1}`,
        text: `Evidence from ${pastCase.caseId}`,
        kind: "source_fact",
        sourceRefs,
        requestQuotes: ["current request"],
        dependsOnClaimIds: [],
      },
      {
        claimId: `decision-${index + 1}`,
        text: `Adapt the checked ${artifact.artifactId} work for this request.`,
        kind: "recommendation",
        sourceRefs,
        requestQuotes: ["current request"],
        dependsOnClaimIds: [],
      },
    ];
  });
  return {
    cases: corpus.manifest.cases.map((pastCase, index) => ({
      caseId: pastCase.caseId,
      outcome: "unknown",
      outcomeClaimIds: [],
      claimIds: [claims[index * 2].claimId],
      artifactWork: [{
        artifactId: pastCase.artifacts[0].artifactId,
        disposition: "adapt",
        dispositionClaimId: claims[index * 2 + 1].claimId,
        claimIds: [claims[index * 2].claimId, claims[index * 2 + 1].claimId],
        blockerClaimIds: [],
        verificationClaimIds: [],
      }],
    })),
    leads: [],
    contrasts: [],
    clarifyingClaimIds: [],
    claims,
  };
}

test("assessment rejects omitted artifacts even when all eight cases are present", () => {
  const corpus = fixture();
  assert.throws(
    () => validateAssessmentDraft(assessmentDraft(corpus), "current request", corpus),
    (error: unknown) => error instanceof GateFailure && error.code === "INCOMPLETE_ARTIFACT_WORK",
  );
});

test("selection cannot substitute a different version of an assessed artifact", () => {
  const corpus = fixture();
  const caseId = "case-1";
  const claim: Claim = {
    claimId: "checked-claim",
    text: "Adapt the checked work for this request.",
    kind: "recommendation",
    sourceRefs: [{ caseId, artifactId: "request", versionId: "request-v1", passageId: "p-request-v1" }],
    requestQuotes: ["current request"],
    dependsOnClaimIds: [],
  };
  const assessment: AssessmentResult = {
    conclusion: "precedent_found",
    clarifyingClaimIds: [],
    cases: [{ caseId, availability: "available", outcome: "unknown", outcomeClaimIds: [], claimIds: [claim.claimId], artifactWork: [{ artifactId: "request", availability: "available", exclusionReasons: [], disposition: "adapt", dispositionClaimId: claim.claimId, claimIds: [claim.claimId], blockerClaimIds: [], verificationClaimIds: [] }] }],
    leads: [],
    contrasts: [],
    claims: [claim],
    withheldClaimCount: 0,
  };
  const selection: Selection = { caseId, artifactId: "request", versionId: "request-v2", passageIds: ["p-request-v2"] };
  assert.throws(
    () => validateSelections([selection], assessment, corpus),
    (error: unknown) => error instanceof Error && error.message === "INVALID_SELECTION_PASSAGE",
  );
});
test("brief disposition is withheld when its recommendation claim is unsupported", () => {
  const corpus = fixture();
  const caseId = "case-1";
  const sourceRefs = [{ caseId, artifactId: "request", versionId: "request-v1", passageId: "p-request-v1" }];
  const factual: Claim = {
    claimId: "factual",
    text: "The source records the work.",
    kind: "source_fact",
    sourceRefs,
    requestQuotes: ["current request"],
    dependsOnClaimIds: [],
  };
  const recommendation: Claim = {
    claimId: "disposition",
    text: "Reuse this work unchanged.",
    kind: "recommendation",
    sourceRefs,
    requestQuotes: ["current request"],
    dependsOnClaimIds: [],
  };
  const draft: BriefDraft = {
    reuse: [{ caseId, artifactId: "request", versionId: "request-v1", disposition: "reuse", dispositionClaimId: recommendation.claimId, claimIds: [factual.claimId, recommendation.claimId] }],
    adapt: [],
    verify: [],
    claims: [factual, recommendation],
  };
  const selections = [{ caseId, artifactId: "request", versionId: "request-v1" }];
  const invalidRefs = validateBriefDraft(draft, "current request", selections, corpus);
  const checked = buildCheckedBrief(draft, new Map<string, SupportVerdict>([
    [factual.claimId, "supported"],
    [recommendation.claimId, "unsupported"],
  ]), invalidRefs);
  assert.deepEqual(checked.reuse, []);
  assert.deepEqual(checked.claims.map((claim) => claim.claimId), [factual.claimId]);
});


test("support review must cover each claim exactly once", () => {
  const claim: Claim = {
    claimId: "claim-one",
    text: "A checked statement.",
    kind: "source_fact",
    sourceRefs: [{ caseId: "case-1", artifactId: "request", versionId: "request-v1", passageId: "p-request-v1" }],
    requestQuotes: [],
    dependsOnClaimIds: [],
  };
  assert.throws(
    () => validateSupportReview([claim], { claimReviews: [] }),
    (error: unknown) => error instanceof GateFailure && error.code === "INCOMPLETE_SUPPORT_REVIEW",
  );
});
