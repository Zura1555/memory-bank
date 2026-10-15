import assert from "node:assert/strict";
import test from "node:test";
import type { AssessmentResult, Claim, Selection, SupportVerdict } from "../shared/protocol.ts";
import { parseAssessmentDraft, type AssessmentDraft, type AssessmentOutput, type BriefDraft } from "./schemas.ts";
import { buildCheckedAssessment, buildCheckedBrief, GateFailure, revalidateAssessment, revalidateBrief, validateAssessmentDraft, validateBriefDraft, validateLeadReview, validateSupportReview } from "./gates.ts";
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
    const pastCase: PastCase = { caseId, title: `Fictional case ${index}`, fictional: true, artifacts: [], records: [] };
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
    manifest: { schemaVersion: 2, corpusVersion: "test-v1", cases },
    manifestSha256: "b".repeat(64),
    availableVersions,
    caseAvailability,
    passages,
    versions,
  };
}

function assessmentDraft(corpus: CorpusSnapshot): AssessmentDraft {
  const claims: Claim[] = corpus.manifest.cases.flatMap((pastCase, caseIndex) => pastCase.artifacts.flatMap((artifact, artifactIndex) => {
    const version = artifact.versions[0];
    const sourceRefs = [{ caseId: pastCase.caseId, artifactId: artifact.artifactId, versionId: version.versionId, passageId: version.passages[0].passageId }];
    const suffix = `${caseIndex}-${artifactIndex}`;
    return [
      { claimId: `fact-${suffix}`, text: "Recorded work", kind: "source_fact", sourceRefs, requestQuotes: [], dependsOnClaimIds: [] },
      { claimId: `decision-${suffix}`, text: "Adapt the recorded work after checking the client's capabilities.", kind: "recommendation", sourceRefs, requestQuotes: ["current request"], dependsOnClaimIds: [`fact-${suffix}`] },
    ];
  }));
  return {
    cases: corpus.manifest.cases.map((pastCase, caseIndex) => ({
      caseId: pastCase.caseId,
      outcome: "observed_success",
      outcomeClaimIds: [`fact-${caseIndex}-0`],
      claimIds: pastCase.artifacts.map((_, artifactIndex) => `fact-${caseIndex}-${artifactIndex}`),
      artifactWork: pastCase.artifacts.map((artifact, artifactIndex) => ({
        artifactId: artifact.artifactId,
        disposition: "adapt",
        dispositionClaimId: `decision-${caseIndex}-${artifactIndex}`,
        claimIds: [`fact-${caseIndex}-${artifactIndex}`, `decision-${caseIndex}-${artifactIndex}`],
        blockerClaimIds: [],
        verificationClaimIds: [],
      })),
    })),
    leads: [],
    contrasts: [],
    clarifyingClaimIds: [],
    claims,
  };
}

