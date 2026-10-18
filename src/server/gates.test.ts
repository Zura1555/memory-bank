import assert from "node:assert/strict";
import Ajv from "ajv";
import test from "node:test";
import type { ArtifactReview, ArtifactRole, AssessmentResult, Claim, RequestConstraints, Selection, SupportVerdict } from "../shared/protocol.ts";
import { OPERATION_CHECKS, type OperationCheckKind, type OperationKind } from "../shared/operations.ts";
import { assessmentDraftSchema, assessmentReviewSchema, briefDraftSchema, openRouterSchema, parseAssessmentDraft, reviewSchema, type AssessmentDraft, type AssessmentOutput, type BriefDraft } from "./schemas.ts";
import { boundAssessmentQuotes, buildCheckedAssessment, buildCheckedBrief, GateFailure, revalidateAssessment, revalidateBrief, validateAssessmentDraft, validateBriefDraft, validateArtifactReview, validateSupportReview } from "./gates.ts";
import { HttpFailure } from "./errors.ts";
import { jobView, type JobRecord } from "./jobs.ts";
import { buildStarterPack } from "./packs.ts";
import { validateSelections } from "./selections.ts";
import { assessmentPassageIds, EvidenceUnavailable, type Artifact, type CorpusSnapshot, type ModelCaseContext, type PastCase, type SourceVersion } from "./corpus.ts";
import { requestSpans } from "./request-constraints.ts";
import { dispositionChanges } from "../ui/lineage.ts";
import { assessmentDraftPrompt, assessmentReviewPrompt, briefDraftPrompt, briefReviewPrompt, selectedAssessment } from "./prompts.ts";
import { callModel } from "./model.ts";
import type { Env } from "./env.ts";

const currentRequest = "Assess this current request.";
const emptyRequirementReview: { request: string; constraints: RequestConstraints } = {
  request: currentRequest,
  constraints: { product_version: [], environment: [], scale: [], identity_access: [], recovery_operations: [] },
};

function requestSpanId(request: string, text: string): string {
  const span = requestSpans(request).find((item) => item.text === text);
  if (!span) throw new Error(`No request span for ${JSON.stringify(text)}.`);
  return span.spanId;
}

function artifactRoles(draft: AssessmentDraft, role: ArtifactRole = "starting_point"): Map<string, ArtifactReview> {
  return new Map(draft.cases.flatMap((item) => item.artifactWork.map((work) => [
    `${item.caseId}/${work.artifactId}`,
    { caseId: item.caseId, artifactId: work.artifactId, role, decision: work.decision, verdict: "supported" as const, reasons: [] },
  ])));
}

function proposal(
  artifactId: string,
  historicalEvidence: string[],
  disposition: "adapt" | "reuse" | "verify" | null = "adapt",
  requestQuotes: string[] = [],
  operation: OperationKind = "api_adapter",
): AssessmentOutput["cases"][number]["artifactWork"][number] {
  if (disposition === null) return { artifactId, disposition, operation: null, historicalEvidence, requestQuotes, adaptations: [], checks: [] };
  if (disposition === "reuse") return { artifactId, disposition, operation, historicalEvidence, requestQuotes, adaptations: [], checks: [] };
  const checks = Object.keys(OPERATION_CHECKS[operation]).slice(0, 1).map((kind) => ({
    kind: kind as OperationCheckKind, sourceRefs: historicalEvidence, requestQuotes: requestQuotes.slice(0, 1),
  }));
  return assessmentDraftSchema.shape.cases.element.shape.artifactWork.element.parse({
    artifactId, disposition, operation, historicalEvidence, requestQuotes,
    adaptations: disposition === "adapt" ? [{ text: "Adapt the recorded procedure to the client's requested limits.", sourceRefs: historicalEvidence, requestQuotes: requestQuotes.slice(0, 1) }] : [],
    checks,
  });
}

function rawReviews(draft: AssessmentDraft, role: ArtifactRole = "starting_point") {
  return [...artifactRoles(draft, role).values()].map(({ decision, ...review }) => ({ ...review, disposition: decision.disposition }));
}

function fixture(): CorpusSnapshot {
  const cases: PastCase[] = [];
  const availableVersions = new Set<string>();
  const caseAvailability = new Map<string, "available" | "partial" | "unavailable">();
  const passages: CorpusSnapshot["passages"] = new Map();
  const versions: CorpusSnapshot["versions"] = new Map();
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
  const claims: Claim[] = [];
  const cases = corpus.manifest.cases.map((pastCase, caseIndex) => ({
    caseId: pastCase.caseId,
    outcome: "observed_success" as const,
    outcomeClaimIds: [`fact-${caseIndex}-0`],
    claimIds: pastCase.artifacts.map((_, artifactIndex) => `fact-${caseIndex}-${artifactIndex}`),
    artifactWork: pastCase.artifacts.map((artifact, workIndex) => {
      const version = artifact.versions[0];
      const sourceRefs = [{ caseId: pastCase.caseId, artifactId: artifact.artifactId, versionId: version.versionId, passageId: version.passages[0].passageId }];
      const suffix = `${caseIndex}-${workIndex}`;
      const factId = `fact-${suffix}`;
      const operation = "api_adapter" as const;
      const operationClaimId = `artifact-${suffix}-operation`;
      const dispositionClaimId = `decision-${suffix}`;
      const adaptationId = `artifact-${suffix}-adapt-0`;
      const adaptation = { text: "Adapt the recorded procedure to the current request's limits.", sourceRefs, requestQuotes: [currentRequest] };
      const checks = Object.entries(OPERATION_CHECKS[operation]).filter(([kind]) => kind !== "client_operation_limits").map(([kind, text]) => ({
        kind: kind as OperationCheckKind,
        text,
        sourceRefs,
        requestQuotes: [],
      }));
      const checkClaimIds = checks.map((_, checkIndex) => `artifact-${suffix}-check-${checkIndex}`);
      claims.push(
        { claimId: factId, text: version.passages[0].excerpt, kind: "source_fact", sourceRefs, requestQuotes: [], dependsOnClaimIds: [] },
        { claimId: operationClaimId, text: `The historical operation documented by this artifact is ${operation.replace("_", " ")}.`, kind: "interpretation", sourceRefs, requestQuotes: [], dependsOnClaimIds: [factId] },
        { claimId: dispositionClaimId, text: "Adapt the recorded work after checking the client's capabilities for the current request.", kind: "recommendation", sourceRefs, requestQuotes: [currentRequest], dependsOnClaimIds: [factId, operationClaimId] },
        { claimId: adaptationId, text: adaptation.text, kind: "recommendation", sourceRefs, requestQuotes: adaptation.requestQuotes, dependsOnClaimIds: [dispositionClaimId, factId] },
        ...checks.map((check, checkIndex) => ({
          claimId: checkClaimIds[checkIndex], text: check.text, kind: "recommendation" as const, sourceRefs: check.sourceRefs,
          requestQuotes: check.requestQuotes, dependsOnClaimIds: [dispositionClaimId, factId],
        })),
      );
      return {
        artifactId: artifact.artifactId, disposition: "adapt" as const, dispositionClaimId,
        decision: { disposition: "adapt" as const, operation, historicalEvidence: sourceRefs, requestQuotes: [currentRequest], adaptations: [adaptation], checks },
        claimIds: [factId, operationClaimId, dispositionClaimId, adaptationId, ...checkClaimIds],
        blockerClaimIds: [],
        verificationClaimIds: checkClaimIds,
      };
    }),
  }));
  return {
    cases,
    leads: [],
    contrasts: [],
    clarifyingClaimIds: [],
    comparisons: [],
    requestConstraints: { ...emptyRequirementReview.constraints },
    claims,
  };
}

test("brief assessment background is scoped to selected work without cutting its dependencies", () => {
  const corpus = fixture();
  const draft = assessmentDraft(corpus);
  const checked = buildCheckedAssessment(draft, new Map(draft.claims.map((item) => [item.claimId, "supported"])), new Set(), corpus, artifactRoles(draft), emptyRequirementReview);
  const selected = [{ caseId: "case-1", artifactId: "handover", versionId: "handover-v1-case-1", passageIds: ["p-handover-v1-case-1"] }];
  const scoped = selectedAssessment(checked, selected);
  assert.deepEqual(scoped.cases.map((item) => item.caseId), ["case-1"], "Unselected cases are not brief background.");
  assert.deepEqual(scoped.cases[0].artifactWork.map((item) => item.artifactId), ["handover"], "Only the selected artifact's checked work is retained.");
  assert.ok(scoped.artifactReviews.every((item) => item.caseId === "case-1" && item.artifactId === "handover"));
  const claimIds = new Set(scoped.claims.map((claim) => claim.claimId));
  assert.ok(claimIds.has("decision-0-1") && claimIds.has("fact-0-1"), "The selected claim and its dependency survive scoping.");
  assert.ok(!claimIds.has("fact-1-0") && !claimIds.has("decision-7-0"), "Claims belonging only to unselected cases are omitted.");
  assert.ok(scoped.claims.length < checked.claims.length, "Scoping must actually reduce the brief provider document.");
  assert.deepEqual(scoped.requestConstraints, checked.requestConstraints, "The global request inventory is retained in full.");
  const prompt = briefDraftPrompt(currentRequest, selected, corpus, checked);
  const background = (prompt.untrustedData as { historicalContext: { checkedAssessment: { cases: { caseId: string }[] } } }).historicalContext.checkedAssessment;
  assert.deepEqual(background.cases.map((item) => item.caseId), ["case-1"], "The brief draft prompt carries the scoped background, not all eight cases.");
  const reviewPrompt = briefReviewPrompt(currentRequest, selected, corpus, checked, {
    reuse: [], adapt: [], verify: [],
    claims: [{ claimId: "brief-1", kind: "recommendation", text: "Check the current request.", sourceRefs: [], requestQuotes: [], dependsOnClaimIds: [] }],
  });
  const reviewBackground = (reviewPrompt.untrustedData as { historicalContext: { checkedAssessmentBackground: { cases: { caseId: string }[] } } }).historicalContext.checkedAssessmentBackground;
  assert.deepEqual(reviewBackground.cases.map((item) => item.caseId), ["case-1"], "The brief review prompt carries the same scoped background.");
});

test("assessment rejects omitted artifacts even when all eight cases are present", () => {
  const corpus = fixture();
  const draft = assessmentDraft(corpus);
  draft.cases[0].artifactWork.pop();
  assert.throws(
    () => validateAssessmentDraft(draft, currentRequest, corpus),
    (error: unknown) => error instanceof GateFailure && error.code === "INCOMPLETE_ARTIFACT_WORK",
  );
});

test("selection cannot substitute a different version of an assessed artifact", () => {
  const corpus = fixture();
  const caseId = "case-1";
  const sourceRefs = [{ caseId, artifactId: "request", versionId: "request-v1", passageId: "p-request-v1" }];
  const historical: Claim = {
    claimId: "historical-fact",
    text: corpus.passages.get("p-request-v1")!.excerpt,
    kind: "source_fact",
    sourceRefs,
    requestQuotes: [],
    dependsOnClaimIds: [],
  };
  const operation: Claim = {
    claimId: "artifact-0-0-operation",
    text: "The historical operation documented by this artifact is api adapter.",
    kind: "interpretation",
    sourceRefs,
    requestQuotes: [],
    dependsOnClaimIds: [historical.claimId],
  };
  const claim: Claim = {
    claimId: "checked-claim",
    text: "Adapt the checked work for this request.",
    kind: "recommendation",
    sourceRefs,
    requestQuotes: [currentRequest],
    dependsOnClaimIds: [historical.claimId, operation.claimId],
  };
  const adaptation: Claim = {
    claimId: "artifact-0-0-adapt-0",
    text: "Adapt the checked work after the current requirements are confirmed.",
    kind: "recommendation",
    sourceRefs,
    requestQuotes: [currentRequest],
    dependsOnClaimIds: [claim.claimId, historical.claimId],
  };
  const check: Claim = {
    claimId: "artifact-0-0-check-0",
    text: OPERATION_CHECKS.api_adapter.client_api_access,
    kind: "recommendation",
    sourceRefs,
    requestQuotes: [],
    dependsOnClaimIds: [claim.claimId, historical.claimId],
  };
  const assessment: AssessmentResult = {
    conclusion: "precedent_found",
    clarifyingClaimIds: [],
    comparisons: [],
    requestConstraints: emptyRequirementReview.constraints,
    artifactReviews: [{
      caseId, artifactId: "request", role: "starting_point", verdict: "supported", reasons: [],
      decision: {
        disposition: "adapt", operation: "api_adapter", historicalEvidence: sourceRefs, requestQuotes: [currentRequest],
        adaptations: [{ text: adaptation.text, sourceRefs, requestQuotes: adaptation.requestQuotes }],
        checks: [{ kind: "client_api_access", text: OPERATION_CHECKS.api_adapter.client_api_access, sourceRefs, requestQuotes: [] }],
      },
    }],
    nextActions: [],
    cases: [{
      caseId, availability: "available", outcome: "unknown", outcomeClaimIds: [],
      claimIds: [historical.claimId, operation.claimId, claim.claimId, adaptation.claimId, check.claimId],
      artifactWork: [{
        artifactId: "request", availability: "available", exclusionReasons: [], disposition: "adapt", dispositionClaimId: claim.claimId,
        claimIds: [historical.claimId, operation.claimId, claim.claimId, adaptation.claimId, check.claimId],
        blockerClaimIds: [], verificationClaimIds: [check.claimId],
      }],
    }],
    leads: [],
    contrasts: [],
    claims: [historical, operation, claim, adaptation, check],
    withheldClaimCount: 0,
  };
  const selection: Selection = { caseId, artifactId: "request", versionId: "request-v2", passageIds: ["p-request-v2"] };
  assert.throws(
    () => validateSelections([selection], assessment, corpus),
    (error: unknown) => error instanceof Error && error.message === "UNAVAILABLE_OR_UNCHECKED_SELECTION",
  );
});
test("brief disposition is withheld when its recommendation claim is unsupported", () => {
  const corpus = fixture();
  const caseId = "case-1";
  const sourceRefs = [{ caseId, artifactId: "request", versionId: "request-v1", passageId: "p-request-v1" }];
  const factual: Claim = {
    claimId: "factual",
    text: corpus.passages.get("p-request-v1")!.excerpt,
    kind: "source_fact",
    sourceRefs,
    requestQuotes: [],
    dependsOnClaimIds: [],
  };
  const recommendation: Claim = {
    claimId: "disposition",
    text: "Reuse this work unchanged.",
    kind: "recommendation",
    sourceRefs,
    requestQuotes: [currentRequest],
    dependsOnClaimIds: [],
  };
  const draft: BriefDraft = {
    reuse: [{ caseId, artifactId: "request", versionId: "request-v1", disposition: "reuse", dispositionClaimId: recommendation.claimId, claimIds: [factual.claimId, recommendation.claimId] }],
    adapt: [],
    verify: [],
    claims: [factual, recommendation],
  };
  const selections = [{ caseId, artifactId: "request", versionId: "request-v1" }];
  const invalidRefs = validateBriefDraft(draft, currentRequest, selections, corpus);
  const checked = buildCheckedBrief(draft, new Map<string, SupportVerdict>([
    [factual.claimId, "supported"],
    [recommendation.claimId, "unsupported"],
  ]), invalidRefs, { request: currentRequest, constraintReviews: selections.map((item) => ({ ...item, requestQuotes: [] })) });
  assert.deepEqual(checked.reuse, []);
  assert.deepEqual(checked.claims.map((claim) => claim.claimId), [factual.claimId]);
});


test("one withheld peripheral brief claim does not erase its independent disposition", () => {
  const corpus = fixture();
  const draft = assessmentDraft(corpus);

  const sourceRefs = draft.claims[0].sourceRefs;
  const briefDraft: BriefDraft = {
    reuse: [], verify: [],
    adapt: [{ caseId: "case-1", artifactId: "request", versionId: "request-v1", disposition: "adapt", dispositionClaimId: "brief-disposition", claimIds: ["brief-disposition", "brief-fact", "brief-peripheral"] }],
    claims: [
      { claimId: "brief-disposition", kind: "recommendation", text: `${currentRequest} Adapt this work after checking the scope.`, sourceRefs, requestQuotes: [currentRequest], dependsOnClaimIds: [] },
      { claimId: "brief-fact", kind: "source_fact", text: corpus.passages.get("p-request-v1")!.excerpt, sourceRefs, requestQuotes: [], dependsOnClaimIds: [] },
      { claimId: "brief-peripheral", kind: "recommendation", text: "Check an unrelated extra step for the current request.", sourceRefs, requestQuotes: [currentRequest], dependsOnClaimIds: ["brief-disposition"] },
    ],
  };
  const selections = [{ caseId: "case-1", artifactId: "request", versionId: "request-v1" }];
  const briefVerdicts = new Map<string, SupportVerdict>(briefDraft.claims.map((claim) => [claim.claimId, "supported"]));
  briefVerdicts.set("brief-peripheral", "unsupported");
  const brief = buildCheckedBrief(briefDraft, briefVerdicts, validateBriefDraft(briefDraft, currentRequest, selections, corpus), {
    request: currentRequest,
    constraintReviews: selections.map((item) => ({ ...item, requestQuotes: [] })),
  });
  assert.equal(brief.adapt.length, 1, "A brief item survives a withheld peripheral claim.");
  assert.deepEqual(brief.adapt[0].claimIds, ["brief-disposition", "brief-fact"], "Only the withheld claim is removed from the item.");
  assert.equal(brief.withheldClaimCount, 1);
  assert.equal(brief.constraintReviews.length, 1, "The surviving item keeps its constraint review.");
});