test("assessment rejects omitted artifacts even when all eight cases are present", () => {
  const corpus = fixture();
  const draft = assessmentDraft(corpus);
  draft.cases[0].artifactWork.pop();
  assert.throws(
    () => validateAssessmentDraft(draft, "current request", corpus),
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

test("artifact recommendations and role claims remain independently reviewable", () => {
  const corpus = fixture();
  const draft = assessmentDraft(corpus);
  const byId = new Map(draft.claims.map((claim) => [claim.claimId, claim]));
  const output: AssessmentOutput = {
    ...draft,
    claims: draft.claims.filter((claim) => claim.kind !== "recommendation"),
    cases: draft.cases.map((item) => ({
      ...item,
      artifactWork: item.artifactWork.map((work) => {
        const { claimId: _, kind: __, ...recommendation } = byId.get(work.dispositionClaimId)!;
        return {
          artifactId: work.artifactId, disposition: "adapt", recommendation,
          supportingClaims: work.claimIds.filter((id) => id !== work.dispositionClaimId).map((id) => {
            const { claimId: _, ...claim } = byId.get(id)!;
            return claim;
          }),
          blockerClaims: [], verificationClaims: [],
        };
      }),
    })),
  };
  const { claimId: _, ...blocker } = {
    ...draft.claims[0], kind: "recommendation" as const, text: "Verify the new target before adaptation.",
    dependsOnClaimIds: ["fact-0-1"],
  };
  output.cases[0].artifactWork[0].blockerClaims.push(blocker);
  const parsed = parseAssessmentDraft(output);
  const invalid = validateAssessmentDraft(parsed, "current request", corpus);
  const rejected = parsed.cases[0].artifactWork[0].dispositionClaimId;
  const kept = parsed.cases[0].artifactWork[1].dispositionClaimId;
  parsed.leads = [{ caseId: "case-1", state: "conditional", usefulArtifactIds: ["handover"], reasonClaimIds: ["fact-0-1"] }];
  const verdicts = new Map<string, SupportVerdict>(parsed.claims.map((claim) => [claim.claimId, claim.claimId === rejected ? "unsupported" : "supported"]));
  const checked = buildCheckedAssessment(parsed, verdicts, invalid, corpus, new Map([["case-1/handover", "supported"]]), "precedent_found");
  assert.equal(checked.cases[0].artifactWork[0].disposition, null);
  assert.equal(checked.cases[0].artifactWork[1].disposition, "adapt");
  assert.ok(checked.claims.some((claim) => claim.claimId === kept));
  assert.ok(checked.claims.some((claim) => claim.claimId === parsed.cases[0].artifactWork[0].blockerClaimIds[0]));
  assert.deepEqual(parsed.claims.find((claim) => claim.claimId === parsed.cases[0].artifactWork[0].blockerClaimIds[0])?.dependsOnClaimIds, ["fact-0-1"]);
  const wrongOwner = structuredClone(output);
  wrongOwner.cases[0].artifactWork[1].blockerClaims.push(blocker);
  assert.throws(
    () => validateAssessmentDraft(parseAssessmentDraft(wrongOwner), "current request", corpus),
    (error: unknown) => error instanceof GateFailure && error.code === "CLAIM_ARTIFACT_SCOPE",
  );
});

test("true historical facts cannot promote an incompatible artifact into a useful precedent", () => {
  const corpus = fixture();
  const draft = assessmentDraft(corpus);
  draft.leads = [{ caseId: "case-1", state: "partial", usefulArtifactIds: ["request"], reasonClaimIds: ["fact-0-0"] }];
  const review = {
    conclusion: "no_useful_precedent" as const,
    claimReviews: draft.claims.map((claim) => ({ claimId: claim.claimId, verdict: "supported" as const })),
    leadReviews: [{ caseId: "case-1", artifactId: "request", verdict: "unsupported" as const }],
  };
  const checked = buildCheckedAssessment(draft, validateSupportReview(draft.claims, review), new Set(), corpus, validateLeadReview(draft, review), review.conclusion);
  assert.equal(checked.conclusion, "no_useful_precedent");
  assert.deepEqual(checked.leads, []);
  assert.equal(checked.cases[0].artifactWork[0].disposition, null);
  assert.ok(checked.claims.some((claim) => claim.claimId === "fact-0-0"));
  const uncertain = { ...review, conclusion: "cannot_be_established" as const, leadReviews: [{ caseId: "case-1", artifactId: "request", verdict: "uncertain" as const }] };
  assert.equal(buildCheckedAssessment(draft, validateSupportReview(draft.claims, uncertain), new Set(), corpus, validateLeadReview(draft, uncertain), uncertain.conclusion).conclusion, "cannot_be_established");
});

test("persisted assessments and briefs lose claims transitively when original evidence becomes unavailable", () => {
  const corpus = fixture();
  const draft = assessmentDraft(corpus);
  draft.claims.find((claim) => claim.claimId === "decision-0-1")!.dependsOnClaimIds.push("fact-0-0");
  draft.leads = [{ caseId: "case-1", state: "conditional", usefulArtifactIds: ["handover"], reasonClaimIds: ["fact-0-1"] }];
  const verdicts = new Map<string, SupportVerdict>(draft.claims.map((claim) => [claim.claimId, "supported"]));
  const persisted = buildCheckedAssessment(draft, verdicts, new Set(), corpus, new Map([["case-1/handover", "supported"]]), "precedent_found");
  const base = { ...draft.claims[0], sourceRefs: [...draft.claims[0].sourceRefs, ...draft.claims[2].sourceRefs] };
  const dependent = { ...draft.claims[3], dependsOnClaimIds: [base.claimId] };
  const brief = {
    reuse: [], verify: [],
    adapt: [{ caseId: "case-1", artifactId: "handover", versionId: dependent.sourceRefs[0].versionId, disposition: "adapt" as const, dispositionClaimId: dependent.claimId, claimIds: [base.claimId, dependent.claimId] }],
    claims: [base, dependent], withheldClaimCount: 0,
  };
  validateBriefDraft(brief, "current request", [{ caseId: "case-1", artifactId: "handover", versionId: dependent.sourceRefs[0].versionId }], corpus);
  assert.equal(revalidateBrief(brief, "current request", corpus).adapt[0].disposition, "adapt");
  corpus.availableVersions.delete("request-v1");
  corpus.passages.delete("p-request-v1");
  corpus.caseAvailability.set("case-1", "partial");
  const current = revalidateAssessment(persisted, "current request", corpus);
  assert.equal(current.conclusion, "cannot_be_established");
  assert.deepEqual(current.leads, []);
  assert.equal(current.cases[0].outcome, "unknown");
  assert.equal(current.cases[0].artifactWork[1].disposition, null);
  assert.ok(!current.claims.some((claim) => ["fact-0-0", "decision-0-1"].includes(claim.claimId)));
  assert.ok(current.claims.some((claim) => claim.claimId === "fact-1-0"));
  const currentBrief = revalidateBrief(brief, "current request", corpus);
  assert.deepEqual(currentBrief.adapt, []);
  assert.deepEqual(currentBrief.claims, []);
  assert.equal(currentBrief.withheldClaimCount, 2);
  corpus.availableVersions.add("request-v1");
  corpus.passages.set("p-request-v1", {
    ...base.sourceRefs[0], title: "request", fictional: true, statedDate: null,
    excerpt: "Restored verified evidence", sourceKind: "native", location: { type: "text", startLine: 1, endLine: 1 },
  });
  corpus.caseAvailability.set("case-1", "available");
  assert.equal(revalidateAssessment(persisted, "current request", corpus).conclusion, "precedent_found");
});