test("checked brief survives only when each item carries its own atomic quotation claims", () => {
  const corpus = fixture();
  const request = "Keep source keys separate. Stop before replay when state is unclear.";
  const quotes = ["Keep source keys separate.", "Stop before replay when state is unclear."];
  const selections = [
    { caseId: "case-1", artifactId: "request", versionId: "request-v1" },
    { caseId: "case-1", artifactId: "handover", versionId: "handover-v1-case-1" },
  ];
  const refsFor = (item: typeof selections[number]) => [{
    caseId: item.caseId, artifactId: item.artifactId, versionId: item.versionId,
    passageId: item.artifactId === "request" ? "p-request-v1" : "p-handover-v1-case-1",
  }];
  const claimsFor = (item: typeof selections[number], prefix: string): Claim[] => [
    { claimId: `${prefix}-disposition`, kind: "recommendation", text: "Adapt this work for the new request after the checks below.", sourceRefs: refsFor(item), requestQuotes: [], dependsOnClaimIds: [] },
    ...quotes.map((quote, index) => ({
      claimId: `${prefix}-quote-${index}`, kind: "recommendation" as const,
      text: `Check this before adapting: ${quote}`, sourceRefs: refsFor(item), requestQuotes: [quote], dependsOnClaimIds: [],
    })),
  ];
  const draft: BriefDraft = {
    reuse: [], verify: [],
    adapt: selections.map((item, index) => {
      const claims = claimsFor(item, `item-${index}`);
      return { ...item, disposition: "adapt" as const, dispositionClaimId: claims[0].claimId, claimIds: claims.map((claim) => claim.claimId) };
    }),
    claims: selections.flatMap((item, index) => claimsFor(item, `item-${index}`)),
  };
  const verdicts = new Map<string, SupportVerdict>(draft.claims.map((claim) => [claim.claimId, "supported"]));
  const constraintReviews = selections.map((item) => ({ ...item, requestQuotes: quotes }));
  const checked = buildCheckedBrief(draft, verdicts, validateBriefDraft(draft, request, selections, corpus), { request, constraintReviews });
  assert.deepEqual(checked.adapt.map((item) => item.artifactId), ["request", "handover"],
    "A shared quotation repeated as a dedicated atomic claim per item covers both items.");
  assert.equal(checked.withheldClaimCount, 0);

  // The captured failure shape: one item's disposition prose carries the shared
  // quotation while its metadata names only another quotation, and it has no
  // dedicated claim for the shared one. The other item's coverage cannot save it.
  const doomed = structuredClone(draft);
  const disposition = doomed.claims.find((claim) => claim.claimId === "item-0-disposition")!;
  disposition.text = `Adapt this work: ${quotes[0]} ${quotes[1]}`;
  disposition.requestQuotes = [quotes[0]];
  doomed.claims = doomed.claims.filter((claim) => claim.claimId !== "item-0-quote-1");
  doomed.adapt[0].claimIds = doomed.adapt[0].claimIds.filter((claimId) => claimId !== "item-0-quote-1");
  const withheld = buildCheckedBrief(doomed, verdicts, validateBriefDraft(doomed, request, selections, corpus), { request, constraintReviews });
  assert.deepEqual(withheld.adapt.map((item) => item.artifactId), ["handover"],
    "A quotation present only in prose, without matching metadata on that item, withholds that item.");
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

test("case outcome labels need their own review even when the underlying facts pass", () => {
  const corpus = fixture();
  const wireIds = assessmentPassageIds(corpus);
  const output: AssessmentOutput = {
    requestConstraints: emptyRequirementReview.constraints,
    cases: corpus.manifest.cases.map((pastCase) => ({
      caseId: pastCase.caseId, outcome: "failed",
      artifactWork: pastCase.artifacts.map((artifact) => (proposal(artifact.artifactId, [wireIds.get(artifact.versions[0].passages[0].passageId)!], "adapt", [currentRequest]))),
    })),
    claims: corpus.manifest.cases.map((pastCase, index) => ({
      claimId: `fact-${index}`, caseId: pastCase.caseId, kind: "source_fact", outcomeEvidence: true,
      sourceRefs: [wireIds.get(pastCase.artifacts[0].versions[0].passages[0].passageId)!],
      requestQuotes: [], dependsOnClaimIds: [],
    })),
    leads: [], contrasts: [], clarifyingClaimIds: [],
  };
  output.cases[4].outcome = "unknown";
  output.claims[5].outcomeEvidence = false;
  output.cases[6].outcome = "partial";
  output.cases[7].outcome = "observed_success";
  const draft = parseAssessmentDraft(output, corpus);
  const invalid = validateAssessmentDraft(draft, currentRequest, corpus);
  const review = { claimReviews: draft.claims.map((claim) => ({
    claimId: claim.claimId,
    verdict: (claim.claimId === "outcome-0" ? "unsupported" : claim.claimId === "outcome-2" ? "uncertain" : "supported") as SupportVerdict,
  })) };
  const verdicts = validateSupportReview(draft.claims, review);
  // A missing verdict also fails closed; production rejects incomplete reviews.
  verdicts.delete("outcome-3");
  const checked = buildCheckedAssessment(draft, verdicts, invalid, corpus, artifactRoles(draft), emptyRequirementReview);
  assert.deepEqual(checked.cases.map((item) => item.outcome), ["unknown", "failed", "unknown", "unknown", "unknown", "unknown", "partial", "observed_success"]);
  assert.deepEqual(checked.cases[0].outcomeClaimIds, []);
  assert.ok(checked.claims.some((claim) => claim.claimId === "fact-0"));
  assert.ok(!checked.claims.some((claim) => claim.claimId === "outcome-0"));
  const classification = checked.claims.find((claim) => claim.claimId === "outcome-1")!;
  assert.equal(classification.kind, "interpretation");
  assert.deepEqual(classification.dependsOnClaimIds, ["fact-1"]);
  assert.throws(
    () => validateSupportReview(draft.claims, { claimReviews: review.claimReviews.filter((item) => item.claimId !== "outcome-1") }),
    (error: unknown) => error instanceof GateFailure && error.code === "INCOMPLETE_SUPPORT_REVIEW",
  );
  assert.equal(revalidateAssessment(checked, currentRequest, corpus).cases[1].outcome, "failed");
  const legacy = structuredClone(checked);
  legacy.claims = legacy.claims.filter((claim) => claim.claimId !== "outcome-1");
  legacy.cases[1].outcomeClaimIds = ["fact-1"];
  assert.equal(revalidateAssessment(legacy, currentRequest, corpus).cases[1].outcome, "unknown");
  for (const rejection of ["unsupported", "uncertain"] as const) {
    verdicts.set("fact-1", rejection);
    assert.equal(buildCheckedAssessment(draft, verdicts, invalid, corpus, artifactRoles(draft), emptyRequirementReview).cases[1].outcome, "unknown");
  }
  verdicts.set("fact-1", "supported");
  assert.equal(buildCheckedAssessment(draft, verdicts, new Set(["fact-1"]), corpus, artifactRoles(draft), emptyRequirementReview).cases[1].outcome, "unknown");
  corpus.passages.delete(corpus.manifest.cases[1].artifacts[0].versions[0].passages[0].passageId);
  assert.equal(revalidateAssessment(checked, currentRequest, corpus).cases[1].outcome, "unknown");
});

test("operation-scoped typed prerequisites preserve conditional adapter and handover work", () => {
  const corpus = fixture();
  const request = "Target API authorization remains unconfirmed. The handover's decision authority remains unconfirmed.";
  const apiQuote = "Target API authorization remains unconfirmed.";
  const handoverQuote = "The handover's decision authority remains unconfirmed.";
  const ids = assessmentPassageIds(corpus);
  const output: AssessmentOutput = {
    requestConstraints: emptyRequirementReview.constraints, claims: [], clarifyingClaimIds: [], contrasts: [],
    leads: [{ caseId: "case-1", state: "conditional", reasonClaimIds: ["lead-reason"], comparisons: [] }],
    cases: corpus.manifest.cases.map((item, caseIndex) => ({
      caseId: item.caseId, outcome: "unknown",
      artifactWork: item.artifacts.map((artifact, workIndex) => {
        const operation = workIndex === 0 ? "api_adapter" : "recovery_handover";
        const quote = operation === "api_adapter" ? apiQuote : handoverQuote;
        const disposition = caseIndex === 0 ? "adapt" : null;
        return proposal(artifact.artifactId, [ids.get(artifact.versions[0].passages[0].passageId)!], disposition, disposition ? [quote] : [], operation);
      }),
    })),
  };
  output.claims.push({ claimId: "lead-reason", caseId: "case-1", kind: "source_fact", outcomeEvidence: false, sourceRefs: [ids.get("p-request-v1")!], requestQuotes: [], dependsOnClaimIds: [] });
  const draft = parseAssessmentDraft(output, corpus);
  const invalid = validateAssessmentDraft(draft, request, corpus);
  const review = assessmentReviewSchema.parse({
    requestConstraints: emptyRequirementReview.constraints,
    artifactReviews: rawReviews(draft),
    claimReviews: draft.claims.map((claim) => ({ claimId: claim.claimId, verdict: "supported" as const })),
  });
  const reviews = validateArtifactReview(draft, review);
  const verdicts = validateSupportReview(draft.claims, review);
  const constraints = emptyRequirementReview.constraints;
  const requirementReview = { request, constraints };
  const build = () => buildCheckedAssessment(draft, verdicts, invalid, corpus, reviews, requirementReview);
  const selected = [{ caseId: "case-1", artifactId: "request", versionId: "request-v1", passageIds: ["p-request-v1"] }];
  const handoverSelection = [{ caseId: "case-1", artifactId: "handover", versionId: "handover-v1-case-1", passageIds: ["p-handover-v1-case-1"] }];
  const checked = build();
  assert.equal(checked.cases[0].artifactWork[0].disposition, "adapt");
  assert.equal(checked.cases[0].artifactWork[1].disposition, "adapt");
  const apiDecision = checked.artifactReviews.find((item) => item.artifactId === "request")!.decision;
  const handoverDecision = checked.artifactReviews.find((item) => item.artifactId === "handover")!.decision;
  assert.ok(apiDecision.checks.every((check) => check.requestQuotes.includes(apiQuote)));
  assert.ok(handoverDecision.checks.every((check) => check.requestQuotes.includes(handoverQuote)));
  assert.deepEqual(validateSelections([...selected, ...handoverSelection], checked, corpus), [...selected, ...handoverSelection]);
  assert.deepEqual(revalidateAssessment(checked, request, corpus), checked);
  assert.deepEqual(boundAssessmentQuotes(checked, selected[0]), [apiQuote]);
  const wrongCanonicalOperation = structuredClone(checked);
  wrongCanonicalOperation.artifactReviews.find((item) => item.artifactId === "request")!.decision.operation = "recovery_handover";
  assert.throws(() => revalidateAssessment(wrongCanonicalOperation, request, corpus));
  const wrongCanonicalKind = structuredClone(checked);
  Object.assign(wrongCanonicalKind.artifactReviews.find((item) => item.artifactId === "request")!.decision.checks[0], { kind: "operating_authority" });
  assert.throws(() => revalidateAssessment(wrongCanonicalKind, request, corpus));
  const authoredCanonicalText = structuredClone(checked);
  authoredCanonicalText.artifactReviews.find((item) => item.artifactId === "request")!.decision.checks[0].text = "Provider-authored check text.";
  assert.throws(() => revalidateAssessment(authoredCanonicalText, request, corpus));
  const foreignCanonicalEvidence = structuredClone(checked);
  foreignCanonicalEvidence.artifactReviews.find((item) => item.artifactId === "request")!.decision.checks[0].sourceRefs = handoverDecision.checks[0].sourceRefs;
  assert.throws(() => revalidateAssessment(foreignCanonicalEvidence, request, corpus));
  const misplacedCheck = structuredClone(output);
  Object.assign(misplacedCheck.cases[0].artifactWork[0].checks[0], { kind: "operating_authority" });
  assert.equal(assessmentDraftSchema.safeParse(misplacedCheck).success, false);
  assert.throws(() => parseAssessmentDraft(misplacedCheck, corpus));
  const work = draft.cases[0].artifactWork[0];
  const rejectedClaimIds = [
    work.claimIds.find((id) => id.includes("-history-"))!,
    work.claimIds.find((id) => id.endsWith("-operation"))!,
    work.claimIds.find((id) => id.includes("-adapt-"))!,
    work.verificationClaimIds[0],
  ];
  // Synthetic verdicts exercise fail-closed propagation, not semantic qualification.
  for (const id of rejectedClaimIds) {
    const rejectedReview = assessmentReviewSchema.parse({
      ...review,
      claimReviews: review.claimReviews.map((claim) => claim.claimId === id ? { ...claim, verdict: "unsupported" as const } : claim),
    });
    const rejectedVerdicts = validateSupportReview(draft.claims, rejectedReview);
    const rejected = buildCheckedAssessment(draft, rejectedVerdicts, invalid, corpus, reviews, requirementReview);
    assert.equal(rejected.cases[0].artifactWork[0].disposition, null);
    assert.ok(!rejected.leads[0]?.usefulArtifactIds.includes("request"));
    assert.ok(!rejected.nextActions.some((action) => action.artifactId === "request"));
    assert.ok(!rejected.claims.some((claim) => claim.claimId === work.dispositionClaimId));
    assert.equal(rejected.artifactReviews.find((item) => item.artifactId === "request")?.role, "starting_point");
    assert.equal(rejected.artifactReviews.find((item) => item.artifactId === "request")?.verdict, "supported");
    assert.throws(() => validateSelections(selected, rejected, corpus));
    if (id === work.verificationClaimIds[0]) {
      assert.ok(!rejected.claims.some((claim) => claim.claimId === id));
      assert.throws(() => briefDraftPrompt(request, selected, corpus, rejected), /BRIEF_CHECKED_DECISION_REQUIRED/);
    }
  }
  const assertedCapability = structuredClone(output);
  assertedCapability.cases[0].artifactWork[0].adaptations[0].text = "The target API authorization is confirmed and available; proceed with the adapter.";
  const capabilityDraft = parseAssessmentDraft(assertedCapability, corpus);
  const capabilityWork = capabilityDraft.cases[0].artifactWork[0];
  const capabilityClaimId = capabilityWork.claimIds.find((id) => id.includes("-adapt-"))!;
  const capabilityReview = assessmentReviewSchema.parse({
    ...review, artifactReviews: rawReviews(capabilityDraft),
    claimReviews: capabilityDraft.claims.map((claim) => ({ claimId: claim.claimId, verdict: claim.claimId === capabilityClaimId ? "unsupported" : "supported" })),
  });
  const capabilityRejected = buildCheckedAssessment(capabilityDraft, validateSupportReview(capabilityDraft.claims, capabilityReview), validateAssessmentDraft(capabilityDraft, request, corpus), corpus, validateArtifactReview(capabilityDraft, capabilityReview), requirementReview);
  assert.equal(capabilityRejected.cases[0].artifactWork[0].disposition, null);
  assert.throws(() => validateSelections(selected, capabilityRejected, corpus));
  const decision = reviews.get("case-1/request")!;
  decision.verdict = "unsupported";
  decision.reasons = [{
    target: "request_constraint", explanation: "The proposed capability is not established for this client.",
    sourceRefs: decision.decision.historicalEvidence, requestQuotes: [apiQuote],
  }];
  const rejected = build();
  assert.equal(rejected.cases[0].artifactWork[0].disposition, null);
  assert.ok(!rejected.leads[0]?.usefulArtifactIds.includes("request"));
  assert.ok(!rejected.nextActions.some((action) => action.artifactId === "request"));
  assert.ok(!rejected.claims.some((claim) => work.verificationClaimIds.includes(claim.claimId)));
  assert.deepEqual(revalidateAssessment(rejected, request, corpus).artifactReviews, rejected.artifactReviews);
  assert.deepEqual(rejected.artifactReviews.find((item) => item.artifactId === "request")?.reasons, decision.reasons);
  const reasonRef = decision.reasons[0].sourceRefs[0];
  const reasonPassage = corpus.passages.get(reasonRef.passageId)!;
  corpus.passages.delete(reasonRef.passageId);
  assert.throws(() => revalidateAssessment(rejected, request, corpus), EvidenceUnavailable, "Rejected work cannot bypass evidence revalidation for its explanation.");
  corpus.passages.set(reasonRef.passageId, reasonPassage);
  const invalidReason = structuredClone(decision.reasons);
  decision.reasons[0].sourceRefs[0] = { ...decision.reasons[0].sourceRefs[0], passageId: "missing" };
  assert.throws(build, GateFailure);
  decision.reasons = invalidReason;
  const oldWire = structuredClone(output);
  Object.assign(oldWire.cases[0].artifactWork[0], { recommendation: { text: "Adapt", sourceRefs: ["e1"], requestQuotes: [], dependsOnClaimIds: [] } });
  assert.equal(assessmentDraftSchema.safeParse(oldWire).success, false);
});

test("conditional adapters require independently supported current-tenant checks for exact requested limits", () => {
  for (const limit of [450, 725]) {
    const corpus = fixture();
    const quote = `Submit jobs of at most ${limit} items; the new tenant's acceptance remains unconfirmed.`;
    const otherQuote = "Reconcile 2,000 handover records.";
    const request = `${quote} ${otherQuote}`;
    const labels = assessmentPassageIds(corpus);
    const constraints = { ...emptyRequirementReview.constraints, scale: [quote, otherQuote] };
    const output: AssessmentOutput = {
      requestConstraints: constraints, claims: [], clarifyingClaimIds: [], leads: [], contrasts: [],
      cases: corpus.manifest.cases.map((item, index) => ({
        caseId: item.caseId, outcome: "unknown",
        artifactWork: item.artifacts.map((artifact, artifactIndex) =>
          proposal(artifact.artifactId, [labels.get(artifact.versions[0].passages[0].passageId)!],
            index === 0 && artifactIndex === 0 ? "adapt" : null, index === 0 ? [quote] : [])),
      })),
    };
    const buildDraft = (draft: AssessmentDraft, rejected: SupportVerdict = "supported") => {
      const work = draft.cases[0].artifactWork[0];
      const limitClaims = new Set(work.verificationClaimIds.filter((id) =>
        work.decision.checks.some((check) => check.kind === "client_operation_limits"
          && check.text === draft.claims.find((claim) => claim.claimId === id)?.text)));
      const verdicts = new Map(draft.claims.map((claim) => [claim.claimId, limitClaims.has(claim.claimId) ? rejected : "supported" as SupportVerdict]));
      return buildCheckedAssessment(draft, verdicts, validateAssessmentDraft(draft, request, corpus), corpus, artifactRoles(draft), { request, constraints });
    };
    const build = (value: AssessmentOutput, rejected: SupportVerdict = "supported") =>
      buildDraft(parseAssessmentDraft(value, corpus), rejected);
    const missing = build(output);
    assert.equal(missing.cases[0].artifactWork[0].disposition, null, "Adapting a cap is not confirmation of tenant acceptance.");
    assert.ok(missing.artifactReviews[0].reasons.some((reason) => reason.target === "check" && reason.requestQuotes.includes(quote)));
    const work = output.cases[0].artifactWork[0];
    work.checks.push({ kind: "client_operation_limits" as OperationCheckKind, sourceRefs: work.historicalEvidence, requestQuotes: [quote] });
    const checked = build(output);
    assert.equal(checked.cases[0].artifactWork[0].disposition, "adapt");
    const check = checked.artifactReviews[0].decision.checks.find((check) => check.kind === "client_operation_limits")!;
    assert.ok(check.text.includes(quote), "The visible prerequisite must retain the exact requested value and unresolved acceptance.");
    assert.deepEqual(revalidateAssessment(checked, request, corpus), checked);
    const selection = [{ caseId: "case-1", artifactId: "request", versionId: "request-v1", passageIds: ["p-request-v1"] }];
    assert.deepEqual(validateSelections(selection, checked, corpus), selection);
    const limitClaim = (draft: AssessmentDraft) => {
      const work = draft.cases[0].artifactWork[0];
      return draft.claims.find((claim) => work.verificationClaimIds.includes(claim.claimId)
        && work.decision.checks.some((check) => check.kind === "client_operation_limits" && check.text === claim.text))!;
    };
    const reorderedDraft = parseAssessmentDraft(output, corpus);
    const reorderedClaim = limitClaim(reorderedDraft);
    const ref = reorderedClaim.sourceRefs[0];
    reorderedClaim.sourceRefs[0] = { passageId: ref.passageId, versionId: ref.versionId, artifactId: ref.artifactId, caseId: ref.caseId };
    const reordered = buildDraft(reorderedDraft);
    assert.equal(reordered.cases[0].artifactWork[0].disposition, "adapt");
    assert.deepEqual(validateSelections(selection, reordered, corpus), selection);
    for (const verdict of ["unsupported", "uncertain"] as const) {
      const withheld = build(output, verdict);
      assert.equal(withheld.cases[0].artifactWork[0].disposition, null);
      assert.throws(() => validateSelections(selection, withheld, corpus));
    }
    const wrongQuote = structuredClone(output);
    wrongQuote.cases[0].artifactWork[0].checks.at(-1)!.requestQuotes = [otherQuote];
    assert.equal(build(wrongQuote).cases[0].artifactWork[0].disposition, null);
    const missingRefDraft = parseAssessmentDraft(output, corpus);
    limitClaim(missingRefDraft).sourceRefs = [];
    assert.throws(() => buildDraft(missingRefDraft));
    const foreignRefDraft = parseAssessmentDraft(output, corpus);
    limitClaim(foreignRefDraft).sourceRefs = [{
      caseId: "case-1", artifactId: "handover", versionId: "handover-v1-case-1", passageId: "p-handover-v1-case-1",
    }];
    assert.throws(() => buildDraft(foreignRefDraft));
    const wrongVersionDraft = parseAssessmentDraft(output, corpus);
    limitClaim(wrongVersionDraft).sourceRefs = [{
      caseId: "case-1", artifactId: "request", versionId: "request-v2", passageId: "p-request-v2",
    }];
    const wrongVersion = buildDraft(wrongVersionDraft);
    assert.equal(wrongVersion.cases[0].artifactWork[0].disposition, null);
    assert.throws(() => validateSelections(selection, wrongVersion, corpus));
    const missingQuote = structuredClone(output);
    missingQuote.cases[0].artifactWork[0].checks.at(-1)!.requestQuotes = [];
    assert.throws(() => parseAssessmentDraft(missingQuote, corpus));
  }
});

test("historical limits and windows remain history while adaptation and omission verdicts control selection", () => {
  for (const [limit, days] of [[320, 3], [680, 7]]) {
    const corpus = fixture();
    const apiQuote = `Submit at most ${limit} items per job.`;
    const handoverQuote = `Provide escalation for only ${days} business days after signed acceptance.`;
    const request = `${apiQuote} ${handoverQuote}`;
    const constraints = { ...emptyRequirementReview.constraints, scale: [apiQuote], recovery_operations: [handoverQuote] };
    const history = ["Submit at most 900 items per job.", "Provide escalation for nine business days after deployment; check checkpoint state before replay."];
    for (const [index, artifact] of corpus.manifest.cases[0].artifacts.entries()) {
      const passage = artifact.versions[0].passages[0];
      passage.excerpt = history[index];
      corpus.passages.get(passage.passageId)!.excerpt = passage.excerpt;
    }
    const labels = assessmentPassageIds(corpus);
    const output: AssessmentOutput = {
      requestConstraints: constraints, claims: [], clarifyingClaimIds: [], contrasts: [],
      leads: [{ caseId: "case-1", state: "conditional", reasonClaimIds: ["lead-reason"], comparisons: [] }],
      cases: corpus.manifest.cases.map((item, caseIndex) => ({
        caseId: item.caseId, outcome: "unknown",
        artifactWork: item.artifacts.map((artifact, index) => {
          const operation = index === 0 ? "api_adapter" : "recovery_handover";
          const quote = index === 0 ? apiQuote : handoverQuote;
          const work = proposal(artifact.artifactId, [labels.get(artifact.versions[0].passages[0].passageId)!],
            caseIndex === 0 ? "adapt" : null, caseIndex === 0 ? [quote] : [], operation);
          if (work.disposition === "adapt") {
            work.adaptations[0].text = index === 0
              ? `Narrow submission batches to at most ${limit} items per job.`
              : `Replace the deployment-triggered window with escalation for only ${days} business days after signed acceptance.`;
            work.checks = Object.keys(OPERATION_CHECKS[operation]).map((kind) => ({
              kind: kind as OperationCheckKind, sourceRefs: work.historicalEvidence, requestQuotes: [quote],
            }));
          }
          return work;
        }),
      })),
    };
    output.claims.push({ claimId: "lead-reason", caseId: "case-1", kind: "source_fact", outcomeEvidence: false,
      sourceRefs: [labels.get("p-request-v1")!], requestQuotes: [], dependsOnClaimIds: [] });
    const selections = corpus.manifest.cases[0].artifacts.map((artifact) => ({
      caseId: "case-1", artifactId: artifact.artifactId, versionId: artifact.versions[0].versionId,
      passageIds: [artifact.versions[0].passages[0].passageId],
    }));
    // Synthetic verdicts prove independent review propagation, not model judgment.
    const build = (value: AssessmentOutput, rejected?: { index: number; target: "adaptation" | "disposition"; verdict: "unsupported" | "uncertain" }) => {
      const draft = parseAssessmentDraft(value, corpus);
      const prompt = assessmentReviewPrompt(request, corpus, draft);
      const targets = prompt.reviewTargets!;
      const rejectedWork = rejected ? draft.cases[0].artifactWork[rejected.index] : undefined;
      const rejectedClaim = rejectedWork?.claimIds.find((id) => id.includes("-adapt-"));
      const wire = {
        requestConstraints: { product_version: [], environment: [], scale: [requestSpanId(request, apiQuote)], identity_access: [], recovery_operations: [requestSpanId(request, handoverQuote)] },
        decisions: Object.fromEntries(targets.artifacts!.map((item) => {
          const reject = rejected?.target === "disposition" && item.caseId === "case-1" && item.artifactId === rejectedWork?.artifactId;
          return [`${item.caseId}/${item.artifactId}`, {
            disposition: item.disposition, role: item.disposition === null ? "context_only" : "starting_point",
            verdict: reject ? rejected!.verdict : "supported",
            reasons: reject ? [{ target: "adaptation",
              explanation: "The proposed replay step omits the requested escalation duration and signed-acceptance trigger; authority, checkpoint and acceptance checks are present.",
              sourceRefs: value.cases[0].artifactWork[1].historicalEvidence, requestQuotes: [requestSpanId(request, handoverQuote)] }] : [],
          }];
        })),
        claimVerdicts: Object.fromEntries(targets.claimIds.map((id) => [id,
          rejected?.target === "adaptation" && id === rejectedClaim ? rejected.verdict : "supported"])),
      };
      const review = assessmentReviewSchema.parse(reviewSchema(targets, request).parse(wire));
      return buildCheckedAssessment(draft,
        validateSupportReview(draft.claims.filter((claim) => targets.claimIds.includes(claim.claimId)), review),
        validateAssessmentDraft(draft, request, corpus), corpus, validateArtifactReview(draft, review), { request, constraints: review.requestConstraints });
    };
    const checked = build(output);
    assert.deepEqual(validateSelections(selections, revalidateAssessment(checked, request, corpus), corpus), selections);
    assert.ok(history.every((text) => checked.claims.some((claim) => claim.kind === "source_fact" && claim.text === text)));
    for (const verdict of ["unsupported", "uncertain"] as const) {
      const conflicting = structuredClone(output);
      conflicting.cases[0].artifactWork[0].adaptations[0].text = history[0];
      const rejected = build(conflicting, { index: 0, target: "adaptation", verdict });
      assert.equal(rejected.cases[0].artifactWork[0].disposition, null, "A supported limit check cannot rescue a rejected adaptation.");
      assert.throws(() => validateSelections([selections[0]], rejected, corpus));
      assert.deepEqual(validateSelections([selections[1]], rejected, corpus), [selections[1]]);
      const missing = structuredClone(output);
      missing.cases[0].artifactWork[1].adaptations[0].text = "Check checkpoint state before replay.";
      const omitted = revalidateAssessment(build(missing, { index: 1, target: "disposition", verdict }), request, corpus);
      assert.equal(omitted.cases[0].artifactWork[1].disposition, null, "Supported checks and claims cannot rescue an independently rejected omission.");
      assert.throws(() => validateSelections([selections[1]], omitted, corpus));
      assert.deepEqual(validateSelections([selections[0]], omitted, corpus), [selections[0]]);
      assert.ok(omitted.claims.some((claim) => claim.kind === "source_fact" && claim.text === history[1]), "Withholding work must not rewrite historical evidence.");
      assert.equal(omitted.artifactReviews.find((item) => item.artifactId === "handover")!.reasons[0].target, "adaptation");
    }
  }
});

test("context-only work cannot survive as a case reason or pre-use check after reread", () => {
  const corpus = fixture();
  const draft = assessmentDraft(corpus);
  const work = draft.cases[0].artifactWork[0];
  const sourceRefs = draft.claims.find((claim) => claim.claimId === "fact-0-0")!.sourceRefs;
  draft.claims.push({ claimId: "legacy-reason", kind: "interpretation", text: `The current request states: "${currentRequest}"`, sourceRefs, requestQuotes: [currentRequest], dependsOnClaimIds: [] });
  draft.leads = [{ caseId: "case-1", state: "conditional", usefulArtifactIds: ["handover"], reasonClaimIds: ["legacy-reason"] }];
  const roles = artifactRoles(draft);
  roles.get("case-1/request")!.role = "context_only";
  const invalid = validateAssessmentDraft(draft, currentRequest, corpus);
  const verdicts = new Map<string, SupportVerdict>(draft.claims.map((claim) => [claim.claimId, "supported"]));
  const checked = buildCheckedAssessment(draft, verdicts, invalid, corpus, roles, emptyRequirementReview);
  assert.equal(checked.cases[0].artifactWork[0].disposition, null);
  assert.deepEqual(checked.leads, [], "A non-source case reason cannot offer context-only work as a lead.");
  assert.ok(!checked.claims.some((claim) => claim.claimId === "legacy-reason" || work.verificationClaimIds.includes(claim.claimId)));
  assert.ok(checked.claims.some((claim) => claim.claimId === "fact-0-0"), "Factual source context survives a context-only disposition.");
  assert.deepEqual(checked.nextActions, []);
  const reread = revalidateAssessment(checked, currentRequest, corpus);
  assert.deepEqual(reread.leads, []);
  assert.ok(!reread.claims.some((claim) => claim.claimId === "legacy-reason" || work.verificationClaimIds.includes(claim.claimId)));
  assert.ok(reread.claims.some((claim) => claim.claimId === "fact-0-0"));
  assert.deepEqual(reread.nextActions, []);
  const adaptationIds = work.claimIds.filter((claimId) => claimId.includes("-adapt-"));
  draft.claims = draft.claims.filter((claim) => !adaptationIds.includes(claim.claimId));
  work.claimIds = work.claimIds.filter((claimId) => !adaptationIds.includes(claimId));
  work.decision.adaptations = [];
  work.disposition = "verify";
  work.decision.disposition = "verify";
  const disguisedOffering = buildCheckedAssessment(draft, verdicts, validateAssessmentDraft(draft, currentRequest, corpus), corpus, roles, emptyRequirementReview);
  assert.equal(disguisedOffering.cases[0].artifactWork[0].disposition, null, "Context-only work cannot regain an offering by relabeling it Verify.");
  assert.ok(!disguisedOffering.claims.some((claim) => work.verificationClaimIds.includes(claim.claimId)));
  assert.deepEqual(disguisedOffering.nextActions, []);
});

test("Verify cannot nominate itself as reusable lead work", () => {
  const corpus = fixture();
  const ids = assessmentPassageIds(corpus);
  const output: AssessmentOutput = {
    requestConstraints: emptyRequirementReview.constraints, claims: [], clarifyingClaimIds: [], contrasts: [],
    leads: [{ caseId: "case-1", state: "conditional", reasonClaimIds: ["reason"], comparisons: [] }],
    cases: corpus.manifest.cases.map((item) => ({
      caseId: item.caseId, outcome: "unknown",
      artifactWork: item.artifacts.map((artifact) => proposal(artifact.artifactId, [ids.get(artifact.versions[0].passages[0].passageId)!], "verify")),
    })),
  };
  output.claims.push({ claimId: "reason", caseId: "case-1", kind: "source_fact", outcomeEvidence: false, sourceRefs: [ids.get("p-request-v1")!], requestQuotes: [], dependsOnClaimIds: [] });
  const parsed = parseAssessmentDraft(output, corpus);
  assert.deepEqual(parsed.leads[0].usefulArtifactIds, []);
  parsed.leads[0].usefulArtifactIds = ["handover"];
  assert.throws(() => validateAssessmentDraft(parsed, currentRequest, corpus), (error: unknown) => error instanceof GateFailure && error.code === "LEAD_ARTIFACT_NOT_USABLE");
});

test("true historical facts cannot promote an incompatible artifact into a useful precedent", () => {
  const corpus = fixture();
  const draft = assessmentDraft(corpus);
  draft.leads = [{ caseId: "case-1", state: "partial", usefulArtifactIds: ["request"], reasonClaimIds: ["fact-0-0"] }];
  const review = {
    requestConstraints: emptyRequirementReview.constraints,
    claimReviews: draft.claims.map((claim) => ({ claimId: claim.claimId, verdict: "supported" as const })),
    artifactReviews: rawReviews(draft, "not_relevant"),
  };
  const checked = buildCheckedAssessment(draft, validateSupportReview(draft.claims, review), new Set(), corpus, validateArtifactReview(draft, review), emptyRequirementReview);
  assert.equal(checked.conclusion, "cannot_be_established", "Negative roles alone do not supply an accepted explanation.");
  assert.deepEqual(checked.leads, []);
  assert.equal(checked.cases[0].artifactWork[0].disposition, null);
  assert.ok(checked.claims.some((claim) => claim.claimId === "fact-0-0"));
  const uncertain = { ...review, artifactReviews: review.artifactReviews.map((item, index) => ({ ...item, role: index === 0 ? "unresolved" as const : item.role })) };
  assert.equal(buildCheckedAssessment(draft, validateSupportReview(draft.claims, uncertain), new Set(), corpus, validateArtifactReview(draft, uncertain), emptyRequirementReview).conclusion, "cannot_be_established");
});

test("persisted assessments and briefs lose claims transitively when original evidence becomes unavailable", () => {
  const corpus = fixture();
  const draft = assessmentDraft(corpus);
  draft.claims.find((claim) => claim.claimId === "decision-0-1")!.dependsOnClaimIds.push("fact-0-0");
  draft.leads = [{ caseId: "case-1", state: "conditional", usefulArtifactIds: ["handover"], reasonClaimIds: ["fact-0-1"] }];
  const verdicts = new Map<string, SupportVerdict>(draft.claims.map((claim) => [claim.claimId, "supported"]));
  const persisted = buildCheckedAssessment(draft, verdicts, new Set(), corpus, artifactRoles(draft), emptyRequirementReview);
  const baseRefs = ["fact-0-0", "fact-0-1"].flatMap((id) => draft.claims.find((claim) => claim.claimId === id)!.sourceRefs);
  const base = { ...draft.claims[0], text: baseRefs.map((ref) => corpus.passages.get(ref.passageId)!.excerpt).join("\n"), sourceRefs: baseRefs };
  const dependent = { ...draft.claims.find((claim) => claim.claimId === "decision-0-1")!, text: `${currentRequest} Adapt the checked handover after validation.`, dependsOnClaimIds: [base.claimId] };
  const brief = {
    reuse: [], verify: [],
    adapt: [{ caseId: "case-1", artifactId: "handover", versionId: dependent.sourceRefs[0].versionId, disposition: "adapt" as const, dispositionClaimId: dependent.claimId, claimIds: [base.claimId, dependent.claimId] }],
    claims: [base, dependent], withheldClaimCount: 0,
    constraintReviews: [{ caseId: "case-1", artifactId: "handover", versionId: dependent.sourceRefs[0].versionId, requestQuotes: [] }],
  };
  validateBriefDraft(brief, currentRequest, [{ caseId: "case-1", artifactId: "handover", versionId: dependent.sourceRefs[0].versionId }], corpus);
  assert.equal(revalidateBrief(brief, currentRequest, corpus).adapt[0].disposition, "adapt");
  const originalPassage = corpus.passages.get("p-request-v1")!;
  corpus.availableVersions.delete("request-v1");
  corpus.passages.delete("p-request-v1");
  corpus.caseAvailability.set("case-1", "partial");
  const current = revalidateAssessment(persisted, currentRequest, corpus);
  assert.equal(current.conclusion, "cannot_be_established");
  assert.deepEqual(current.leads, []);
  assert.equal(current.cases[0].outcome, "unknown");
  assert.equal(current.cases[0].artifactWork[1].disposition, null);
  assert.ok(!current.claims.some((claim) => ["fact-0-0", "decision-0-1"].includes(claim.claimId)));
  assert.ok(current.claims.some((claim) => claim.claimId === "fact-1-0"));
  const currentBrief = revalidateBrief(brief, currentRequest, corpus);
  assert.deepEqual(currentBrief.adapt, []);
  assert.deepEqual(currentBrief.claims, []);
  assert.equal(currentBrief.withheldClaimCount, 2);
  corpus.availableVersions.add("request-v1");
  corpus.passages.set("p-request-v1", originalPassage);
  corpus.caseAvailability.set("case-1", "available");
  assert.equal(revalidateAssessment(persisted, currentRequest, corpus).conclusion, "precedent_found");
});

test("comparisons preserve unknown and mismatch and withhold rejected dependencies and actions", () => {
  const corpus = fixture();
  const sourceDraft = assessmentDraft(corpus);
  const passageIds = assessmentPassageIds(corpus);
  const request = "Production environment is required. Scale remains unstated.";
  const environmentRequirement = "Production environment is required.";
  const refsFor = (caseIndex: number, artifactIndex = 0) => sourceDraft.claims.find((claim) => claim.claimId === `fact-${caseIndex}-${artifactIndex}`)!.sourceRefs.map((ref) => passageIds.get(ref.passageId)!);
  const output: AssessmentOutput = {
    requestConstraints: { ...emptyRequirementReview.constraints, environment: [environmentRequirement] },
    cases: sourceDraft.cases.map(({ claimIds: _, outcomeClaimIds: __, ...item }, caseIndex) => ({
      ...item,
      artifactWork: item.artifactWork.map((work, artifactIndex) => proposal(work.artifactId, refsFor(caseIndex, artifactIndex), "adapt", item.caseId === "case-1" && work.artifactId === "request" ? [environmentRequirement] : [])),
    })),
    leads: [{
      caseId: "case-1", state: "conditional", reasonClaimIds: ["fact-0-1"],
      comparisons: [
        {
          dimension: "environment", requirementQuote: environmentRequirement, relation: "mismatch",
          evidence: { sourceRefs: refsFor(0), requestQuotes: [] },
          assessment: { sourceRefs: refsFor(0), requestQuotes: [], dependsOnClaimIds: [] },
          implication: { artifactId: "request", effect: "checked_decision" },
        },
        {
          dimension: "scale", requirementQuote: null, relation: "unknown",
          evidence: { sourceRefs: refsFor(0), requestQuotes: [] },
          assessment: { sourceRefs: refsFor(0), requestQuotes: [], dependsOnClaimIds: [] },
          implication: { artifactId: "handover", effect: "context_only" },
        },
      ],
    }],
    contrasts: [], clarifyingClaimIds: [],
    claims: sourceDraft.claims.filter((claim): claim is Claim & { kind: "source_fact" } => claim.kind === "source_fact").map(({ text: _, ...claim }) => ({
      ...claim,
      caseId: claim.sourceRefs[0].caseId,
      outcomeEvidence: claim.claimId === "fact-0-0",
      sourceRefs: claim.sourceRefs.map((ref) => passageIds.get(ref.passageId)!),
    })),
  };
  const draft = parseAssessmentDraft(output, corpus);
  draft.claims.find((claim) => claim.claimId === draft.cases[0].artifactWork[0].verificationClaimIds[0])!.dependsOnClaimIds.push(draft.comparisons[0].assessmentClaimId);
  const invalid = validateAssessmentDraft(draft, request, corpus);
  const verdicts = new Map<string, SupportVerdict>(draft.claims.map((claim) => [claim.claimId, "supported"]));
  const constraints = { ...emptyRequirementReview.constraints, environment: [environmentRequirement] };
  const requirementReview = { request, constraints };
  const build = () => buildCheckedAssessment(draft, verdicts, invalid, corpus, artifactRoles(draft), requirementReview);
  const checked = build();
  assert.deepEqual(checked.comparisons.map(({ relation, artifactId, implicationEffect }) => ({ relation, artifactId, implicationEffect })), [
    { relation: "mismatch", artifactId: "request", implicationEffect: "checked_decision" },
    { relation: "unknown", artifactId: "handover", implicationEffect: "context_only" },
  ]);
  assert.deepEqual(checked.nextActions, [{ caseId: "case-1", artifactId: "request", claimId: draft.cases[0].artifactWork[0].verificationClaimIds[0] }]);
  const contextOnlyRoles = artifactRoles(draft);
  contextOnlyRoles.get("case-1/request")!.role = "context_only";
  const contextOnly = buildCheckedAssessment(draft, verdicts, invalid, corpus, contextOnlyRoles, requirementReview);
  assert.deepEqual(contextOnly.comparisons.map(({ artifactId, implicationEffect }) => ({ artifactId, implicationEffect })), [
    { artifactId: "handover", implicationEffect: "context_only" },
  ]);
  const rejectedVerificationId = draft.cases[0].artifactWork[0].verificationClaimIds[0];
  assert.ok(!contextOnly.claims.some((claim) => [draft.comparisons[0].implicationClaimId, rejectedVerificationId].includes(claim.claimId)));
  assert.deepEqual(contextOnly.nextActions, []);
  const rereadContextOnly = revalidateAssessment(contextOnly, request, corpus);
  assert.deepEqual(rereadContextOnly.comparisons.map((row) => row.artifactId), ["handover"]);
  assert.ok(!rereadContextOnly.claims.some((claim) => [draft.comparisons[0].implicationClaimId, rejectedVerificationId].includes(claim.claimId)));
  assert.deepEqual(rereadContextOnly.nextActions, []);
  const unresolvedRoles = artifactRoles(draft);
  unresolvedRoles.get("case-1/handover")!.role = "unresolved";
  const unestablished = buildCheckedAssessment(draft, verdicts, invalid, corpus, unresolvedRoles, requirementReview);
  assert.deepEqual(unestablished.leads.map((lead) => lead.usefulArtifactIds), [["request"]]);
  assert.deepEqual(unestablished.comparisons.map((row) => row.relation), ["mismatch", "unknown"]);
  draft.comparisons[1].relation = "match";
  assert.throws(() => validateAssessmentDraft(draft, request, corpus), (error: unknown) => error instanceof GateFailure && error.code === "INVALID_COMPARISON_CLAIMS");
  draft.comparisons[1].relation = "unknown";
  const requirementClaimId = draft.comparisons[0].requirementClaimId!;
  verdicts.set(requirementClaimId, "unsupported");
  const withheld = build();
  assert.deepEqual(withheld.comparisons.map((row) => row.dimension), ["scale"]);
  assert.deepEqual(withheld.nextActions, []);
  assert.ok(!withheld.claims.some((claim) => claim.claimId === draft.comparisons[0].implicationClaimId));
  const unknownDependency = structuredClone(output);
  unknownDependency.leads[0].comparisons[0].assessment.dependsOnClaimIds.push("missing");
  const unknownDraft = parseAssessmentDraft(unknownDependency, corpus);
  const assessmentClaim = unknownDraft.claims.find((claim) => claim.claimId === draft.comparisons[0].assessmentClaimId)!;
  assert.ok(assessmentClaim.dependsOnClaimIds.includes("missing"), "The parser retains unknown provider dependencies for strict gate rejection.");
  assert.throws(() => validateAssessmentDraft(unknownDraft, request, corpus),
    (error: unknown) => error instanceof GateFailure && error.code === "INVALID_DEPENDENCY_GRAPH");
  corpus.passages.delete("p-request-v1");
  const rechecked = revalidateAssessment(checked, request, corpus);
  assert.deepEqual(rechecked.comparisons, []);
  assert.deepEqual(rechecked.nextActions, []);
});

test("next actions are bounded checked request-specific checks, not slot filling", () => {
  const corpus = fixture();
  const draft = assessmentDraft(corpus);
  for (const item of draft.cases) {
    const work = item.artifactWork[0];
    const checkId = work.verificationClaimIds[0];
    const check = draft.claims.find((claim) => claim.claimId === checkId)!;
    check.requestQuotes = [currentRequest];
    work.decision.checks[0].requestQuotes = [currentRequest];
  }
  const checkIds = new Set(draft.cases.flatMap((item) => item.artifactWork.flatMap((work) => work.verificationClaimIds)));
  const build = (verdict: SupportVerdict) => buildCheckedAssessment(draft, new Map(draft.claims.map((claim) => [claim.claimId, checkIds.has(claim.claimId) ? verdict : "supported"])), new Set(), corpus, artifactRoles(draft), emptyRequirementReview);
  validateAssessmentDraft(draft, currentRequest, corpus);
  assert.deepEqual(build("supported").nextActions.map((action) => action.claimId), [
    "artifact-0-0-check-0", "artifact-1-0-check-0", "artifact-2-0-check-0",
  ]);
  assert.deepEqual(build("uncertain").nextActions, []);
});

test("clarification changes compare two checked dispositions, never withheld recommendations", () => {
  const corpus = fixture();
  const draft = assessmentDraft(corpus);
  draft.leads = [{ caseId: "case-1", state: "useful", usefulArtifactIds: ["request"], reasonClaimIds: ["fact-0-0"] }];
  const build = () => buildCheckedAssessment(draft, new Map(draft.claims.map((claim) => [claim.claimId, "supported"])), new Set(), corpus, artifactRoles(draft), emptyRequirementReview);
  const before = structuredClone(build());
  const work = draft.cases[0].artifactWork[0];
  const removed = work.claimIds.filter((claimId) => claimId.includes("-adapt-") || claimId.includes("-check-"));
  draft.claims = draft.claims.filter((claim) => !removed.includes(claim.claimId));
  work.claimIds = work.claimIds.filter((claimId) => !removed.includes(claimId));
  work.verificationClaimIds = [];
  work.decision.adaptations = [];
  work.decision.checks = [];
  work.disposition = "reuse";
  draft.claims.find((claim) => claim.claimId === "decision-0-0")!.text = "Reuse after the clarified target is established compatible.";
  work.decision.disposition = "reuse";
  const after = build();
  const changes = dispositionChanges(before, after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].before, "adapt");
  assert.equal(changes[0].after, "reuse");
  after.claims = after.claims.filter((claim) => claim.claimId !== "decision-0-0");
  assert.deepEqual(dispositionChanges(before, after).map((change) => ({ after: change.after, currentClaim: change.currentClaim })), [{ after: null, currentClaim: null }]);
});

test("assessment passage labels never rebind after source availability changes", () => {
  const corpus = fixture();
  const before = assessmentPassageIds(corpus);
  corpus.availableVersions.delete("request-v1");
  corpus.passages.delete("p-request-v1");
  assert.deepEqual(assessmentPassageIds(corpus), before);
});

test("the independent review cannot override artifact decisions with an aggregate label", () => {
  const schema = reviewSchema({ claimIds: ["checked-claim"], artifacts: [] }, currentRequest);
  const response = { requestConstraints: emptyRequirementReview.constraints, claimVerdicts: { "checked-claim": "supported" }, decisions: {}, conclusion: "precedent_found" };
  const validate = new Ajv({ strict: false }).compile(openRouterSchema("assessment_review", schema).json_schema.schema);
  assert.equal(validate(response), false);
  assert.equal(schema.safeParse(response).success, false);
  const { conclusion: _, ...validReview } = response;
  assert.equal(validate(validReview), true);
  assert.deepEqual(schema.parse(validReview), { requestConstraints: emptyRequirementReview.constraints, artifactReviews: [], claimReviews: [{ claimId: "checked-claim", verdict: "supported" }] });
  assert.equal(validate({ ...validReview, claimVerdicts: {} }), false, "The reviewer cannot omit a claim verdict.");
  assert.equal(validate({ ...validReview, claimVerdicts: { ...validReview.claimVerdicts, "foreign-claim": "supported" } }), false, "Background or foreign IDs cannot enter the review inventory.");
});

test("decision review binds the exact disposition and requires evidence-linked rejection reasons", () => {
  const corpus = fixture();
  const ref = assessmentDraft(corpus).claims[0].sourceRefs[0];
  const schema = reviewSchema({ claimIds: ["fact"], artifacts: [{ caseId: ref.caseId, artifactId: ref.artifactId, disposition: "adapt" }], sourceRefs: { e1: ref } }, currentRequest);
  const response = {
    requestConstraints: emptyRequirementReview.constraints,
    claimVerdicts: { fact: "supported" },
    decisions: { "case-1/request": { disposition: "adapt", role: "starting_point", verdict: "unsupported", reasons: [{
      target: "adaptation", explanation: "The requested capability is not established by the cited history.",
      sourceRefs: ["e1"], requestQuotes: [requestSpans(currentRequest)[0].spanId],
    }] } },
  };
  const review = schema.parse(response);
  if (!("artifactReviews" in review)) throw new Error("Expected assessment review.");
  assert.deepEqual(review.artifactReviews[0].reasons[0].sourceRefs, [ref]);
  assert.deepEqual(review.artifactReviews[0].reasons[0].requestQuotes, [currentRequest]);
  for (const override of [
    { disposition: "reuse" }, { reasons: [] }, { reasons: [{ ...response.decisions["case-1/request"].reasons[0], sourceRefs: ["missing"] }] },
  ]) {
    assert.equal(schema.safeParse({ ...response, decisions: { "case-1/request": { ...response.decisions["case-1/request"], ...override } } }).success, false);
  }
  assert.equal(schema.safeParse({ ...response, decisions: {} }).success, false);
});

test("independent request constraints block false absence even when every claim is supported", () => {
  const corpus = fixture();
  const wireIds = assessmentPassageIds(corpus);
  for (const scenario of [
    { dimension: "environment", request: "The environment is isolated staging only.", rejected: true, draftQuote: true, reviewQuote: false, requirementQuote: false },
    { dimension: "scale", request: "At most 300 records may be processed.", rejected: true, draftQuote: true, reviewQuote: false, requirementQuote: false },
    { dimension: "identity_access", request: "External keys must be preserved.", rejected: true, draftQuote: false, reviewQuote: true, requirementQuote: false },
    { dimension: "product_version", request: "The target version is unconfirmed.", rejected: false, draftQuote: true, reviewQuote: true, requirementQuote: true },
    { dimension: "environment", request: "Assess the past evidence.", rejected: false, draftQuote: false, reviewQuote: false, requirementQuote: false },
  ] satisfies { dimension: keyof RequestConstraints; request: string; rejected: boolean; draftQuote: boolean; reviewQuote: boolean; requirementQuote: boolean }[]) {
    const request = scenario.request;
    const sourceRefs = [wireIds.get("p-request-v1")!];
    const output: AssessmentOutput = {
      requestConstraints: {
        ...emptyRequirementReview.constraints,
        [scenario.dimension]: scenario.draftQuote ? [request] : [],
      },
      cases: corpus.manifest.cases.map((item) => ({
        caseId: item.caseId, outcome: "unknown",
        artifactWork: item.artifacts.map((artifact) => (proposal(artifact.artifactId, [wireIds.get(artifact.versions[0].passages[0].passageId)!], "adapt", []))),
      })),
      claims: [{ claimId: "recorded", caseId: "case-1", kind: "source_fact", outcomeEvidence: false, sourceRefs, requestQuotes: [], dependsOnClaimIds: [] }],
      leads: [], clarifyingClaimIds: [],
      contrasts: [{
        caseId: "case-1", state: "conditional", usefulArtifactIds: [], reasonClaimIds: ["recorded"],
        comparisons: [{
          dimension: scenario.dimension,
          requirementQuote: scenario.requirementQuote ? request : null,
          relation: "unknown",
          evidence: { sourceRefs, requestQuotes: [] },
          assessment: { sourceRefs, requestQuotes: [], dependsOnClaimIds: [] },
          implication: { artifactId: "request", effect: "context_only" },
        }],
      }],
    };
    const draft = parseAssessmentDraft(output, corpus);
    const constraints = {
      ...emptyRequirementReview.constraints,
      [scenario.dimension]: scenario.reviewQuote ? [request] : [],
    };
    const review = assessmentReviewSchema.parse({
      requestConstraints: constraints,
      artifactReviews: rawReviews(draft),
      claimReviews: draft.claims.map((claim) => ({ claimId: claim.claimId, verdict: "supported" })),
    });
    const verdicts = validateSupportReview(draft.claims, review);
    const invalid = validateAssessmentDraft(draft, request, corpus);
    const checked = buildCheckedAssessment(draft, verdicts, invalid, corpus, validateArtifactReview(draft, review), { request, constraints: review.requestConstraints });
    assert.equal(checked.comparisons.some((row) => row.dimension === scenario.dimension), !scenario.rejected);
    assert.equal(checked.claims.some((claim) => claim.claimId === "comparison-0-implication"), !scenario.rejected);
    assert.ok(checked.claims.some((claim) => claim.claimId === "comparison-0-evidence"));
    assert.equal(checked.cases.length, 8);
    assert.deepEqual(revalidateAssessment(checked, request, corpus).comparisons, checked.comparisons);
    if (scenario.requirementQuote) {
      const row = checked.comparisons[0];
      assert.deepEqual(checked.claims.find((claim) => claim.claimId === row.requirementClaimId)?.requestQuotes, [request]);
      assert.equal(row.relation, "unknown");
    }
    if (scenario.dimension === "environment" && scenario.rejected) {
      const invented = { ...constraints, environment: ["not present in the current request"] };
      assert.throws(() => buildCheckedAssessment(draft, verdicts, invalid, corpus, artifactRoles(draft), { request, constraints: invented }),
        (error: unknown) => error instanceof GateFailure && error.code === "INVALID_REQUEST_CONSTRAINT_REVIEW");
      const { requestConstraints: _, ...oldReview } = review;
      assert.equal(assessmentReviewSchema.safeParse(oldReview).success, false);
      const legacy = { ...checked };
      const invalidLegacy: Partial<AssessmentResult> = legacy;
      delete invalidLegacy.requestConstraints;
      assert.throws(() => revalidateAssessment(legacy, request, corpus), EvidenceUnavailable);
      assert.equal(buildCheckedAssessment(draft, verdicts, invalid, corpus, artifactRoles(draft), { request, constraints }).conclusion, "cannot_be_established");
    }
  }
});

test("implementation roles preserve conditional starting work but block context-only Adapt", () => {
  const corpus = fixture();
  const draft = assessmentDraft(corpus);
  draft.leads = [{ caseId: "case-1", state: "conditional", usefulArtifactIds: ["request", "handover"], reasonClaimIds: ["fact-0-1"] }];
  const roles = artifactRoles(draft);
  roles.get("case-1/request")!.role = "context_only";
  const work = draft.cases[0].artifactWork[1];
  const checkId = work.verificationClaimIds[0];
  const check = draft.claims.find((claim) => claim.claimId === checkId)!;
  check.requestQuotes = [currentRequest];
  work.decision.checks[0].requestQuotes = [currentRequest];
  const verdicts = new Map<string, SupportVerdict>(draft.claims.map((claim) => [claim.claimId, "supported"]));
  const checked = buildCheckedAssessment(draft, verdicts, validateAssessmentDraft(draft, currentRequest, corpus), corpus, roles, emptyRequirementReview);
  assert.equal(checked.cases[0].artifactWork[0].disposition, null);
  assert.equal(checked.cases[0].artifactWork[1].disposition, "adapt");
  assert.deepEqual(checked.leads[0].usefulArtifactIds, ["handover"]);
  assert.deepEqual(checked.nextActions, [{ caseId: "case-1", artifactId: "handover", claimId: check.claimId }]);
  const selection = [{ caseId: "case-1", artifactId: "handover", versionId: "handover-v1-case-1", passageIds: ["p-handover-v1-case-1"] }];
  assert.deepEqual(validateSelections(selection, checked, corpus), selection);
  assert.equal(revalidateAssessment(checked, currentRequest, corpus).cases[0].artifactWork[1].disposition, "adapt");
  roles.get("case-1/handover")!.role = "unresolved";
  assert.deepEqual(buildCheckedAssessment(draft, verdicts, new Set(), corpus, roles, emptyRequirementReview).leads, []);
  roles.get("case-1/handover")!.role = "starting_point";
  work.disposition = "reuse";
  work.decision.disposition = "reuse";
  assert.throws(() => buildCheckedAssessment(draft, verdicts, new Set(), corpus, roles, emptyRequirementReview), GateFailure);
});

test("full negative artifact coverage establishes no precedent without inventing uncertain case outcomes", () => {
  const corpus = fixture();
  const draft = assessmentDraft(corpus);
  const removedClaimIds = new Set<string>();
  for (const item of draft.cases) for (const work of item.artifactWork) {
    const factId = work.claimIds.find((claimId) => draft.claims.find((claim) => claim.claimId === claimId)?.kind === "source_fact")!;
    const explanation = draft.claims.find((claim) => claim.claimId === work.dispositionClaimId)!;
    explanation.kind = "interpretation";
    explanation.text = "This historical record does not establish implementation material for the current request.";
    explanation.dependsOnClaimIds = [factId];
    item.claimIds.push(work.dispositionClaimId);
    for (const claimId of work.claimIds) if (claimId !== factId && claimId !== work.dispositionClaimId) removedClaimIds.add(claimId);
    work.claimIds = work.claimIds.filter((claimId) => claimId === factId || claimId === work.dispositionClaimId);
    work.disposition = null;
    work.decision.disposition = null;
    work.decision.operation = null;
    work.decision.adaptations = [];
    work.decision.checks = [];
    work.verificationClaimIds = [];
  }
  draft.claims = draft.claims.filter((claim) => !removedClaimIds.has(claim.claimId));
  draft.claims.push({ ...draft.claims[0], claimId: "unrelated-outcome", kind: "source_fact", requestQuotes: [], dependsOnClaimIds: [] });
  draft.cases[0].claimIds.push("unrelated-outcome");
  draft.cases[0].outcomeClaimIds = ["unrelated-outcome"];
  const review = assessmentReviewSchema.parse({
    requestConstraints: emptyRequirementReview.constraints,
    artifactReviews: rawReviews(draft, "context_only"),
    claimReviews: draft.claims.map((claim) => ({ claimId: claim.claimId, verdict: claim.claimId === "unrelated-outcome" ? "uncertain" : "supported" })),
  });
  const checked = buildCheckedAssessment(draft, validateSupportReview(draft.claims, review), new Set(), corpus, validateArtifactReview(draft, review), emptyRequirementReview);
  assert.equal(checked.conclusion, "no_useful_precedent");
  assert.ok(checked.cases.every((item) => item.outcome === "unknown" && item.artifactWork.every((work) => work.disposition === null)));
  assert.equal(revalidateAssessment(checked, currentRequest, corpus).conclusion, "no_useful_precedent");
  const historicalUncertain: AssessmentResult = { ...checked, conclusion: "cannot_be_established" };
  assert.equal(revalidateAssessment(historicalUncertain, currentRequest, corpus).conclusion, "cannot_be_established");
  assert.throws(() => validateSelections([{ caseId: "case-1", artifactId: "request", versionId: "request-v1", passageIds: ["p-request-v1"] }], checked, corpus));
  assert.throws(() => validateArtifactReview(draft, { ...review, artifactReviews: review.artifactReviews.slice(1) }),
    (error: unknown) => error instanceof GateFailure && error.code === "INCOMPLETE_ARTIFACT_REVIEW");
  const unresolved = { ...review, artifactReviews: review.artifactReviews.map((item, index) => ({ ...item, role: index === 0 ? "unresolved" as const : item.role })) };
  assert.equal(buildCheckedAssessment(draft, validateSupportReview(draft.claims, unresolved), new Set(), corpus, validateArtifactReview(draft, unresolved), emptyRequirementReview).conclusion, "cannot_be_established");
  const omittedStartingPoint = { ...review, artifactReviews: review.artifactReviews.map((item, index) => ({ ...item, role: index === 0 ? "starting_point" as const : item.role })) };
  assert.equal(buildCheckedAssessment(draft, validateSupportReview(draft.claims, omittedStartingPoint), new Set(), corpus, validateArtifactReview(draft, omittedStartingPoint), emptyRequirementReview).conclusion, "cannot_be_established");
  assert.throws(() => validateArtifactReview(draft, { ...review, artifactReviews: [...review.artifactReviews.slice(1), review.artifactReviews[1]] }),
    (error: unknown) => error instanceof GateFailure && error.code === "INCOMPLETE_ARTIFACT_REVIEW");
  const legacy = { ...checked };
  const invalidLegacy: Partial<AssessmentResult> = legacy;
  delete invalidLegacy.artifactReviews;
  assert.throws(() => revalidateAssessment(legacy, currentRequest, corpus), EvidenceUnavailable);
  const missing = structuredClone(checked);
  missing.artifactReviews.pop();
  assert.throws(() => revalidateAssessment(missing, currentRequest, corpus), EvidenceUnavailable);
  const incomplete = structuredClone(draft);
  incomplete.cases.pop();
  const partialRoles = artifactRoles(incomplete, "context_only");
  assert.equal(buildCheckedAssessment(incomplete, validateSupportReview(draft.claims, review), new Set(), corpus, partialRoles, emptyRequirementReview).conclusion, "cannot_be_established");
  corpus.caseAvailability.set("case-2", "partial");
  assert.equal(revalidateAssessment(checked, currentRequest, corpus).conclusion, "cannot_be_established");
});

test("explicit artifact exclusion is reviewed and explained without fabricating reusable work", () => {
  const corpus = fixture();
  const wireIds = assessmentPassageIds(corpus);
  const output: AssessmentOutput = {
    requestConstraints: emptyRequirementReview.constraints, leads: [], contrasts: [], clarifyingClaimIds: [], claims: [],
    cases: corpus.manifest.cases.map((item) => ({
      caseId: item.caseId, outcome: "unknown",
      artifactWork: item.artifacts.map((artifact) => (proposal(artifact.artifactId, [wireIds.get(artifact.versions[0].passages[0].passageId)!], null, []))),
    })),
  };
  const draft = parseAssessmentDraft(output, corpus);
  const checked = buildCheckedAssessment(draft, new Map(draft.claims.map((claim) => [claim.claimId, "supported"])), validateAssessmentDraft(draft, currentRequest, corpus), corpus, artifactRoles(draft, "context_only"), emptyRequirementReview);
  assert.equal(checked.conclusion, "no_useful_precedent");
  assert.ok(checked.cases.every((item) => item.artifactWork.every((work) =>
    work.disposition === null && work.dispositionClaimId !== null && work.claimIds.includes(work.dispositionClaimId))));
  assert.ok(checked.cases.every((item) => item.claimIds.some((id) => checked.claims.some((claim) => claim.claimId === id && claim.kind === "interpretation"))));
  const reread = revalidateAssessment(checked, currentRequest, corpus);
  assert.equal(reread.conclusion, "no_useful_precedent");
  assert.ok(reread.cases.every((item) => item.artifactWork.every((work) =>
    work.disposition === null && work.dispositionClaimId !== null && work.claimIds.includes(work.dispositionClaimId))));
  const rejectedExplanations = new Map(draft.claims.map((claim) => [claim.claimId, "unsupported" as const]));
  const unexplained = buildCheckedAssessment(draft, rejectedExplanations, new Set(), corpus, artifactRoles(draft, "context_only"), emptyRequirementReview);
  assert.equal(unexplained.conclusion, "cannot_be_established", "Negative roles cannot establish no precedent after every supported exclusion explanation is lost.");
  const invalid = structuredClone(output);
  Object.assign(invalid.cases[0].artifactWork[0], { usefulForLead: true });
  assert.equal(assessmentDraftSchema.safeParse(invalid).success, false);
  const danglingExclusion = structuredClone(output);
  Object.assign(danglingExclusion.cases[0].artifactWork[0], { dependsOnClaimIds: ["missing-outcome"] });
  assert.equal(assessmentDraftSchema.safeParse(danglingExclusion).success, false);
});

test("operational acceptance conflicts block negative proof even without comparison rows", () => {
  const corpus = fixture();
  const constraints: RequestConstraints = {
    ...emptyRequirementReview.constraints,
    recovery_operations: [
      "The client's operating deadline is six hours.",
      "Acceptance needs a signed receipt for each processed item, although that capability is unconfirmed.",
      "An aggregate count is not an acceptable substitute.",
    ],
  };
  const request = ["Assess the available evidence.", ...constraints.recovery_operations].join(" ");
  const ids = assessmentPassageIds(corpus);
  const draft = parseAssessmentDraft({
    requestConstraints: constraints, leads: [], contrasts: [], clarifyingClaimIds: [], claims: [],
    cases: corpus.manifest.cases.map((item) => ({
      caseId: item.caseId, outcome: "unknown",
      artifactWork: item.artifacts.map((artifact) => (proposal(artifact.artifactId, [ids.get(artifact.versions[0].passages[0].passageId)!], null, constraints.recovery_operations))),
    })),
  }, corpus);
  const verdicts = new Map(draft.claims.map((claim) => [claim.claimId, "supported" as SupportVerdict]));
  const roles = artifactRoles(draft, "context_only");
  const build = (reviewed: RequestConstraints) => buildCheckedAssessment(draft, verdicts, validateAssessmentDraft(draft, request, corpus), corpus, roles, { request, constraints: reviewed });
  const checked = build(constraints);
  assert.equal(checked.conclusion, "no_useful_precedent");
  assert.deepEqual(revalidateAssessment(checked, request, corpus).requestConstraints.recovery_operations, constraints.recovery_operations);
  assert.deepEqual(checked.leads, []);
  assert.deepEqual(checked.nextActions, []);
  assert.ok(checked.cases.every((item) => item.outcome === "unknown" && item.artifactWork.every((work) => work.disposition === null)));
  assert.equal(build(emptyRequirementReview.constraints).conclusion, "cannot_be_established", "An omitted acceptance inventory cannot prove absence merely because no comparison was generated.");
  draft.requestConstraints = emptyRequirementReview.constraints;
  assert.equal(build(constraints).conclusion, "cannot_be_established", "A review-only constraint also conflicts with draft absence.");
  draft.requestConstraints = constraints;
  roles.get("case-1/request")!.role = "unresolved";
  assert.equal(build(constraints).conclusion, "cannot_be_established");
  roles.get("case-1/request")!.role = "context_only";
  for (const claim of draft.claims) verdicts.set(claim.claimId, "unsupported");
  assert.equal(build(constraints).conclusion, "cannot_be_established", "Rejected historical evidence withholds the exclusion decision.");
  for (const claim of draft.claims) verdicts.set(claim.claimId, "supported");
  corpus.availableVersions.delete("request-v1");
  corpus.caseAvailability.set("case-1", "partial");
  assert.equal(revalidateAssessment(checked, request, corpus).conclusion, "cannot_be_established");
});

test("provider generation binds request inventories and each case claim to their actual sources", async () => {
  const corpus = fixture();
  const request = "Named operators need recovery evidence. New target authorization remains unconfirmed.";
  const ids = assessmentPassageIds(corpus);
  const output: AssessmentOutput = {
    requestConstraints: { ...emptyRequirementReview.constraints },
    leads: [], contrasts: [], clarifyingClaimIds: [],
    cases: corpus.manifest.cases.map((item) => ({
      caseId: item.caseId, outcome: "unknown",
      artifactWork: item.artifacts.map((artifact) => (proposal(artifact.artifactId, [ids.get(artifact.versions[0].passages[0].passageId)!], null, []))),
    })),
    claims: [{ claimId: "source-fact", caseId: "case-1", outcomeEvidence: false, kind: "source_fact", sourceRefs: [ids.get("p-request-v1")!], requestQuotes: [], dependsOnClaimIds: [] }],
  };
  const { leads: _, contrasts: __, ...content } = output;
  const wireOutput = {
    ...content,
    cases: Object.fromEntries(content.cases.map(({ caseId, outcome, artifactWork }) => [caseId, {
      outcome, tier: "context",
      artifactWork: Object.fromEntries(artifactWork.map(({ artifactId, ...work }) => [artifactId, work])),
    }])),
  };
  const originalFetch = globalThis.fetch;
  let providerSchema: object | undefined;
  let normalized: AssessmentOutput | undefined;
  globalThis.fetch = async (_input, init) => {
    providerSchema = JSON.parse(init!.body as string).response_format.json_schema.schema;
    return Response.json({ id: "gen-source-bound-schema", model: "openai/gpt-6-luna", provider: "OpenAI", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(wireOutput) } }] });
  };
  try {
    normalized = assessmentDraftSchema.parse((await callModel({ OPENROUTER_API_KEY: "local-test-only" } as Env, "assessment_draft", assessmentDraftPrompt(request, corpus))).output);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(normalized);
  const normalizedDraft = parseAssessmentDraft(normalized, corpus);
  assert.equal(validateAssessmentDraft(normalizedDraft, request, corpus).size, 0, "Derived identities preserve each claim's actual evidence ownership.");
  assert.equal(normalizedDraft.claims[0].text, corpus.passages.get("p-request-v1")!.excerpt);
  const validate = new Ajv({ strict: false }).compile(providerSchema!);
  const valid = structuredClone(wireOutput);
  const recoveryQuote = "Named operators need recovery evidence.";
  const identityQuote = "New target authorization remains unconfirmed.";
  valid.requestConstraints.recovery_operations = [requestSpanId(request, recoveryQuote)];
  valid.requestConstraints.identity_access = [requestSpanId(request, identityQuote)];
  assert.equal(validate(valid), true);
  valid.cases["case-1"].artifactWork.request.requestQuotes = [requestSpanId(request, recoveryQuote)];
  assert.equal(validate(valid), true);
  const normalizedProvider = assessmentDraftPrompt(request, corpus).responseSchema!.parse(valid);
  if (!("contrasts" in normalizedProvider)) throw new Error("Expected the assessment parser output.");
  assert.deepEqual(normalizedProvider.requestConstraints.recovery_operations, [recoveryQuote]);
  assert.deepEqual(normalizedProvider.cases[0].artifactWork[0].requestQuotes, [recoveryQuote]);
  const authoredFact: { claims: (Partial<AssessmentOutput["claims"][number]> & { text?: string })[] } = structuredClone(valid);
  authoredFact.claims[0] = { ...authoredFact.claims[0], text: "Provider-authored fact prose is not accepted." };
  assert.equal(validate(authoredFact), false, "Source-fact text is composed from its exact source excerpt.");
  const historicalRequest = structuredClone(valid);
  historicalRequest.requestConstraints.recovery_operations = ["Historical recovery was exercised in test only."];
  assert.equal(validate(historicalRequest), false, "Request inventories accept only supplied span IDs.");
  const wrongCase = structuredClone(valid);
  wrongCase.claims[0].caseId = "case-2";
  assert.equal(validate(wrongCase), false, "A claim cannot pair another case's identity with this source.");
  wrongCase.claims[0].sourceRefs = [ids.get("p-request-v1-case-2")!];
  assert.equal(validate(wrongCase), true);
  const siblingArtifact = structuredClone(valid);
  siblingArtifact.cases["case-1"].artifactWork.handover.historicalEvidence = [ids.get("p-request-v1")!];
  assert.equal(validate(siblingArtifact), false, "A keyed artifact cannot borrow its sibling's passages.");

  const reason = { kind: "source_fact", sourceRefs: [ids.get("p-request-v1")!], requestQuotes: [], dependsOnClaimIds: [] };
  const evidence = { sourceRefs: [ids.get("p-request-v1")!], requestQuotes: [] };
  const assessment = { sourceRefs: [ids.get("p-request-v1")!], requestQuotes: [], dependsOnClaimIds: [] };
  const ownContrast = structuredClone(valid);
  Object.assign(ownContrast.cases["case-1"], {
    tier: "contrast", state: "partial", reasons: [reason],
    comparisons: [{ dimension: "environment", requirementQuote: null, relation: "unknown", evidence, assessment, implication: { artifactId: "request", effect: "context_only" } }],
  });
  assert.equal(validate(ownContrast), true);
  const quotedComparison = structuredClone(ownContrast);
  Object.assign(quotedComparison.cases["case-1"], {
    comparisons: [{
      dimension: "recovery_operations", requirementQuote: requestSpanId(request, recoveryQuote), relation: "unknown",
      evidence, assessment, implication: { artifactId: "request", effect: "context_only" },
    }],
  });
  assert.equal(validate(quotedComparison), true);
  const normalizedComparison = assessmentDraftPrompt(request, corpus).responseSchema!.parse(quotedComparison);
  if (!("contrasts" in normalizedComparison)) throw new Error("Expected the assessment parser output.");
  assert.equal(normalizedComparison.contrasts[0].comparisons[0].requirementQuote, recoveryQuote);
  const freeFormReason = structuredClone(ownContrast);
  Object.assign(freeFormReason.cases["case-1"], { reasons: [{ ...reason, kind: "interpretation" }] });
  assert.equal(validate(freeFormReason), false, "Case reasons cannot add interpretation or recommendation prose.");
  const quotedReason = structuredClone(ownContrast);
  Object.assign(quotedReason.cases["case-1"], { reasons: [{ ...reason, requestQuotes: [requestSpanId(request, recoveryQuote)] }] });
  assert.equal(validate(quotedReason), false, "Historical source-fact reasons cannot quote the current request.");
  const recommendationReason = structuredClone(ownContrast);
  Object.assign(recommendationReason.cases["case-1"], { reasons: [{ ...reason, kind: "recommendation" }] });
  assert.equal(validate(recommendationReason), false);
  const multiSourceReason = structuredClone(ownContrast);
  Object.assign(multiSourceReason.cases["case-1"], { reasons: [{ ...reason, sourceRefs: [ids.get("p-request-v1")!, ids.get("p-request-v1")!] }] });
  assert.equal(validate(multiSourceReason), false, "Case reasons are atomic source facts with exactly one source reference.");
  const normalizedContrast = parseAssessmentDraft(assessmentDraftPrompt(request, corpus).responseSchema!.parse(ownContrast), corpus);
  assert.equal(normalizedContrast.claims.find((claim) => claim.claimId === normalizedContrast.contrasts[0].reasonClaimIds[0])?.text, corpus.passages.get("p-request-v1")!.excerpt);
  const foreignReason = structuredClone(ownContrast);
  Object.assign(foreignReason.cases["case-1"], { reasons: [{ ...reason, sourceRefs: [ids.get("p-request-v1-case-2")!] }] });
  assert.equal(validate(foreignReason), false, "A lead/contrast reason cannot borrow another case's evidence.");
  const foreignComparison = structuredClone(ownContrast);
  Object.assign(foreignComparison.cases["case-1"], { comparisons: [{ dimension: "environment", requirementQuote: null, relation: "unknown", evidence: { ...evidence, sourceRefs: [ids.get("p-request-v1-case-2")!] }, assessment, implication: { artifactId: "request", effect: "context_only" } }] });
  assert.equal(validate(foreignComparison), false, "An inline comparison cannot borrow another case's evidence.");
  const oldComparisonOffering = structuredClone(ownContrast);
  Object.assign(oldComparisonOffering.cases["case-1"], {
    comparisons: [{
      dimension: "environment", requirementQuote: null, relation: "unknown", evidence, assessment,
      implication: { text: "Reuse the work.", sourceRefs: [ids.get("p-request-v1")!], requestQuotes: [] },
    }],
  });
  assert.equal(validate(oldComparisonOffering), false, "Comparison implications are decisions, not independent recommendation prose.");
  assert.equal(validate({ ...valid, recommendations: [{ text: "Another recommendation channel." }] }), false);
  const globalRecommendation = {
    ...valid,
    claims: [...valid.claims, { claimId: "free-recommendation", caseId: "case-1", outcomeEvidence: false, kind: "recommendation", text: "Reuse this work.", sourceRefs: [ids.get("p-request-v1")!], requestQuotes: [], dependsOnClaimIds: [] }],
  };
  assert.equal(validate(globalRecommendation), false, "The provider cannot add an independent global recommendation channel.");

  const omittedCase = structuredClone(valid);
  delete omittedCase.cases["case-8"];
  assert.equal(validate(omittedCase), false, "Every supplied case key is required.");
  const extraCase = structuredClone(valid);
  extraCase.cases["extra-case"] = structuredClone(extraCase.cases["case-8"]);
  assert.equal(validate(extraCase), false, "Case keys outside the supplied inventory are rejected.");
  const omittedArtifact = structuredClone(valid);
  delete omittedArtifact.cases["case-1"].artifactWork.handover;
  assert.equal(validate(omittedArtifact), false, "Every available artifact key is required.");
  const renamedArtifact = structuredClone(valid);
  renamedArtifact.cases["case-1"].artifactWork["renamed-handover"] = structuredClone(renamedArtifact.cases["case-1"].artifactWork.handover);
  delete renamedArtifact.cases["case-1"].artifactWork.handover;
  assert.equal(validate(renamedArtifact), false, "Renamed artifact keys cannot satisfy the supplied inventory.");
  const redundantIdentity = structuredClone(valid);
  Object.assign(redundantIdentity.cases["case-1"], { caseId: "case-1" });
  Object.assign(redundantIdentity.cases["case-1"].artifactWork.request, { artifactId: "request" });
  assert.equal(validate(redundantIdentity), false, "Case and artifact identities are carried only by their keys.");
  const noAvailableArtifact = fixture();
  noAvailableArtifact.availableVersions.delete("request-v1-case-2");
  const noArtifactPrompt = assessmentDraftPrompt(request, noAvailableArtifact);
  const noArtifactSchema = new Ajv({ strict: false }).compile(openRouterSchema("assessment", noArtifactPrompt.responseSchema!).json_schema.schema);
  const emptyArtifactWork = structuredClone(valid);
  emptyArtifactWork.cases["case-2"].artifactWork = {};
  assert.equal(noArtifactSchema(emptyArtifactWork), true, "Cases remain required when no artifacts have available versions.");
  const unavailableArtifact = structuredClone(emptyArtifactWork);
  unavailableArtifact.cases["case-2"].artifactWork.request = structuredClone(wireOutput.cases["case-2"].artifactWork.request);
  assert.equal(noArtifactSchema(unavailableArtifact), false, "Unavailable artifacts are not accepted into the inventory.");

  const longRequest = `Operators must retain each recovery event, ${"preserve every audit detail ".repeat(32)}before closure. Target authorization remains unconfirmed.`;
  const spans = requestSpans(longRequest);
  const sentenceSpans = spans.filter((span) => span.sentenceId === spans[0].sentenceId);
  assert.ok(sentenceSpans.length > 1, "The fixture sentence must cross multiple request spans.");
  const longPrompt = assessmentDraftPrompt(longRequest, corpus);
  const partialInventory = structuredClone(wireOutput);
  partialInventory.requestConstraints.recovery_operations = [sentenceSpans[0].spanId];
  const partialDraft = parseAssessmentDraft(longPrompt.responseSchema!.parse(partialInventory), corpus);
  assert.deepEqual(partialDraft.requestConstraints.recovery_operations, sentenceSpans.map((span) => span.text));
  partialDraft.requestConstraints.recovery_operations = [sentenceSpans[0].text];
  const partialConstraints = { ...emptyRequirementReview.constraints, recovery_operations: [sentenceSpans[0].text] };
  assert.throws(
    () => buildCheckedAssessment(partialDraft, new Map<string, SupportVerdict>(partialDraft.claims.map((claim) => [claim.claimId, "supported"])), new Set(), corpus, artifactRoles(partialDraft), { request: longRequest, constraints: partialConstraints }),
    (error: unknown) => error instanceof GateFailure && error.code === "INVALID_REQUEST_CONSTRAINT_REVIEW",
  );
});

test("brief generation cannot add an unselected background artifact", async () => {
  const corpus = fixture();
  const draft = assessmentDraft(corpus);
  const checked = buildCheckedAssessment(draft, new Map<string, SupportVerdict>(draft.claims.map((item) => [item.claimId, "supported"])), new Set(), corpus, artifactRoles(draft), emptyRequirementReview);
  const selected = [{ caseId: "case-1", artifactId: "handover", versionId: "handover-v1-case-1", passageIds: ["p-handover-v1-case-1"] }];
  const ids = assessmentPassageIds(corpus);
  const request = currentRequest;
  const prompt = briefDraftPrompt(request, selected, corpus, checked);
  // StagePrompt erases this in-process modelCorpus return type; no external data is asserted here.
  const data = prompt.untrustedData as { historicalContext: { completeSelectedCaseContext: ModelCaseContext[] } };
  const suppliedPassage = data.historicalContext.completeSelectedCaseContext.find((item) => item.caseId === selected[0].caseId)!.artifacts.find((item) => item.artifactId === selected[0].artifactId)!.versions.find((item) => item.versionId === selected[0].versionId)!.passages[0];
  const selectedKey = "case-1/handover/handover-v1-case-1";
  type BriefWireRecommendation = { text: string; sourceRefs: string[]; requestQuotes: string[] };
  type BriefWireClaim = BriefWireRecommendation & { kind: "recommendation" };
  type BriefWireItem = { disposition: "adapt"; recommendation: BriefWireRecommendation; claims: BriefWireClaim[] };
  const wireOutput: { items: Record<string, BriefWireItem> } = {
    items: {
      [selectedKey]: {
        disposition: "adapt",
        recommendation: {
          text: "Check the current request before adapting the selected procedure.",
          sourceRefs: [suppliedPassage.passageId],
          requestQuotes: [requestSpanId(request, request)],
        },
        claims: [
          {
            kind: "recommendation",
            text: "Verify compatibility for the current request.",
            sourceRefs: [suppliedPassage.passageId],
            requestQuotes: [requestSpanId(request, request)],
          },
        ],
      },
    },
  };
  let normalized: BriefDraft | undefined;
  let providerSchema: object | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    providerSchema = JSON.parse(init!.body as string).response_format.json_schema.schema;
    return Response.json({ id: "gen-selected-only", model: "openai/gpt-6-luna", provider: "OpenAI", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(wireOutput) } }] });
  };
  try {
    normalized = briefDraftSchema.parse((await callModel({ OPENROUTER_API_KEY: "local-test-only" } as Env, "brief_draft", prompt)).output);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(normalized);
  assert.equal(validateBriefDraft(normalized, request, selected, corpus).size, 0, "Derived selected identities preserve actual claim ownership.");
  assert.equal(normalized.claims[0].sourceRefs[0].passageId, selected[0].passageIds[0]);
  assert.deepEqual(normalized.claims[1].requestQuotes, [request]);
  const fact = normalized.claims.find((claim) => claim.kind === "source_fact")!;
  assert.equal(fact.text, corpus.passages.get(selected[0].passageIds[0])!.excerpt);
  assert.deepEqual(fact.dependsOnClaimIds, []);
  const validate = new Ajv({ strict: false }).compile(providerSchema!);
  assert.equal(validate(wireOutput), true);

  const legacyWire = {
    items: { [selectedKey]: { disposition: "adapt", dispositionClaimId: "choose", claimIds: ["choose"] } },
    claims: [{ claimId: "choose", kind: "recommendation", text: "Use the selected procedure.", sourceRefs: [suppliedPassage.passageId], requestQuotes: [] }],
  };
  assert.equal(validate(legacyWire), false, "The previous split disposition/membership/global-claim shape is rejected.");
  assert.equal(validate({ ...wireOutput, recommendations: [{ text: "An independent recommendation channel." }] }), false);
  const callerGraphIds = {
    ...wireOutput,
    items: {
      ...wireOutput.items,
      [selectedKey]: {
        ...wireOutput.items[selectedKey],
        recommendation: { ...wireOutput.items[selectedKey].recommendation, dependsOnClaimIds: [] },
        claims: wireOutput.items[selectedKey].claims.map((claim) => ({ ...claim, dependsOnClaimIds: [] })),
      },
    },
  };
  assert.equal(validate(callerGraphIds), false, "The brief wire contract rejects model-supplied graph fields, including empty ones.");
  assert.equal(validate({ ...wireOutput, claims: [{ text: "A free-form global claim." }] }), false);

  const lostQuote = structuredClone(wireOutput);
  lostQuote.items[selectedKey].recommendation.text = "Adapt after checking client compatibility.";
  assert.equal(validate(lostQuote), true, "Provider grammar constrains request IDs, while runtime parsing composes their exact text.");
  const composedQuote = prompt.responseSchema!.parse(lostQuote);
  if (!("adapt" in composedQuote)) throw new Error("Expected the brief parser output.");
  assert.ok(composedQuote.claims[0].text.startsWith(`${request} `), "Stored prose carries the exact request span, not hidden metadata alone.");

  const literalRequest = "Use [sandbox].";
  const literalPrompt = briefDraftPrompt(literalRequest, selected, corpus, checked);
  const literalWire = structuredClone(wireOutput);
  literalWire.items[selectedKey].claims = [];
  literalWire.items[selectedKey].recommendation.requestQuotes = [requestSpanId(literalRequest, literalRequest)];
  literalWire.items[selectedKey].recommendation.text = "Verify the requested constraint in the sandbox.";
  const validateLiteral = new Ajv({ strict: false }).compile(openRouterSchema("brief", literalPrompt.responseSchema!).json_schema.schema);
  assert.equal(validateLiteral(literalWire), true);
  const literalParsed = literalPrompt.responseSchema!.parse(literalWire);
  if (!("adapt" in literalParsed)) throw new Error("Expected the brief parser output.");
  assert.ok(literalParsed.claims[0].text.includes("Use [sandbox]."), "Request punctuation is composed literally, never treated as a regular expression.");

  const multiRequest = "First decisive sentence. Second decisive sentence.";
  const multiPrompt = briefDraftPrompt(multiRequest, selected, corpus, checked);
  const strayWire = structuredClone(wireOutput);
  strayWire.items[selectedKey].claims = [];
  strayWire.items[selectedKey].recommendation.requestQuotes = [requestSpanId(multiRequest, "First decisive sentence.")];
  strayWire.items[selectedKey].recommendation.text = "Check the request: First decisive sentence. Second decisive sentence.";
  assert.equal(multiPrompt.responseSchema!.safeParse(strayWire).success, false,
    "One atomic claim cannot declare a sentence while its prose also contains another complete request sentence.");
  strayWire.items[selectedKey].recommendation.text = "Check the request: First decisive sentence.";
  assert.equal(multiPrompt.responseSchema!.safeParse(strayWire).success, true,
    "The declared complete sentence span remains valid when carried visibly in its own claim.");

  const unselected = structuredClone(wireOutput);
  unselected.items["case-1/request/request-v1"] = structuredClone(unselected.items[selectedKey]);
  assert.equal(validate(unselected), false, "Full case background cannot add an unselected brief item.");
  const omitted: { items: Partial<Record<string, BriefWireItem>> } = structuredClone(wireOutput);
  delete omitted.items[selectedKey];
  assert.equal(validate(omitted), false, "Every selected identity requires exactly one disposition.");
  assert.equal(validate({ ...wireOutput, adapt: [{}], verify: [{}] }), false, "Independent section arrays are not provider channels.");
  const foreignClaim = structuredClone(wireOutput);
  foreignClaim.items[selectedKey].recommendation.sourceRefs[0] = ids.get("p-request-v1")!;
  assert.equal(validate(foreignClaim), false, "Brief recommendations preserve selected-source ownership.");
});

test("agreed operational acceptance constraints establish no useful precedent and fail closed when agreement or evidence is lost", () => {
  const corpus = fixture();
  const request = "The operation must finish within the stated window, with proof for each record. A restored copy does not count as completion. Please assess whether past records help.";
  const deadline = "The operation must finish within the stated window, with proof for each record.";
  const rejectedSubstitute = "A restored copy does not count as completion.";
  const quotes = [deadline, rejectedSubstitute];
  const wireIds = assessmentPassageIds(corpus);
  const constraints = {
    product_version: [],
    environment: [],
    scale: [],
    identity_access: [],
    recovery_operations: quotes,
  };
  const output: AssessmentOutput = {
    requestConstraints: constraints,
    cases: corpus.manifest.cases.map((pastCase) => ({
      caseId: pastCase.caseId,
      outcome: "unknown",
      artifactWork: pastCase.artifacts.map((artifact) => (proposal(artifact.artifactId, [wireIds.get(artifact.versions[0].passages[0].passageId)!], null, []))),
    })),
    claims: [{
      claimId: "negative-reason",
      caseId: "case-1",
      outcomeEvidence: false,
      kind: "source_fact",
      sourceRefs: [wireIds.get("p-request-v1")!],
      requestQuotes: [],
      dependsOnClaimIds: [],
    }],
    leads: [],
    contrasts: [{
      caseId: "case-1",
      state: "partial",
      usefulArtifactIds: [],
      reasonClaimIds: ["negative-reason"],
      comparisons: [{
        dimension: "recovery_operations",
        requirementQuote: deadline,
        relation: "unknown",
        evidence: { sourceRefs: [wireIds.get("p-request-v1")!], requestQuotes: [] },
        assessment: { sourceRefs: [wireIds.get("p-request-v1")!], requestQuotes: [], dependsOnClaimIds: [] },
        implication: { artifactId: "request", effect: "missing_evidence" },
      }],
    }],
    clarifyingClaimIds: [],
  };
  const draft = parseAssessmentDraft(output, corpus);
  const roles = artifactRoles(draft, "context_only");
  const verdicts = new Map<string, SupportVerdict>(draft.claims.map((claim) => [claim.claimId, "supported"]));
  const invalid = validateAssessmentDraft(draft, request, corpus);
  const checked = buildCheckedAssessment(draft, verdicts, invalid, corpus, roles, { request, constraints });
  assert.equal(checked.conclusion, "no_useful_precedent");
  assert.deepEqual(checked.leads, []);
  assert.ok(checked.cases.every((item) => item.artifactWork.every((work) => work.disposition === null)));
  assert.deepEqual(checked.requestConstraints.recovery_operations, quotes);
  for (const pastCase of corpus.manifest.cases) for (const artifact of pastCase.artifacts) {
    const version = artifact.versions[0];
    assert.throws(() => validateSelections([{
      caseId: pastCase.caseId,
      artifactId: artifact.artifactId,
      versionId: version.versionId,
      passageIds: [version.passages[0].passageId],
    }], checked, corpus));
  }
  const reread = revalidateAssessment(checked, request, corpus);
  assert.equal(reread.conclusion, "no_useful_precedent");
  assert.deepEqual(reread.requestConstraints.recovery_operations, quotes);
  const job: JobRecord = {
    id: "00000000-0000-4000-8000-000000000035",
    request_text: request,
    corpus_version: corpus.manifest.corpusVersion,
    corpus_sha256: corpus.manifestSha256,
    stage: "ready",
    assessment_state: "ready",
    brief_state: "not_started",
    assessment_result: reread,
    brief_result: null,
    brief_selections: null,
    error_code: null,
    created_at: new Date("2026-10-15T00:00:00Z"),
    expires_at: new Date("2099-10-22T00:00:00Z"),
    assessment_queued_at: new Date("2026-10-15T00:00:00Z"),
    assessment_processing_started_at: null,
    assessment_finished_at: null,
    brief_queued_at: null,
    brief_processing_started_at: null,
    brief_finished_at: null,
  };
  job.assessment_result = revalidateAssessment(job.assessment_result!, job.request_text, corpus);
  const view = jobView(job);
  assert.equal(view.assessment?.conclusion, "no_useful_precedent");
  assert.deepEqual(view.assessment?.requestConstraints.recovery_operations, quotes);
  assert.throws(
    () => buildStarterPack(job, corpus, "https://demo.example"),
    (error: unknown) => error instanceof HttpFailure && error.status === 409 && error.code === "CHECKED_BRIEF_REQUIRED",
  );
  assert.equal(buildCheckedAssessment(draft, verdicts, invalid, corpus, roles, {
    request,
    constraints: { ...constraints, recovery_operations: [] },
  }).conclusion, "cannot_be_established");
  const unresolved = structuredClone(roles);
  unresolved.get("case-1/request")!.role = "unresolved";
  assert.equal(buildCheckedAssessment(draft, verdicts, invalid, corpus, unresolved, { request, constraints }).conclusion, "cannot_be_established");
  const unsupported = new Map(verdicts);
  for (const claimId of unsupported.keys()) {
    if (draft.cases.some((item) => item.artifactWork.some((work) => work.claimIds.includes(claimId) && claimId !== work.dispositionClaimId)) || claimId.startsWith("comparison-0-")) {
      unsupported.set(claimId, "unsupported");
    }
  }
  assert.equal(buildCheckedAssessment(draft, unsupported, invalid, corpus, roles, { request, constraints }).conclusion, "cannot_be_established");
  const preserved: AssessmentResult = { ...checked, conclusion: "cannot_be_established" };
  assert.equal(revalidateAssessment(preserved, request, corpus).conclusion, "cannot_be_established");
  corpus.passages.delete("p-request-v1");
  corpus.availableVersions.delete("request-v1");
  assert.equal(revalidateAssessment(checked, request, corpus).conclusion, "cannot_be_established");
});

test("independent per-item constraint coverage cannot be erased by an assessment-only relevance floor", () => {
  const corpus = fixture();
  const request = "Alpha limit applies. Beta window applies.";
  const QA = "Alpha limit applies.";
  const QB = "Beta window applies.";
  const refsFor = (artifactId: string, versionId: string) => [{
    caseId: "case-1", artifactId, versionId,
    passageId: artifactId === "request" ? "p-request-v1" : "p-handover-v1-case-1",
  }];
  const assessment = {
    conclusion: "precedent_found",
    clarifyingClaimIds: [],
    comparisons: [],
    requestConstraints: { product_version: [], environment: [], scale: [], identity_access: [], recovery_operations: [] },
    artifactReviews: [],
    nextActions: [],
    leads: [],
    contrasts: [],
    withheldClaimCount: 0,
    claims: [
      { claimId: "a-bound", kind: "recommendation", text: `Recorded check: ${QA}`, sourceRefs: refsFor("request", "request-v1"), requestQuotes: [QA], dependsOnClaimIds: [] },
      { claimId: "b-bound", kind: "recommendation", text: `Recorded check: ${QB}`, sourceRefs: refsFor("handover", "handover-v1-case-1"), requestQuotes: [QB], dependsOnClaimIds: [] },
      // A combined request's disposition claim declares every request sentence
      // as provenance without stating the other item's sentence in prose.
      { claimId: "a-disposition", kind: "recommendation", text: "Adapt this work for the combined request.", sourceRefs: refsFor("request", "request-v1"), requestQuotes: [QA, QB], dependsOnClaimIds: [] },
    ],
    cases: [{
      caseId: "case-1", availability: "available", outcome: "unknown", outcomeClaimIds: [], claimIds: [],
      artifactWork: [
        { artifactId: "request", availability: "available", exclusionReasons: [], disposition: "adapt", dispositionClaimId: "a-disposition", claimIds: ["a-bound"], blockerClaimIds: [], verificationClaimIds: [] },
        { artifactId: "handover", availability: "available", exclusionReasons: [], disposition: "adapt", dispositionClaimId: "b-disposition", claimIds: ["b-bound"], blockerClaimIds: [], verificationClaimIds: [] },
      ],
    }],
  } as unknown as AssessmentResult;
  assert.deepEqual(boundAssessmentQuotes(assessment, { caseId: "case-1", artifactId: "request", versionId: "request-v1" }), [QA],
    "Only quotations the item's own work both declares and states bind its brief coverage.");

  const draft: BriefDraft = {
    reuse: [], verify: [],
    adapt: [
      { caseId: "case-1", artifactId: "request", versionId: "request-v1", disposition: "adapt", dispositionClaimId: "a-disposition-brief", claimIds: ["a-disposition-brief", "a-quote"] },
      { caseId: "case-1", artifactId: "handover", versionId: "handover-v1-case-1", disposition: "adapt", dispositionClaimId: "b-disposition-brief", claimIds: ["b-disposition-brief", "b-quote"] },
    ],
    claims: [
      { claimId: "a-disposition-brief", kind: "recommendation", text: "Adapt this work after the checks below.", sourceRefs: refsFor("request", "request-v1"), requestQuotes: [], dependsOnClaimIds: [] },
      { claimId: "a-quote", kind: "recommendation", text: `Check first: ${QA}`, sourceRefs: refsFor("request", "request-v1"), requestQuotes: [QA], dependsOnClaimIds: [] },
      { claimId: "b-disposition-brief", kind: "recommendation", text: "Adapt this work after the checks below.", sourceRefs: refsFor("handover", "handover-v1-case-1"), requestQuotes: [], dependsOnClaimIds: [] },
      { claimId: "b-quote", kind: "recommendation", text: `Check first: ${QB}`, sourceRefs: refsFor("handover", "handover-v1-case-1"), requestQuotes: [QB], dependsOnClaimIds: [] },
    ],
  };
  const selections = [
    { caseId: "case-1", artifactId: "request", versionId: "request-v1" },
    { caseId: "case-1", artifactId: "handover", versionId: "handover-v1-case-1" },
  ];
  const verdicts = new Map<string, SupportVerdict>(draft.claims.map((claim) => [claim.claimId, "supported"]));
  // The independent reviewer inventories the handover item's quotation under both items.
  const constraintReviews = [
    { ...selections[0], requestQuotes: [QA, QB] },
    { ...selections[1], requestQuotes: [QB] },
  ];
  const checked = buildCheckedBrief(draft, verdicts, validateBriefDraft(draft, request, selections, corpus), { request, constraintReviews, assessment });
  assert.deepEqual(checked.adapt.map((item) => item.artifactId), ["handover"],
    "An independently required quotation must be carried by its item even when assessment coverage was narrower.");

  // The item's own bound quotation remains fully enforced.
  const doomed = structuredClone(draft);
  const own = doomed.claims.find((claim) => claim.claimId === "a-quote")!;
  own.text = "Check compatibility first.";
  own.requestQuotes = [];
  const withheld = buildCheckedBrief(doomed, verdicts, validateBriefDraft(doomed, request, selections, corpus), { request, constraintReviews, assessment });
  assert.deepEqual(withheld.adapt.map((item) => item.artifactId), ["handover"],
    "Dropping the item's own assessment-bound quotation still withholds that item.");
});

test("an uncertain required quotation carrier withholds the item rather than declaring incomplete coverage complete", () => {
  const corpus = fixture();
  const request = "Alpha limit applies. Beta window applies.";
  const QA = "Alpha limit applies.";
  const QB = "Beta window applies.";
  const refs = [{ caseId: "case-1", artifactId: "request", versionId: "request-v1", passageId: "p-request-v1" }];
  const assessment = {
    conclusion: "precedent_found",
    clarifyingClaimIds: [],
    comparisons: [],
    requestConstraints: { product_version: [], environment: [], scale: [], identity_access: [], recovery_operations: [] },
    artifactReviews: [],
    nextActions: [],
    leads: [],
    contrasts: [],
    withheldClaimCount: 0,
    claims: [
      { claimId: "a-bound", kind: "recommendation", text: `Recorded check: ${QA}`, sourceRefs: refs, requestQuotes: [QA], dependsOnClaimIds: [] },
    ],
    cases: [{
      caseId: "case-1", availability: "available", outcome: "unknown", outcomeClaimIds: [], claimIds: [],
      artifactWork: [
        { artifactId: "request", availability: "available", exclusionReasons: [], disposition: "adapt", dispositionClaimId: "a-disposition", claimIds: ["a-bound"], blockerClaimIds: [], verificationClaimIds: [] },
      ],
    }],
  } as unknown as AssessmentResult;
  const draft: BriefDraft = {
    reuse: [], verify: [],
    adapt: [
      { caseId: "case-1", artifactId: "request", versionId: "request-v1", disposition: "adapt", dispositionClaimId: "brief-disposition", claimIds: ["brief-disposition", "brief-bound-quote", "brief-extra-quote"] },
    ],
    claims: [
      { claimId: "brief-disposition", kind: "recommendation", text: "Adapt this work after the checks below.", sourceRefs: refs, requestQuotes: [], dependsOnClaimIds: [] },
      { claimId: "brief-bound-quote", kind: "recommendation", text: `Check first: ${QA}`, sourceRefs: refs, requestQuotes: [QA], dependsOnClaimIds: [] },
      { claimId: "brief-extra-quote", kind: "recommendation", text: `Also consider: ${QB}`, sourceRefs: refs, requestQuotes: [QB], dependsOnClaimIds: [] },
    ],
  };
  const selections = [{ caseId: "case-1", artifactId: "request", versionId: "request-v1" }];
  const verdicts = new Map<string, SupportVerdict>(draft.claims.map((claim) => [claim.claimId, "supported"]));
  verdicts.set("brief-extra-quote", "uncertain");
  const constraintReviews = [{ ...selections[0], requestQuotes: [QA, QB] }];
  const checked = buildCheckedBrief(draft, verdicts, validateBriefDraft(draft, request, selections, corpus), { request, constraintReviews, assessment });
  assert.deepEqual(checked.adapt, []);
  assert.ok(!checked.claims.some((claim) => claim.kind === "recommendation"),
    "Neither the disposition nor a partial recommendation escapes the missing mandatory quotation.");
});
