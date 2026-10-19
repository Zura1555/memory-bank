import assert from "node:assert/strict";
import Ajv from "ajv";
import test from "node:test";
import type { ArtifactReview, ArtifactRole, AssessmentResult, Claim, RequestConstraints, Selection, SupportVerdict } from "../shared/protocol.ts";
import { OPERATION_CHECKS, REQUIRED_OPERATION_CHECKS, renderOperationCheck, type OperationCheckKind, type OperationKind } from "../shared/operations.ts";
import { assessmentDraftSchema, assessmentReviewSchema, briefDraftSchema, obligationClaimText, openRouterSchema, parseAssessmentDraft, reviewSchema, type AssessmentDraft, type AssessmentOutput, type BriefDraft } from "./schemas.ts";
import { buildCheckedAssessment, buildCheckedBrief, GateFailure, revalidateAssessment, revalidateBrief, validateAssessmentDraft, validateBriefDraft, validateArtifactReview, validateSupportReview } from "./gates.ts";
import { HttpFailure } from "./errors.ts";
import { jobView, type JobRecord } from "./jobs.ts";
import { buildStarterPack } from "./packs.ts";
import { validateSelections } from "./selections.ts";
import { assessmentPassageIds, EvidenceUnavailable, type Artifact, type CorpusSnapshot, type ModelCaseContext, type PastCase, type SourceVersion } from "./corpus.ts";
import { boundAssessmentQuotes, requestSpans } from "./request-constraints.ts";
import { dispositionChanges } from "../ui/lineage.ts";
import { assessmentDraftPrompt, assessmentReviewPrompt, briefDraftPrompt, briefReviewPrompt, selectedAssessment } from "./prompts.ts";
import { callModel } from "./model.ts";
import type { Env } from "./env.ts";

const currentRequest = "Assess this current request.";
const emptyRequirementReview: Parameters<typeof buildCheckedAssessment>[5] = {
  request: currentRequest,
  constraints: { product_version: [], environment: [], scale: [], identity_access: [], recovery_operations: [] },
  missingEvidenceReview: { verdict: "supported", reason: null, claimIds: [] },
};

function requestSpanId(request: string, text: string): string {
  const span = requestSpans(request).find((item) => item.text === text);
  if (!span) throw new Error(`No request span for ${JSON.stringify(text)}.`);
  return span.spanId;
}

function artifactRoles(draft: AssessmentDraft, role: ArtifactRole = "starting_point"): Map<string, ArtifactReview> {
  return new Map(draft.cases.flatMap((item) => item.artifactWork.map((work) => [
    `${item.caseId}/${work.artifactId}`,
    {
      caseId: item.caseId, artifactId: work.artifactId, role, decision: work.decision,
      verdict: "supported" as const, reasons: [],
      claimFindings: work.claimIds.filter((claimId) => claimId !== work.dispositionClaimId).map((claimId) => ({
        claimId, verdict: "supported" as const, reason: null,
      })),
    },
  ])));
}
function rejectFinding(
  review: ArtifactReview,
  claim: Claim,
  target: "history" | "adaptation" | "check" | "request_constraint",
  verdict: "unsupported" | "uncertain",
): void {
  const reason = {
    explanation: `Synthetic claim finding is ${verdict}.`,
    sourceRefs: claim.sourceRefs,
    requestQuotes: claim.requestQuotes,
  };
  Object.assign(review.claimFindings.find((finding) => finding.claimId === claim.claimId)!, { verdict, reason });
  review.reasons.push({ ...reason, target, claimId: claim.claimId });
}
function syncArtifactFindings(
  draft: AssessmentDraft,
  reviews: Map<string, ArtifactReview>,
  verdicts: Map<string, SupportVerdict>,
): Map<string, ArtifactReview> {
  for (const item of draft.cases) {
    for (const work of item.artifactWork) {
      const review = reviews.get(`${item.caseId}/${work.artifactId}`)!;
      for (const claimId of work.claimIds) {
        if (claimId === work.dispositionClaimId) continue;
        const verdict = verdicts.get(claimId);
        if (!verdict || verdict === "supported") continue;
        const claim = draft.claims.find((candidate) => candidate.claimId === claimId)!;
        const target = claimId.includes("-adapt-") ? "adaptation" : claimId.includes("-check-") ? "check" : claimId.includes("-obligation-") ? "request_constraint" : "history";
        rejectFinding(review, claim, target, verdict);
      }
    }
  }
  return reviews;
}

type ConditionSlot = AssessmentOutput["cases"][number]["artifactWork"][number]["obligations"][number]["checkIndexes"][number];
const conditionSlot = (index: number): ConditionSlot => String(index) as ConditionSlot;

function proposal(
  artifactId: string,
  historicalEvidence: string[],
  disposition: "adapt" | "reuse" | "verify" | null = "adapt",
  requestQuotes: string[] = [],
  operation: OperationKind = "api_adapter",
): AssessmentOutput["cases"][number]["artifactWork"][number] {
  if (disposition === null) return { artifactId, disposition, operation: null, historicalEvidence, requestQuotes: [], adaptations: [], checks: [], obligations: [] };
  const adaptations = disposition === "adapt" ? (requestQuotes.length ? requestQuotes : [null]).map((quote) => ({
    text: "Adapt the recorded procedure to the client's requested limits.",
    sourceRefs: historicalEvidence, requestQuotes: quote ? [quote] : [],
  })) : [];
  const obligations = requestQuotes.map((quote, index) => ({
    requestQuote: quote, requirement: quote, requiresAdaptation: disposition === "adapt",
    checkKind: null, adaptationIndexes: disposition === "adapt" ? [conditionSlot(index)] : [], checkIndexes: [],
  }));
  const checks = disposition === "reuse" ? [] : Object.keys(OPERATION_CHECKS[operation])
    .filter((kind) => (REQUIRED_OPERATION_CHECKS[operation] as readonly string[]).includes(kind))
    .map((kind) => ({ kind: kind as OperationCheckKind, sourceRefs: historicalEvidence, requestQuotes: [] }));
  return assessmentDraftSchema.shape.cases.element.shape.artifactWork.element.parse({
    artifactId, disposition, operation, historicalEvidence, requestQuotes,
    adaptations, checks, obligations,
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
      const obligationClaimId = `artifact-${suffix}-obligation-0`;
      const obligation = {
        claimId: obligationClaimId,
        requestQuote: currentRequest,
        requirement: currentRequest,
        requiresAdaptation: true,
        checkKind: null,
        adaptationClaimIds: [adaptationId],
        checkClaimIds: [],
      };
      claims.push(
        { claimId: factId, text: version.passages[0].excerpt, kind: "source_fact", sourceRefs, requestQuotes: [], dependsOnClaimIds: [] },
        { claimId: operationClaimId, text: `The historical operation documented by this artifact is ${operation.replace("_", " ")}.`, kind: "interpretation", sourceRefs, requestQuotes: [], dependsOnClaimIds: [factId] },
        { claimId: dispositionClaimId, text: "Adapt the recorded work after checking the client's capabilities for the current request.", kind: "recommendation", sourceRefs, requestQuotes: [currentRequest], dependsOnClaimIds: [factId, operationClaimId] },
        { claimId: adaptationId, text: adaptation.text, kind: "recommendation", sourceRefs, requestQuotes: adaptation.requestQuotes, dependsOnClaimIds: [dispositionClaimId, factId] },
        ...checks.map((check, checkIndex) => ({
          claimId: checkClaimIds[checkIndex], text: check.text, kind: "recommendation" as const, sourceRefs: check.sourceRefs,
          requestQuotes: check.requestQuotes, dependsOnClaimIds: [dispositionClaimId, factId],
        })),
        {
          claimId: obligationClaimId, text: obligationClaimText(currentRequest),
          kind: "interpretation", sourceRefs, requestQuotes: [currentRequest],
          dependsOnClaimIds: [dispositionClaimId, adaptationId],
        },
      );
      return {
        artifactId: artifact.artifactId, disposition: "adapt" as const, dispositionClaimId,
        decision: { disposition: "adapt" as const, operation, historicalEvidence: sourceRefs, requestQuotes: [currentRequest], adaptations: [adaptation], checks, obligations: [obligation] },
        claimIds: [factId, operationClaimId, dispositionClaimId, adaptationId, ...checkClaimIds, obligationClaimId],
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
    missingEvidenceRequests: [],
    comparisons: [],
    requestConstraints: { ...emptyRequirementReview.constraints },
    claims,
  };
}

test("brief assessment background is scoped to selected work without cutting its dependencies", () => {
  const corpus = fixture();
  const draft = assessmentDraft(corpus);
  draft.missingEvidenceRequests = draft.cases[0].artifactWork.map((work, index) => ({
    caseId: "case-1", artifactId: work.artifactId, claimId: `missing-evidence-${index}`,
  }));
  for (const [index, entry] of draft.missingEvidenceRequests.entries()) {
    const fact = draft.claims.find((claim) => claim.claimId === `fact-0-${index}`)!;
    draft.claims.push({
      claimId: entry.claimId, kind: "interpretation", text: "Missing evidence request: Provide current-client acceptance evidence.",
      sourceRefs: fact.sourceRefs, requestQuotes: [currentRequest], dependsOnClaimIds: [fact.claimId],
    });
    draft.cases[0].claimIds.push(entry.claimId);
  }
  const checked = buildCheckedAssessment(draft, new Map(draft.claims.map((item) => [item.claimId, "supported"])), new Set(), corpus, artifactRoles(draft), {
    ...emptyRequirementReview, missingEvidenceReview: { verdict: "supported", reason: null, claimIds: draft.missingEvidenceRequests.map((item) => item.claimId) },
  });
  const selected = [{ caseId: "case-1", artifactId: "handover", versionId: "handover-v1-case-1", passageIds: ["p-handover-v1-case-1"] }];
  const scoped = selectedAssessment(checked, selected);
  assert.deepEqual(scoped.cases.map((item) => item.caseId), ["case-1"], "Unselected cases are not brief background.");
  assert.deepEqual(scoped.cases[0].artifactWork.map((item) => item.artifactId), ["handover"], "Only the selected artifact's checked work is retained.");
  assert.ok(scoped.artifactReviews.every((item) => item.caseId === "case-1" && item.artifactId === "handover"));
  const claimIds = new Set(scoped.claims.map((claim) => claim.claimId));
  assert.ok(claimIds.has("decision-0-1") && claimIds.has("fact-0-1"), "The selected claim and its dependency survive scoping.");
  assert.ok(!claimIds.has("fact-1-0") && !claimIds.has("decision-7-0"), "Claims belonging only to unselected cases are omitted.");
  assert.deepEqual(scoped.missingEvidenceRequests.map((item) => item.artifactId), ["handover"]);
  assert.ok(claimIds.has("missing-evidence-1") && !claimIds.has("missing-evidence-0"), "Unselected gap requests are not selected brief material.");
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
  const draft = assessmentDraft(corpus);
  const checked = buildCheckedAssessment(
    draft,
    new Map(draft.claims.map((claim) => [claim.claimId, "supported"])),
    new Set(),
    corpus,
    artifactRoles(draft),
    emptyRequirementReview,
  );
  const selection: Selection = { caseId: "case-1", artifactId: "request", versionId: "request-v2", passageIds: ["p-request-v2"] };
  assert.throws(
    () => validateSelections([selection], checked, corpus),
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
      missingEvidenceRequests: [],
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
    }
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
test("operation prerequisites remain bound to their own request decision through build, reread, and selection", () => {
  const corpus = fixture();
  const apiStatus = "The adapter must preserve terminal status for every submitted operation.";
  const handoverCheckpoint = "The handover must verify the target checkpoint before replay.";
  const request = `${apiStatus} ${handoverCheckpoint}`;
  const labels = assessmentPassageIds(corpus);
  const output: AssessmentOutput = {
      missingEvidenceRequests: [],
      requestConstraints: emptyRequirementReview.constraints, claims: [], clarifyingClaimIds: [], leads: [], contrasts: [],
      cases: corpus.manifest.cases.map((item, caseIndex) => ({
        caseId: item.caseId, outcome: "unknown",
        artifactWork: item.artifacts.map((artifact, workIndex) => {
          const source = labels.get(artifact.versions[0].passages[0].passageId)!;
          if (caseIndex !== 0) return proposal(artifact.artifactId, [source], null);
          const isAdapter = workIndex === 0;
          const operation = isAdapter ? "api_adapter" : "recovery_handover";
          const quote = isAdapter ? apiStatus : handoverCheckpoint;
          const work = proposal(artifact.artifactId, [source], "adapt", [quote], operation);
          work.checks.find((check) => check.kind === (isAdapter ? "result_status_duplicates" : "checkpoint_replay"))!.requestQuotes = [quote];
          return work;
        }),
      })),
    }
  const constraints = emptyRequirementReview.constraints;
  const selections = [
    { caseId: "case-1", artifactId: "request", versionId: "request-v1", passageIds: ["p-request-v1"] },
    { caseId: "case-1", artifactId: "handover", versionId: "handover-v1-case-1", passageIds: ["p-handover-v1-case-1"] },
  ];
  const build = (
    draft: AssessmentDraft,
    verdicts = new Map(draft.claims.map((claim) => [claim.claimId, "supported" as SupportVerdict])),
    reviews = syncArtifactFindings(draft, artifactRoles(draft), verdicts),
  ) => buildCheckedAssessment(draft, verdicts, validateAssessmentDraft(draft, request, corpus), corpus, reviews, { ...emptyRequirementReview, request, constraints });
  const draft = parseAssessmentDraft(output, corpus);
  const checked = build(draft);
  const adapterDecision = checked.artifactReviews.find((review) => review.artifactId === "request")!.decision;
  const handoverDecision = checked.artifactReviews.find((review) => review.artifactId === "handover")!.decision;
  assert.deepEqual(adapterDecision.checks.find((check) => check.kind === "result_status_duplicates")?.requestQuotes, [apiStatus]);
  assert.deepEqual(handoverDecision.checks.find((check) => check.kind === "checkpoint_replay")?.requestQuotes, [handoverCheckpoint]);
  assert.deepEqual(validateSelections(selections, checked, corpus), selections);
  assert.deepEqual(revalidateAssessment(checked, request, corpus), checked);

  const crossBound = structuredClone(output);
  crossBound.cases[0].artifactWork[1].checks.find((check) => check.kind === "checkpoint_replay")!.requestQuotes = [apiStatus];
  const rejectedHandover = build(parseAssessmentDraft(crossBound, corpus));
  assert.equal(rejectedHandover.cases[0].artifactWork[0].disposition, "adapt", "The adapter keeps its own status prerequisite.");
  assert.equal(rejectedHandover.cases[0].artifactWork[1].disposition, null, "A foreign API quotation cannot bind the handover check.");
  assert.deepEqual(validateSelections([selections[0]], rejectedHandover, corpus), [selections[0]]);
  assert.throws(() => validateSelections([selections[1]], rejectedHandover, corpus));
  const rereadMismatch = revalidateAssessment(rejectedHandover, request, corpus);
  assert.deepEqual(validateSelections([selections[0]], rereadMismatch, corpus), [selections[0]]);
  assert.throws(() => validateSelections([selections[1]], rereadMismatch, corpus));

  const crossBoundAdaptation = structuredClone(output);
  crossBoundAdaptation.cases[0].artifactWork[1].adaptations[0].requestQuotes = [apiStatus];
  const rejectedAdaptation = build(parseAssessmentDraft(crossBoundAdaptation, corpus));
  assert.equal(rejectedAdaptation.cases[0].artifactWork[0].disposition, "adapt");
  assert.equal(rejectedAdaptation.cases[0].artifactWork[1].disposition, null);

  const importedStatus = structuredClone(output);
  importedStatus.cases[0].artifactWork[1].requestQuotes = [apiStatus, handoverCheckpoint];
  importedStatus.cases[0].artifactWork[1].checks.find((check) => check.kind === "checkpoint_replay")!.requestQuotes = [apiStatus];
  const rejectedImport = build(parseAssessmentDraft(importedStatus, corpus));
  assert.equal(rejectedImport.cases[0].artifactWork[0].disposition, "adapt", "The adapter keeps its own status prerequisite.");
  assert.equal(rejectedImport.cases[0].artifactWork[1].disposition, null, "Putting an adapter-status span in the handover inventory still cannot bind checkpoint replay.");

  const handoverWork = draft.cases[0].artifactWork[1];
  const checkpointIndex = handoverWork.decision.checks.findIndex((check) => check.kind === "checkpoint_replay");
  for (const verdict of ["unsupported", "uncertain"] as const) {
    const verdicts = new Map(draft.claims.map((claim) => [claim.claimId, "supported" as SupportVerdict]));
    verdicts.set(handoverWork.verificationClaimIds[checkpointIndex]!, verdict);
    const withheld = build(draft, verdicts);
    assert.equal(withheld.cases[0].artifactWork[0].disposition, "adapt");
    assert.equal(withheld.cases[0].artifactWork[1].disposition, null);
  }

  const missingCheckpoint = structuredClone(output);
  missingCheckpoint.cases[0].artifactWork[1].checks = [{
    kind: "operating_authority" as OperationCheckKind,
    sourceRefs: output.cases[0].artifactWork[1].historicalEvidence,
    requestQuotes: [handoverCheckpoint],
  }];
  const missingDraft = parseAssessmentDraft(missingCheckpoint, corpus);
  const missingReviews = artifactRoles(missingDraft);
  const missingCheckIndex = missingDraft.cases[0].artifactWork[1].decision.checks.findIndex((check) => check.kind === "operating_authority");
  const missingCheckId = missingDraft.cases[0].artifactWork[1].verificationClaimIds[missingCheckIndex]!;
  const missingChecked = build(missingDraft, undefined, missingReviews);
  assert.equal(missingChecked.cases[0].artifactWork[0].disposition, "adapt");
  assert.equal(missingChecked.cases[0].artifactWork[1].disposition, null);
});


test("operation-scoped typed prerequisites preserve conditional adapter and handover work", () => {
  const corpus = fixture();
  const request = "Target API authorization remains unconfirmed. The handover's decision authority remains unconfirmed.";
  const apiQuote = "Target API authorization remains unconfirmed.";
  const handoverQuote = "The handover's decision authority remains unconfirmed.";
  const ids = assessmentPassageIds(corpus);
  const output: AssessmentOutput = {
      missingEvidenceRequests: [],
      requestConstraints: emptyRequirementReview.constraints, claims: [], clarifyingClaimIds: [], contrasts: [],
      leads: [{ caseId: "case-1", state: "conditional", reasonClaimIds: ["lead-reason"], comparisons: [] }],
      cases: corpus.manifest.cases.map((item, caseIndex) => ({
        caseId: item.caseId, outcome: "unknown",
        artifactWork: item.artifacts.map((artifact, workIndex) => {
          const operation = workIndex === 0 ? "api_adapter" : "recovery_handover";
          const quote = operation === "api_adapter" ? apiQuote : handoverQuote;
          const disposition = caseIndex === 0 ? "adapt" : null;
          const work = proposal(artifact.artifactId, [ids.get(artifact.versions[0].passages[0].passageId)!], disposition, disposition ? [quote] : [], operation);
          if (work.disposition !== null) work.checks.find((check) => check.kind === (operation === "api_adapter" ? "client_api_access" : "operating_authority"))!.requestQuotes = [quote];
          return work;
        }),
      })),
    }
  output.claims.push({ claimId: "lead-reason", caseId: "case-1", kind: "source_fact", outcomeEvidence: false, sourceRefs: [ids.get("p-request-v1")!], requestQuotes: [], dependsOnClaimIds: [] });
  const draft = parseAssessmentDraft(output, corpus);
  const invalid = validateAssessmentDraft(draft, request, corpus);
  const reviews = artifactRoles(draft);
  const verdicts = new Map(draft.claims.map((claim) => [claim.claimId, "supported" as SupportVerdict]));
  const constraints = emptyRequirementReview.constraints;
  const requirementReview = { ...emptyRequirementReview, request, constraints }
  const build = (support = verdicts, decisions = reviews, candidate = draft) =>
    buildCheckedAssessment(candidate, support, validateAssessmentDraft(candidate, request, corpus), corpus, decisions, requirementReview);
  const selected = [{ caseId: "case-1", artifactId: "request", versionId: "request-v1", passageIds: ["p-request-v1"] }];
  const handoverSelection = [{ caseId: "case-1", artifactId: "handover", versionId: "handover-v1-case-1", passageIds: ["p-handover-v1-case-1"] }];
  const checked = build();
  assert.equal(checked.cases[0].artifactWork[0].disposition, "adapt");
  assert.equal(checked.cases[0].artifactWork[1].disposition, "adapt");
  const apiDecision = checked.artifactReviews.find((item) => item.artifactId === "request")!.decision;
  const handoverDecision = checked.artifactReviews.find((item) => item.artifactId === "handover")!.decision;
  assert.deepEqual(validateSelections([...selected, ...handoverSelection], checked, corpus), [...selected, ...handoverSelection]);
  assert.deepEqual(revalidateAssessment(checked, request, corpus), checked);
  assert.deepEqual(boundAssessmentQuotes(checked, selected[0]), [apiQuote]);
  const wrongCanonicalOperation = structuredClone(checked);
  wrongCanonicalOperation.artifactReviews.find((item) => item.artifactId === "request")!.decision.operation = "recovery_handover";
  assert.throws(() => revalidateAssessment(wrongCanonicalOperation, request, corpus));
  const wrongCanonicalKind = structuredClone(checked);
  Object.assign(wrongCanonicalKind.artifactReviews.find((item) => item.artifactId === "request")!.decision.checks.find((check) => check.kind === "client_api_access")!, { kind: "operating_authority" });
  assert.throws(() => revalidateAssessment(wrongCanonicalKind, request, corpus));
  const authoredCanonicalText = structuredClone(checked);
  authoredCanonicalText.artifactReviews.find((item) => item.artifactId === "request")!.decision.checks.find((check) => check.kind === "client_api_access")!.text = "Provider-authored check text.";
  assert.throws(() => revalidateAssessment(authoredCanonicalText, request, corpus));
  const foreignCanonicalEvidence = structuredClone(checked);
  foreignCanonicalEvidence.artifactReviews.find((item) => item.artifactId === "request")!.decision.checks.find((check) => check.kind === "client_api_access")!.sourceRefs =
    handoverDecision.checks.find((check) => check.kind === "operating_authority")!.sourceRefs;
  assert.throws(() => revalidateAssessment(foreignCanonicalEvidence, request, corpus));
  const misplacedCheck = structuredClone(output);
  Object.assign(misplacedCheck.cases[0].artifactWork[0].checks.find((check) => check.kind === "client_api_access")!, { kind: "operating_authority" });
  assert.equal(assessmentDraftSchema.safeParse(misplacedCheck).success, false);
  assert.throws(() => parseAssessmentDraft(misplacedCheck, corpus));
  const work = draft.cases[0].artifactWork[0];
  const primaryCheckIndex = work.decision.checks.findIndex((check) => check.kind === "client_api_access");
  const primaryCheckId = work.verificationClaimIds[primaryCheckIndex]!;
  const rejectedClaimIds = [
    work.claimIds.find((id) => id.includes("-history-"))!,
    work.claimIds.find((id) => id.endsWith("-operation"))!,
    work.claimIds.find((id) => id.includes("-adapt-"))!,
    primaryCheckId,
    work.claimIds.find((id) => id.includes("-obligation-"))!,
  ];
  // Synthetic verdicts exercise fail-closed propagation, not semantic qualification.
  for (const id of rejectedClaimIds) {
    const rejectedVerdicts = new Map(verdicts);
    rejectedVerdicts.set(id, "unsupported");
    const rejectedReviews = artifactRoles(draft);
    const claim = draft.claims.find((item) => item.claimId === id)!;
    const target = id.includes("-adapt-") ? "adaptation" : id.includes("-check-") ? "check" : id.includes("-obligation-") ? "request_constraint" : "history";
    rejectFinding(rejectedReviews.get("case-1/request")!, claim, target, "unsupported");
    const rejected = build(rejectedVerdicts, rejectedReviews);
    assert.equal(rejected.cases[0].artifactWork[0].disposition, null);
    assert.ok(!rejected.leads[0]?.usefulArtifactIds.includes("request"));
    assert.ok(!rejected.nextActions.some((action) => action.artifactId === "request"));
    assert.ok(!rejected.claims.some((claim) => claim.claimId === work.dispositionClaimId));
    assert.equal(rejected.artifactReviews.find((item) => item.artifactId === "request")?.role, "starting_point");
    assert.equal(rejected.artifactReviews.find((item) => item.artifactId === "request")?.verdict, "supported");
    if (id === primaryCheckId) {
      assert.ok(!rejected.claims.some((claim) => claim.claimId === id));
      assert.throws(() => briefDraftPrompt(request, selected, corpus, rejected), /BRIEF_CHECKED_DECISION_REQUIRED/);
    }
  }
  const obligationId = work.claimIds.find((claimId) => claimId.includes("-obligation-"))!;
  for (const verdict of ["unsupported", "uncertain"] as const) {
    const rejectedVerdicts = new Map(verdicts);
    rejectedVerdicts.set(obligationId, verdict);
    const rejectedReviews = artifactRoles(draft);
    rejectFinding(rejectedReviews.get("case-1/request")!, draft.claims.find((claim) => claim.claimId === obligationId)!, "request_constraint", verdict);
    const rejected = build(rejectedVerdicts, rejectedReviews);
    assert.equal(rejected.cases[0].artifactWork[0].disposition, null);
    assert.throws(() => validateSelections(selected, rejected, corpus));
    const rereadRejected = revalidateAssessment(rejected, request, corpus);
    assert.equal(rereadRejected.cases[0].artifactWork[0].disposition, null);
    assert.throws(() => validateSelections(selected, rereadRejected, corpus));
  }
  const missingSlot = structuredClone(output);
  missingSlot.cases[0].artifactWork[0].obligations[0].adaptationIndexes = ["7"];
  assert.throws(() => parseAssessmentDraft(missingSlot, corpus));
  const wrongSlot = structuredClone(output);
  wrongSlot.cases[0].artifactWork[0].obligations[0].checkKind = "client_operation_limits";
  wrongSlot.cases[0].artifactWork[0].obligations[0].checkIndexes = ["0"];
  const foreignQuote = structuredClone(output);
  foreignQuote.cases[0].artifactWork[0].obligations[0].requestQuote = handoverQuote;
  const rejectMalformed = (value: AssessmentOutput) => {
    const malformedDraft = parseAssessmentDraft(value, corpus);
    const malformed = build(new Map(malformedDraft.claims.map((claim) => [claim.claimId, "supported"])), artifactRoles(malformedDraft), malformedDraft);
    assert.equal(malformed.cases[0].artifactWork[0].disposition, null);
    assert.throws(() => validateSelections(selected, malformed, corpus));
    const rereadMalformed = revalidateAssessment(malformed, request, corpus);
    assert.equal(rereadMalformed.cases[0].artifactWork[0].disposition, null);
    assert.throws(() => validateSelections(selected, rereadMalformed, corpus));
  };
  rejectMalformed(wrongSlot);
  assert.throws(() => parseAssessmentDraft(foreignQuote, corpus));
  const wrongKind = structuredClone(output);
  wrongKind.cases[0].artifactWork[0].obligations[0].checkKind = "checkpoint_replay" as OperationCheckKind;
  assert.equal(assessmentDraftSchema.safeParse(wrongKind).success, false);
  assert.throws(() => parseAssessmentDraft(wrongKind, corpus));
  const assertedCapability = structuredClone(output);
  assertedCapability.cases[0].artifactWork[0].adaptations[0].text = "The target API authorization is confirmed and available; proceed with the adapter.";
  const capabilityDraft = parseAssessmentDraft(assertedCapability, corpus);
  const capabilityClaimId = capabilityDraft.cases[0].artifactWork[0].claimIds.find((id) => id.includes("-adapt-"))!;
  const capabilityVerdicts = new Map(capabilityDraft.claims.map((claim) => [claim.claimId, "supported" as SupportVerdict]));
  capabilityVerdicts.set(capabilityClaimId, "unsupported");
  const capabilityReviews = artifactRoles(capabilityDraft);
  rejectFinding(capabilityReviews.get("case-1/request")!, capabilityDraft.claims.find((claim) => claim.claimId === capabilityClaimId)!, "adaptation", "unsupported");
  const capabilityRejected = buildCheckedAssessment(capabilityDraft, capabilityVerdicts, validateAssessmentDraft(capabilityDraft, request, corpus), corpus, capabilityReviews, requirementReview);
  assert.equal(capabilityRejected.cases[0].artifactWork[0].disposition, null);
  assert.throws(() => validateSelections(selected, capabilityRejected, corpus));
  const decision = reviews.get("case-1/request")!;
  decision.verdict = "unsupported";
  decision.reasons = [{
    target: "request_constraint", requirement: apiQuote,
    explanation: "The proposed capability is not established for this client.",
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
test("valid bound API checkpoint wording remains eligible while another operation's check kind is rejected", () => {
  const corpus = fixture();
  const checkpoint = "Verify the API checkpoint response before continuing.";
  const request = `${checkpoint} Target API authorization remains unconfirmed.`;
  const labels = assessmentPassageIds(corpus);
  const output: AssessmentOutput = {
      missingEvidenceRequests: [],
      requestConstraints: emptyRequirementReview.constraints,
      claims: [],
      clarifyingClaimIds: [],
      leads: [],
      contrasts: [],
      cases: corpus.manifest.cases.map((pastCase, caseIndex) => ({
        caseId: pastCase.caseId,
        outcome: "unknown",
        artifactWork: pastCase.artifacts.map((artifact, workIndex) => {
          const work = proposal(
            artifact.artifactId,
            [labels.get(artifact.versions[0].passages[0].passageId)!],
            caseIndex === 0 && workIndex === 0 ? "adapt" : null,
            caseIndex === 0 && workIndex === 0 ? [checkpoint] : [],
            "api_adapter",
          );
          if (work.disposition !== null) work.checks.find((check) => check.kind === "client_api_access")!.requestQuotes = [checkpoint];
          return work;
        }),
      })),
    }
  const draft = parseAssessmentDraft(output, corpus);
  const checked = buildCheckedAssessment(draft, new Map(draft.claims.map((claim) => [claim.claimId, "supported" as SupportVerdict])), validateAssessmentDraft(draft, request, corpus), corpus, artifactRoles(draft), { ...emptyRequirementReview, request, constraints: emptyRequirementReview.constraints });
  const selection = [{ caseId: "case-1", artifactId: "request", versionId: "request-v1", passageIds: ["p-request-v1"] }];
  assert.deepEqual(validateSelections(selection, checked, corpus), selection);

  const wrongKind = structuredClone(output);
  wrongKind.cases[0].artifactWork[0].checks.find((check) => check.kind === "client_api_access")!.kind = "checkpoint_replay" as OperationCheckKind;
  assert.equal(assessmentDraftSchema.safeParse(wrongKind).success, false);
  assert.throws(() => parseAssessmentDraft(wrongKind, corpus));
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
        missingEvidenceRequests: [],
        requestConstraints: constraints, claims: [], clarifyingClaimIds: [], leads: [], contrasts: [],
        cases: corpus.manifest.cases.map((item, index) => ({
          caseId: item.caseId, outcome: "unknown",
          artifactWork: item.artifacts.map((artifact, artifactIndex) =>
            proposal(artifact.artifactId, [labels.get(artifact.versions[0].passages[0].passageId)!],
              index === 0 && artifactIndex === 0 ? "adapt" : null, index === 0 ? [quote] : [])),
        })),
      }
    const work = output.cases[0].artifactWork[0];
    work.obligations[0].checkKind = "client_operation_limits";
    const buildDraft = (draft: AssessmentDraft, rejected: SupportVerdict = "supported") => {
      const work = draft.cases[0].artifactWork[0];
      const limitClaims = new Set(work.verificationClaimIds.filter((id) =>
        work.decision.checks.some((check) => check.kind === "client_operation_limits"
          && check.text === draft.claims.find((claim) => claim.claimId === id)?.text)));
      const verdicts = new Map(draft.claims.map((claim) => [claim.claimId, limitClaims.has(claim.claimId) ? rejected : "supported" as SupportVerdict]));
      const reviews = syncArtifactFindings(draft, artifactRoles(draft), verdicts);
      return buildCheckedAssessment(draft, verdicts, validateAssessmentDraft(draft, request, corpus), corpus, reviews, { ...emptyRequirementReview, request, constraints });
    };
    const build = (value: AssessmentOutput, rejected: SupportVerdict = "supported") =>
      buildDraft(parseAssessmentDraft(value, corpus), rejected);
    const missing = build(output);
    assert.equal(missing.cases[0].artifactWork[0].disposition, null, "An explicit limit obligation without its owned check fails closed.");
    work.checks.push({ kind: "client_operation_limits", sourceRefs: work.historicalEvidence, requestQuotes: [quote] });
    const limitCheckIndex = conditionSlot(work.checks.findIndex((check) => check.kind === "client_operation_limits"));
    work.obligations[0].checkIndexes = [limitCheckIndex];
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
      wrongQuote.cases[0].artifactWork[0].checks.find((check) => check.kind === "client_operation_limits")!.requestQuotes = [otherQuote];
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
    missingQuote.cases[0].artifactWork[0].checks.find((check) => check.kind === "client_operation_limits")!.requestQuotes = [];
    assert.throws(() => parseAssessmentDraft(missingQuote, corpus));
  }
});
test("both word and digit limit obligations fail closed until their own limit check is bound", () => {
  for (const quote of ["Limit each batch to twenty records.", "Limit each batch to 20 records."]) {
    const corpus = fixture();
    const labels = assessmentPassageIds(corpus);
    const request = quote;
    const output: AssessmentOutput = {
        missingEvidenceRequests: [],
        requestConstraints: emptyRequirementReview.constraints,
        claims: [],
        clarifyingClaimIds: [],
        leads: [],
        contrasts: [],
        cases: corpus.manifest.cases.map((pastCase, caseIndex) => ({
          caseId: pastCase.caseId,
          outcome: "unknown",
          artifactWork: pastCase.artifacts.map((artifact, workIndex) => proposal(
            artifact.artifactId,
            [labels.get(artifact.versions[0].passages[0].passageId)!],
            caseIndex === 0 && workIndex === 0 ? "adapt" : null,
            caseIndex === 0 && workIndex === 0 ? [quote] : [],
          )),
        })),
      }
    const work = output.cases[0].artifactWork[0];
    work.obligations[0].checkKind = "client_operation_limits";
    const build = () => {
      const draft = parseAssessmentDraft(output, corpus);
      const verdicts = new Map(draft.claims.map((claim) => [claim.claimId, "supported" as SupportVerdict]));
      return buildCheckedAssessment(draft, verdicts, validateAssessmentDraft(draft, request, corpus), corpus, artifactRoles(draft), { ...emptyRequirementReview, request, constraints: emptyRequirementReview.constraints });
    };
    const selection = [{ caseId: "case-1", artifactId: "request", versionId: "request-v1", passageIds: ["p-request-v1"] }];
    const missing = build();
    assert.equal(missing.cases[0].artifactWork[0].disposition, null, `Missing a bound limit check must withhold: ${quote}`);
    assert.throws(() => validateSelections(selection, missing, corpus));
    const rereadMissing = revalidateAssessment(missing, request, corpus);
    assert.equal(rereadMissing.cases[0].artifactWork[0].disposition, null);
    assert.throws(() => validateSelections(selection, rereadMissing, corpus));

    work.checks.push({ kind: "client_operation_limits", sourceRefs: work.historicalEvidence, requestQuotes: [quote] });
    const checkIndex = conditionSlot(work.checks.findIndex((check) => check.kind === "client_operation_limits"));
    work.obligations[0].checkIndexes = [checkIndex];
    const checked = build();
    assert.equal(checked.cases[0].artifactWork[0].disposition, "adapt");
    assert.ok(checked.artifactReviews.find((review) => review.artifactId === "request")!.decision.checks
      .find((check) => check.kind === "client_operation_limits")!.text.includes(quote));
    assert.deepEqual(validateSelections(selection, revalidateAssessment(checked, request, corpus), corpus), selection);
  }
});

test("mapping reconciliation keeps proposed scope and timing visible while uncertain feasibility still blocks selection", () => {
  const corpus = fixture();
  const scope = "Only a segregated 700-active-row sandbox pilot is authorized.";
  const timing = "Complete accepted/rejected reconciliation within 18 elapsed hours of receipt, with zero production writes.";
  const request = `${scope} ${timing}`;
  const constraints = { ...emptyRequirementReview.constraints, scale: [scope], recovery_operations: [timing] };
  const labels = assessmentPassageIds(corpus);
  const output: AssessmentOutput = {
      missingEvidenceRequests: [],
      requestConstraints: constraints, claims: [], clarifyingClaimIds: [], leads: [], contrasts: [],
      cases: corpus.manifest.cases.map((item, index) => ({
        caseId: item.caseId, outcome: "unknown",
        artifactWork: item.artifacts.map((artifact, artifactIndex) => {
          const work = proposal(artifact.artifactId, [labels.get(artifact.versions[0].passages[0].passageId)!],
            index === 0 && artifactIndex === 0 ? "adapt" : null, [scope, timing], "data_mapping");
          if (work.disposition === "adapt") {
            work.adaptations = [scope, timing].map((quote) => ({
              text: `Adapt the data-mapping work for this requested constraint: ${quote}`,
              sourceRefs: work.historicalEvidence, requestQuotes: [quote],
            }));
            work.checks = [
              work.checks.find((check) => check.kind === "field_identity")!,
              work.checks.find((check) => check.kind === "reconciliation")!,
              work.checks.find((check) => check.kind === "environment_boundary")!,
              ...[scope, timing].map((quote) => ({ kind: "completion_feasibility" as const, sourceRefs: work.historicalEvidence, requestQuotes: [quote] })),
            ];
          }
          return work;
        }),
      })),
    }
  for (const requestQuotes of [[], [scope, timing]]) {
    const invalid = structuredClone(output);
    invalid.cases[0].artifactWork[0].checks.find((check) => check.kind === "completion_feasibility")!.requestQuotes = requestQuotes;
    assert.throws(() => parseAssessmentDraft(invalid, corpus), "Feasibility must bind exactly one current-request target.");
  }
  const wrongOperation = structuredClone(output);
  wrongOperation.cases[0].artifactWork[0].operation = "api_adapter";
  assert.throws(() => parseAssessmentDraft(wrongOperation, corpus), "Mapping timing checks cannot certify another operation.");
  const draft = parseAssessmentDraft(output, corpus);
  const work = draft.cases[0].artifactWork[0];
  // Synthetic reviews exercise prerequisite/decision propagation, not model judgment.
  const build = (verdict: SupportVerdict) => {
    const verdicts = new Map(draft.claims.map((claim) => [claim.claimId, work.verificationClaimIds.includes(claim.claimId) ? verdict : "supported" as SupportVerdict]));
    return buildCheckedAssessment(draft, verdicts, validateAssessmentDraft(draft, request, corpus), corpus, syncArtifactFindings(draft, artifactRoles(draft), verdicts), { ...emptyRequirementReview, request, constraints });
  };
  const checked = build("supported");
  const checks = checked.artifactReviews[0].decision.checks;
  for (const quote of [scope, timing]) {
    assert.ok(checks.some((check) => check.text.includes(quote)), "A visible feasibility prerequisite must bind the exact requested scope/deadline, not leave it only in metadata.");
  }
  assert.deepEqual(revalidateAssessment(checked, request, corpus), checked);
  const selection = [{ caseId: "case-1", artifactId: "request", versionId: "request-v1", passageIds: ["p-request-v1"] }];
  assert.deepEqual(validateSelections(selection, checked, corpus), selection);
  for (const verdict of ["unsupported", "uncertain"] as const) {
    const rejected = build(verdict);
    assert.equal(rejected.cases[0].artifactWork[0].disposition, null);
    assert.throws(() => validateSelections(selection, rejected, corpus));
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
        missingEvidenceRequests: [],
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
      }
    output.claims.push({ claimId: "lead-reason", caseId: "case-1", kind: "source_fact", outcomeEvidence: false,
      sourceRefs: [labels.get("p-request-v1")!], requestQuotes: [], dependsOnClaimIds: [] });
    const selections = corpus.manifest.cases[0].artifacts.map((artifact) => ({
      caseId: "case-1", artifactId: artifact.artifactId, versionId: artifact.versions[0].versionId,
      passageIds: [artifact.versions[0].passages[0].passageId],
    }));
    // Synthetic verdicts prove independent review propagation, not model judgment.
    const build = (value: AssessmentOutput, rejected?: { index: number; target: "adaptation" | "disposition"; verdict: "unsupported" | "uncertain" }) => {
      const draft = parseAssessmentDraft(value, corpus);
      const targets = assessmentReviewPrompt(request, corpus, draft).reviewTargets!;
      const rejectedWork = rejected ? draft.cases[0].artifactWork[rejected.index] : undefined;
      const rejectedClaim = rejected?.target === "adaptation"
        ? rejectedWork?.claimIds.find((id) => id.includes("-adapt-"))
        : undefined;
      const wire = {
        requestConstraints: { product_version: [], environment: [], scale: [requestSpanId(request, apiQuote)], identity_access: [], recovery_operations: [requestSpanId(request, handoverQuote)] },
        missingEvidenceReview: { verdict: "supported", reason: null },
        decisions: Object.fromEntries(targets.artifacts!.map((item) => {
          const reject = rejected?.target === "disposition" && item.caseId === "case-1" && item.artifactId === rejectedWork?.artifactId;
          const label = labels.get(draft.cases[0].artifactWork.find((work) => work.artifactId === item.artifactId)!.decision.historicalEvidence[0].passageId)!;
          return [`${item.caseId}/${item.artifactId}`, {
            disposition: item.disposition, role: item.disposition === null ? "context_only" : "starting_point",
            verdict: reject ? rejected!.verdict : "supported",
            reasons: reject ? [{
              target: "disposition",
              explanation: "Synthetic independent rejection of the cited proposal.",
              sourceRefs: [label],
              requestQuotes: [],
            }] : [],
          }];
        })),
        claimJudgments: Object.fromEntries(targets.claimIds.map((id) => {
          const claim = draft.claims.find((item) => item.claimId === id)!;
          const reject = rejected?.target === "adaptation" && id === rejectedClaim;
          const label = labels.get(claim.sourceRefs[0].passageId)!;
          return [id, reject ? {
            verdict: rejected!.verdict,
            reason: {
              explanation: `Synthetic adaptation finding is ${rejected!.verdict}.`,
              sourceRefs: [label],
              requestQuotes: claim.requestQuotes.map((quote) => requestSpanId(request, quote)),
            },
          } : { verdict: "supported", reason: null }];
        })),
      };
      const review = assessmentReviewSchema.parse(reviewSchema(targets, request).parse(wire));
      return buildCheckedAssessment(draft, validateSupportReview(draft.claims.filter((claim) => targets.claimIds.includes(claim.claimId)), review), validateAssessmentDraft(draft, request, corpus), corpus, validateArtifactReview(draft, review), { ...emptyRequirementReview, request, constraints: review.requestConstraints });
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
      assert.equal(omitted.artifactReviews.find((item) => item.artifactId === "handover")!.reasons[0].target, "disposition");
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
  for (const obligation of work.decision.obligations) {
    obligation.requiresAdaptation = false;
    obligation.adaptationClaimIds = [];
    const coverage = draft.claims.find((claim) => claim.claimId === obligation.claimId)!;
    coverage.dependsOnClaimIds = coverage.dependsOnClaimIds.filter((id) => !adaptationIds.includes(id));
  }
  const verifyRoles = artifactRoles(draft);
  verifyRoles.get("case-1/request")!.role = "context_only";
  const disguisedOffering = buildCheckedAssessment(draft, verdicts, validateAssessmentDraft(draft, currentRequest, corpus), corpus, verifyRoles, emptyRequirementReview);
  assert.equal(disguisedOffering.cases[0].artifactWork[0].disposition, null, "Context-only work cannot regain an offering by relabeling it Verify.");
  assert.ok(!disguisedOffering.claims.some((claim) => work.verificationClaimIds.includes(claim.claimId)));
  assert.deepEqual(disguisedOffering.nextActions, []);
});

test("Verify cannot nominate itself as reusable lead work", () => {
  const corpus = fixture();
  const ids = assessmentPassageIds(corpus);
  const output: AssessmentOutput = {
      missingEvidenceRequests: [],
      requestConstraints: emptyRequirementReview.constraints, claims: [], clarifyingClaimIds: [], contrasts: [],
      leads: [{ caseId: "case-1", state: "conditional", reasonClaimIds: ["reason"], comparisons: [] }],
      cases: corpus.manifest.cases.map((item) => ({
        caseId: item.caseId, outcome: "unknown",
        artifactWork: item.artifacts.map((artifact) => proposal(artifact.artifactId, [ids.get(artifact.versions[0].passages[0].passageId)!], "verify")),
      })),
    }
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
    missingEvidenceReview: emptyRequirementReview.missingEvidenceReview,
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
test("supported history remains visible as counterevidence to an unsupported disposition", () => {
  const corpus = fixture();
  const draft = assessmentDraft(corpus);
  const reviews = artifactRoles(draft);
  const review = reviews.get("case-1/request")!;
  review.verdict = "unsupported";
  review.reasons = [{
    target: "disposition",
    explanation: "The historical record does not establish current-client readiness.",
    sourceRefs: review.decision.historicalEvidence,
    requestQuotes: [],
  }];
  const verdicts = new Map(draft.claims.map((claim) => [claim.claimId, "supported" as SupportVerdict]));
  const checked = buildCheckedAssessment(draft, verdicts, new Set(), corpus, reviews, emptyRequirementReview);
  const work = draft.cases[0].artifactWork[0];
  const historicalClaimId = work.claimIds.find((claimId) => draft.claims.find((claim) => claim.claimId === claimId)?.kind === "source_fact")!;
  const canonicalReview = checked.artifactReviews.find((item) => item.artifactId === "request")!;
  assert.equal(canonicalReview.verdict, "unsupported");
  assert.equal(canonicalReview.claimFindings.find((finding) => finding.claimId === historicalClaimId)!.verdict, "supported");
  assert.ok(checked.claims.some((claim) => claim.claimId === historicalClaimId));
  assert.equal(checked.cases[0].artifactWork[0].disposition, null);
  const selection = [{ caseId: "case-1", artifactId: "request", versionId: "request-v1", passageIds: ["p-request-v1"] }];
  assert.throws(() => validateSelections(selection, checked, corpus));
  const reread = revalidateAssessment(checked, currentRequest, corpus);
  assert.equal(reread.artifactReviews.find((item) => item.artifactId === "request")!.claimFindings
    .find((finding) => finding.claimId === historicalClaimId)!.verdict, "supported");
  assert.throws(() => validateSelections(selection, reread, corpus));
});
test("a supported cap cannot waive a separate nonnumeric item identity and result requirement", () => {
  const corpus = fixture();
  const cap = "Cap each batch at 20 records.";
  const itemResults = "Preserve each item's source identity and record a result for every item.";
  const request = `${cap} ${itemResults}`;
  const constraints = { ...emptyRequirementReview.constraints, scale: [cap], identity_access: [itemResults] };
  const labels = assessmentPassageIds(corpus);
  const output: AssessmentOutput = {
      missingEvidenceRequests: [],
      requestConstraints: constraints,
      claims: [],
      clarifyingClaimIds: [],
      leads: [],
      contrasts: [],
      cases: corpus.manifest.cases.map((pastCase, caseIndex) => ({
        caseId: pastCase.caseId,
        outcome: "unknown",
        artifactWork: pastCase.artifacts.map((artifact, workIndex) => proposal(
          artifact.artifactId,
          [labels.get(artifact.versions[0].passages[0].passageId)!],
          caseIndex === 0 && workIndex === 0 ? "adapt" : null,
          caseIndex === 0 && workIndex === 0 ? [cap, itemResults] : [],
        )),
      })),
    }
  const draft = parseAssessmentDraft(output, corpus);
  const reviews = artifactRoles(draft);
  const review = reviews.get("case-1/request")!;
  review.verdict = "unsupported";
  review.reasons = [{
    target: "request_constraint",
    requirement: itemResults,
    explanation: "The record does not establish identity preservation and a result for each item.",
    sourceRefs: review.decision.historicalEvidence,
    requestQuotes: [itemResults],
  }];
  const checked = buildCheckedAssessment(draft, new Map(draft.claims.map((claim) => [claim.claimId, "supported" as SupportVerdict])), validateAssessmentDraft(draft, request, corpus), corpus, reviews, { ...emptyRequirementReview, request, constraints });
  const work = draft.cases[0].artifactWork[0];
  const canonical = checked.artifactReviews.find((item) => item.artifactId === "request")!;
  const capAdaptationId = work.claimIds.find((claimId) => claimId.endsWith("-adapt-0"))!;
  assert.deepEqual(draft.claims.find((claim) => claim.claimId === capAdaptationId)!.requestQuotes, [cap]);
  assert.equal(canonical.claimFindings.find((finding) => finding.claimId === capAdaptationId)!.verdict, "supported");
  assert.equal(canonical.claimFindings.find((finding) => finding.claimId === work.claimIds.find((id) => id.includes("-obligation-"))!)!.verdict, "supported");
  assert.equal(checked.cases[0].artifactWork[0].disposition, null);
  const selection = [{ caseId: "case-1", artifactId: "request", versionId: "request-v1", passageIds: ["p-request-v1"] }];
  assert.throws(() => validateSelections(selection, checked, corpus));
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
      missingEvidenceRequests: [],
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
    }
  const actionWork = output.cases[0].artifactWork[0];
  const actionCheckIndex = actionWork.checks.findIndex((check) => check.kind === "environment_boundary");
  actionWork.checks[actionCheckIndex].requestQuotes = [environmentRequirement];
  actionWork.obligations[0].checkKind = "environment_boundary";
  actionWork.obligations[0].checkIndexes = [conditionSlot(actionCheckIndex)];
  const draft = parseAssessmentDraft(output, corpus);
  const actionClaimId = draft.cases[0].artifactWork[0].verificationClaimIds[actionCheckIndex];
  draft.claims.find((claim) => claim.claimId === actionClaimId)!.dependsOnClaimIds.push(draft.comparisons[0].assessmentClaimId);
  const invalid = validateAssessmentDraft(draft, request, corpus);
  const verdicts = new Map<string, SupportVerdict>(draft.claims.map((claim) => [claim.claimId, "supported"]));
  const constraints = { ...emptyRequirementReview.constraints, environment: [environmentRequirement] };
  const requirementReview = { ...emptyRequirementReview, request, constraints }
  const build = () => buildCheckedAssessment(draft, verdicts, invalid, corpus, artifactRoles(draft), requirementReview);
  const checked = build();
  assert.deepEqual(checked.comparisons.map(({ relation, artifactId, implicationEffect }) => ({ relation, artifactId, implicationEffect })), [
    { relation: "mismatch", artifactId: "request", implicationEffect: "checked_decision" },
    { relation: "unknown", artifactId: "handover", implicationEffect: "context_only" },
  ]);
  assert.deepEqual(checked.nextActions, [{ caseId: "case-1", artifactId: "request", claimId: actionClaimId }]);
  const contextOnlyRoles = artifactRoles(draft);
  contextOnlyRoles.get("case-1/request")!.role = "context_only";
  const contextOnly = buildCheckedAssessment(draft, verdicts, invalid, corpus, contextOnlyRoles, requirementReview);
  assert.deepEqual(contextOnly.comparisons.map(({ artifactId, implicationEffect }) => ({ artifactId, implicationEffect })), [
    { artifactId: "handover", implicationEffect: "context_only" },
  ]);
  const rejectedVerificationId = actionClaimId;
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
    const checkIndex = work.decision.checks.findIndex((check) => check.kind === "client_api_access");
    const checkId = work.verificationClaimIds[checkIndex]!;
    const check = draft.claims.find((claim) => claim.claimId === checkId)!;
    const operationCheck = work.decision.checks[checkIndex]!;
    check.requestQuotes = [currentRequest];
    operationCheck.requestQuotes = [currentRequest];
    check.text = renderOperationCheck(work.decision.operation!, operationCheck.kind, [currentRequest]);
    operationCheck.text = check.text;
  }
  const checkIds = new Set(draft.cases.flatMap((item) => item.artifactWork.flatMap((work) => work.verificationClaimIds)));
  const build = (verdict: SupportVerdict) => {
    const verdicts = new Map(draft.claims.map((claim) => [claim.claimId, checkIds.has(claim.claimId) ? verdict : "supported" as SupportVerdict]));
    return buildCheckedAssessment(draft, verdicts, new Set(), corpus, syncArtifactFindings(draft, artifactRoles(draft), verdicts), emptyRequirementReview);
  };
  validateAssessmentDraft(draft, currentRequest, corpus);
  const expectedActions = draft.cases.map((item) => {
    const work = item.artifactWork[0];
    const checkIndex = work.decision.checks.findIndex((check) => check.kind === "client_api_access");
    return work.verificationClaimIds[checkIndex]!;
  });
  assert.deepEqual(build("supported").nextActions.map((action) => action.claimId), expectedActions.slice(0, 3));
  assert.deepEqual(build("uncertain").nextActions, []);
});

test("clarification changes compare two checked dispositions, never withheld recommendations", () => {
  const corpus = fixture();
  const draft = assessmentDraft(corpus);
  draft.leads = [{ caseId: "case-1", state: "useful", usefulArtifactIds: ["request"], reasonClaimIds: ["fact-0-0"] }];
  const build = () => buildCheckedAssessment(draft, new Map(draft.claims.map((claim) => [claim.claimId, "supported"])), new Set(), corpus, artifactRoles(draft), emptyRequirementReview);
  const before = structuredClone(build());
  const work = draft.cases[0].artifactWork[0];
  const removed = work.claimIds.filter((claimId) => claimId.includes("-adapt-") || claimId.includes("-check-") || claimId.includes("-obligation-"));
  draft.claims = draft.claims.filter((claim) => !removed.includes(claim.claimId));
  work.claimIds = work.claimIds.filter((claimId) => !removed.includes(claimId));
  work.verificationClaimIds = [];
  work.decision.adaptations = [];
  work.decision.checks = [];
  work.decision.obligations = [];
  work.decision.requestQuotes = [];
  draft.claims.find((claim) => claim.claimId === work.dispositionClaimId)!.requestQuotes = [];
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

test("the independent review rejects aggregate labels and inventories every claim finding", () => {
  const schema = reviewSchema({ claimIds: ["checked-claim"], artifacts: [] }, currentRequest);
  const response = {
    requestConstraints: emptyRequirementReview.constraints,
    missingEvidenceReview: { verdict: "supported", reason: null },
    claimJudgments: { "checked-claim": { verdict: "supported", reason: null } },
    decisions: {},
    conclusion: "precedent_found",
  };
  const validate = new Ajv({ strict: false }).compile(openRouterSchema("assessment_review", schema).json_schema.schema);
  assert.equal(validate(response), false);
  assert.equal(schema.safeParse(response).success, false);
  const { conclusion: _, ...validReview } = response;
  assert.equal(validate(validReview), true);
  assert.deepEqual(schema.parse(validReview), {
    requestConstraints: emptyRequirementReview.constraints,
    missingEvidenceReview: emptyRequirementReview.missingEvidenceReview,
    artifactReviews: [],
    claimReviews: [{ claimId: "checked-claim", verdict: "supported" }],
  });
  assert.equal(validate({ ...validReview, claimJudgments: {} }), false, "The reviewer cannot omit a claim judgment.");
  assert.equal(validate({
    ...validReview,
    claimJudgments: { ...validReview.claimJudgments, "foreign-claim": { verdict: "supported", reason: null } },
  }), false, "Background or foreign IDs cannot enter the review inventory.");
});

test("decision review binds disposition while leaf findings stay claim-local", () => {
  const corpus = fixture();
  const draft = assessmentDraft(corpus);
  const ref = draft.claims[0].sourceRefs[0];
  const work = draft.cases[0].artifactWork[0];
  const history = work.claimIds.filter((id) => id.includes("-history-") || id.endsWith("-operation"));
  const adaptation = work.claimIds.filter((id) => id.includes("-adapt-"));
  const obligation = work.claimIds.filter((id) => id.includes("-obligation-"));
  const categories = { history, adaptation, check: work.verificationClaimIds, obligation };
  const claimIds = Object.values(categories).flat();
  const adaptationId = adaptation[0]!;
  const labels = assessmentPassageIds(corpus);
  const schema = reviewSchema({
    claimIds,
    artifacts: [{ caseId: ref.caseId, artifactId: ref.artifactId, disposition: "adapt", claimIds: categories }],
    sourceRefs: { e1: ref },
  }, currentRequest);
  const response: {
    requestConstraints: RequestConstraints;
    missingEvidenceReview: { verdict: "supported"; reason: null };
    claimJudgments: Record<string, { verdict: SupportVerdict; reason: null | { explanation: string; sourceRefs: string[]; requestQuotes: string[] } }>;
    decisions: Record<string, { disposition: string; role: string; verdict: SupportVerdict; reasons: Record<string, unknown>[] }>;
  } = {
    requestConstraints: emptyRequirementReview.constraints,
    missingEvidenceReview: { verdict: "supported", reason: null },
    claimJudgments: Object.fromEntries(claimIds.map((id) => [id, { verdict: "supported", reason: null }])),
    decisions: { "case-1/request": { disposition: "adapt", role: "starting_point", verdict: "supported", reasons: [] } },
  };
  const negative = structuredClone(response);
  negative.claimJudgments[adaptationId] = {
    verdict: "unsupported",
    reason: {
      explanation: "The requested capability is not established by the cited history.",
      sourceRefs: [labels.get(ref.passageId)!],
      requestQuotes: [requestSpanId(currentRequest, currentRequest)],
    },
  };
  const review = schema.parse(negative);
  if (!("artifactReviews" in review)) throw new Error("Expected assessment review.");
  assert.deepEqual(review.artifactReviews[0].claimFindings.find((finding) => finding.claimId === adaptationId)?.verdict, "unsupported");
  assert.deepEqual(review.artifactReviews[0].reasons[0], {
    target: "adaptation",
    claimId: adaptationId,
    explanation: "The requested capability is not established by the cited history.",
    sourceRefs: [ref],
    requestQuotes: [currentRequest],
  });
  assert.equal(schema.safeParse({
    ...response,
    decisions: { "case-1/request": { ...response.decisions["case-1/request"], disposition: "reuse" } },
  }).success, false);
  assert.equal(schema.safeParse({
    ...response,
    decisions: { "case-1/request": { ...response.decisions["case-1/request"], verdict: "unsupported" } },
  }).success, false, "An independent disposition rejection needs its own evidence-linked reason.");
  const modelLeafReason = structuredClone(response);
  modelLeafReason.decisions["case-1/request"].reasons = [{
    target: "check",
    claimId: work.verificationClaimIds[work.decision.checks.findIndex((check) => check.kind === "client_api_access")]!,
    explanation: "Duplicate claim rejection is not a decision reason.",
    sourceRefs: ["e1"],
    requestQuotes: [],
  }];
  assert.equal(schema.safeParse(modelLeafReason).success, false);
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
        missingEvidenceRequests: [],
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
      }
    const draft = parseAssessmentDraft(output, corpus);
    const constraints = {
      ...emptyRequirementReview.constraints,
      [scenario.dimension]: scenario.reviewQuote ? [request] : [],
    };
    const review = assessmentReviewSchema.parse({
      requestConstraints: constraints,
      missingEvidenceReview: emptyRequirementReview.missingEvidenceReview,
      artifactReviews: rawReviews(draft),
      claimReviews: draft.claims.map((claim) => ({ claimId: claim.claimId, verdict: "supported" })),
    });
    const verdicts = validateSupportReview(draft.claims, review);
    const invalid = validateAssessmentDraft(draft, request, corpus);
    const checked = buildCheckedAssessment(draft, verdicts, invalid, corpus, validateArtifactReview(draft, review), { ...emptyRequirementReview, request, constraints: review.requestConstraints });
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
      assert.throws(() => buildCheckedAssessment(draft, verdicts, invalid, corpus, artifactRoles(draft), { ...emptyRequirementReview, request, constraints: invented }),
        (error: unknown) => error instanceof GateFailure && error.code === "INVALID_REQUEST_CONSTRAINT_REVIEW");
      const { requestConstraints: _, ...oldReview } = review;
      assert.equal(assessmentReviewSchema.safeParse(oldReview).success, false);
      const legacy = { ...checked };
      const invalidLegacy: Partial<AssessmentResult> = legacy;
      delete invalidLegacy.requestConstraints;
      assert.throws(() => revalidateAssessment(legacy, request, corpus), EvidenceUnavailable);
      assert.equal(buildCheckedAssessment(draft, verdicts, invalid, corpus, artifactRoles(draft), { ...emptyRequirementReview, request, constraints }).conclusion, "cannot_be_established");
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
  const checkIndex = work.decision.checks.findIndex((check) => check.kind === "client_api_access");
  const checkId = work.verificationClaimIds[checkIndex]!;
  const check = draft.claims.find((claim) => claim.claimId === checkId)!;
  const operationCheck = work.decision.checks[checkIndex]!;
  check.requestQuotes = [currentRequest];
  operationCheck.requestQuotes = [currentRequest];
  check.text = renderOperationCheck(work.decision.operation!, operationCheck.kind, [currentRequest]);
  operationCheck.text = check.text;
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
    work.decision.obligations = [];
    work.verificationClaimIds = [];
  }
  draft.claims = draft.claims.filter((claim) => !removedClaimIds.has(claim.claimId));
  draft.claims.push({ ...draft.claims[0], claimId: "unrelated-outcome", kind: "source_fact", requestQuotes: [], dependsOnClaimIds: [] });
  draft.cases[0].claimIds.push("unrelated-outcome");
  draft.cases[0].outcomeClaimIds = ["unrelated-outcome"];
  const review = assessmentReviewSchema.parse({
    requestConstraints: emptyRequirementReview.constraints,
    missingEvidenceReview: emptyRequirementReview.missingEvidenceReview,
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
      missingEvidenceRequests: [],
      requestConstraints: emptyRequirementReview.constraints, leads: [], contrasts: [], clarifyingClaimIds: [], claims: [],
      cases: corpus.manifest.cases.map((item) => ({
        caseId: item.caseId, outcome: "unknown",
        artifactWork: item.artifacts.map((artifact) => (proposal(artifact.artifactId, [wireIds.get(artifact.versions[0].passages[0].passageId)!], null, []))),
      })),
    }
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
  const rejectedReviews = syncArtifactFindings(draft, artifactRoles(draft, "context_only"), rejectedExplanations);
  const unexplained = buildCheckedAssessment(draft, rejectedExplanations, new Set(), corpus, rejectedReviews, emptyRequirementReview);
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
    missingEvidenceRequests: [],
    cases: corpus.manifest.cases.map((item) => ({
      caseId: item.caseId, outcome: "unknown",
      artifactWork: item.artifacts.map((artifact) => (proposal(artifact.artifactId, [ids.get(artifact.versions[0].passages[0].passageId)!], null, constraints.recovery_operations))),
    })),
  }, corpus);
  const verdicts = new Map(draft.claims.map((claim) => [claim.claimId, "supported" as SupportVerdict]));
  const roles = artifactRoles(draft, "context_only");
  const build = (reviewed: RequestConstraints) => buildCheckedAssessment(draft, verdicts, validateAssessmentDraft(draft, request, corpus), corpus, roles, { ...emptyRequirementReview, request, constraints: reviewed });
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
  const rejectedRoles = syncArtifactFindings(draft, artifactRoles(draft, "context_only"), verdicts);
  assert.equal(buildCheckedAssessment(draft, verdicts, validateAssessmentDraft(draft, request, corpus), corpus, rejectedRoles, { ...emptyRequirementReview, request, constraints }).conclusion, "cannot_be_established", "Rejected historical evidence withholds the exclusion decision.");
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
      missingEvidenceRequests: [],
      requestConstraints: { ...emptyRequirementReview.constraints },
      leads: [], contrasts: [], clarifyingClaimIds: [],
      cases: corpus.manifest.cases.map((item) => ({
        caseId: item.caseId, outcome: "unknown",
        artifactWork: item.artifacts.map((artifact) => (proposal(artifact.artifactId, [ids.get(artifact.versions[0].passages[0].passageId)!], null, []))),
      })),
      claims: [{ claimId: "source-fact", caseId: "case-1", outcomeEvidence: false, kind: "source_fact", sourceRefs: [ids.get("p-request-v1")!], requestQuotes: [], dependsOnClaimIds: [] }],
    }
  const { leads: _, contrasts: __, ...content } = output;
  const wireOutput = {
    ...content,
    cases: Object.fromEntries(content.cases.map(({ caseId, outcome, artifactWork }) => [caseId, {
      outcome, tier: "context",
      artifactWork: Object.fromEntries(artifactWork.map(({ artifactId, historicalEvidence }) => [artifactId, {
        disposition: null, operation: null, historicalEvidence, obligations: [], checks: {},
      }])),
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
  Object.assign(valid.cases["case-1"].artifactWork.request, {
    disposition: "reuse", operation: "recovery_handover",
    obligations: [{
      adaptation: null,
      requirements: [{ requestQuote: requestSpanId(request, recoveryQuote), requirement: "Named operators", checkKind: null }],
    }],
    checks: {},
  });
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
    () => buildCheckedAssessment(partialDraft, new Map<string, SupportVerdict>(partialDraft.claims.map((claim) => [claim.claimId, "supported"])), new Set(), corpus, artifactRoles(partialDraft), { ...emptyRequirementReview, request: longRequest, constraints: partialConstraints }),
    (error: unknown) => error instanceof GateFailure && error.code === "INVALID_REQUEST_CONSTRAINT_REVIEW",
  );
});

test("brief wire requires exact selected coverage and derives its own facts", async () => {
  const corpus = fixture();
  const draft = assessmentDraft(corpus);
  const checked = buildCheckedAssessment(draft, new Map<string, SupportVerdict>(draft.claims.map((item) => [item.claimId, "supported"])), new Set(), corpus, artifactRoles(draft), emptyRequirementReview);
  const selected = [{ caseId: "case-1", artifactId: "handover", versionId: "handover-v1-case-1", passageIds: ["p-handover-v1-case-1"] }];
  const ids = assessmentPassageIds(corpus);
  const request = `${currentRequest} Preserve the audit trail after cutover.`;
  const spans = requestSpans(request);
  assert.equal(spans.length, 2);
  const prompt = briefDraftPrompt(request, selected, corpus, checked);
  const data = prompt.untrustedData as { historicalContext: { completeSelectedCaseContext: ModelCaseContext[] } };
  const suppliedPassage = data.historicalContext.completeSelectedCaseContext.find((item) => item.caseId === selected[0].caseId)!.artifacts.find((item) => item.artifactId === selected[0].artifactId)!.versions.find((item) => item.versionId === selected[0].versionId)!.passages[0];
  const selectedKey = "case-1/handover/handover-v1-case-1";
  type BriefWireRecommendation = { text: string; sourceRefs: string[] };
  type BriefWireItem = {
    disposition: "adapt";
    recommendation: BriefWireRecommendation;
    requestRecommendations: Record<string, BriefWireRecommendation | null>;
    claims: BriefWireRecommendation[];
  };
  const wireOutput: { items: Record<string, BriefWireItem> } = {
    items: {
      [selectedKey]: {
        disposition: "adapt",
        recommendation: {
          text: "Check compatibility before adapting the selected procedure.",
          sourceRefs: [suppliedPassage.passageId],
        },
        requestRecommendations: Object.fromEntries(spans.map((span) => [span.spanId, {
          text: "Verify the request against this selected procedure.",
          sourceRefs: [suppliedPassage.passageId],
        }])),
        claims: [{ text: "The selected source records the historical workflow.", sourceRefs: [suppliedPassage.passageId] }],
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
    const validate = new Ajv({ strict: false }).compile(providerSchema!);
    assert.equal(validate(wireOutput), true);

    const missingRequired = structuredClone(wireOutput);
    delete missingRequired.items[selectedKey].requestRecommendations[spans[0].spanId];
    const nullRequired = structuredClone(wireOutput);
    nullRequired.items[selectedKey].requestRecommendations[spans[0].spanId] = null;
    const missingOptionalKey = structuredClone(wireOutput);
    delete missingOptionalKey.items[selectedKey].requestRecommendations[spans[1].spanId];
    const wrongRequestKey = structuredClone(wireOutput);
    Object.assign(wrongRequestKey.items[selectedKey].requestRecommendations, { "unknown-span": null });
    const foreignSource = structuredClone(wireOutput);
    foreignSource.items[selectedKey].requestRecommendations[spans[0].spanId]!.sourceRefs = [ids.get("p-request-v1")!];
    const wrongKind = structuredClone(wireOutput);
    Object.assign(wrongKind.items[selectedKey].claims[0], { kind: "recommendation" });
    const oldRequestQuotes = structuredClone(wireOutput);
    Object.assign(oldRequestQuotes.items[selectedKey].requestRecommendations[spans[0].spanId]!, { requestQuotes: [spans[0].spanId] });
    const legacyMembership = structuredClone(wireOutput);
    Object.assign(legacyMembership.items[selectedKey], { dispositionClaimId: "choose", claimIds: ["choose"] });
    const nonselected = structuredClone(wireOutput);
    nonselected.items["case-1/request/request-v1"] = structuredClone(nonselected.items[selectedKey]);
    const missingItem = structuredClone(wireOutput);
    delete missingItem.items[selectedKey];
    for (const invalid of [
      missingRequired, nullRequired, missingOptionalKey, wrongRequestKey, foreignSource,
      wrongKind, oldRequestQuotes, legacyMembership, nonselected, missingItem,
    ]) assert.equal(validate(invalid), false);

    for (const invalid of [missingRequired, nullRequired]) {
      globalThis.fetch = async () => Response.json({
        id: "gen-required-request-recommendation", choices: [{
          finish_reason: "stop", message: { content: JSON.stringify(invalid) },
        }],
      });
      await assert.rejects(
        callModel({ OPENROUTER_API_KEY: "local-test-only" } as Env, "brief_draft", prompt),
        { code: "MODEL_OUTPUT_SCHEMA_INVALID" },
        "Missing checked-assessment recommendations fail during brief draft validation, before independent review.",
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(normalized);
  assert.equal(validateBriefDraft(normalized, request, selected, corpus).size, 0, "Derived selected identities preserve actual claim ownership.");
  assert.equal(normalized.claims[0].kind, "recommendation");
  assert.deepEqual(normalized.claims[0].requestQuotes, []);
  assert.deepEqual(normalized.claims[1].requestQuotes, [spans[0].text]);
  assert.ok(normalized.claims[1].text.includes(spans[0].text));
  assert.deepEqual(normalized.claims[2].requestQuotes, [spans[1].text]);
  assert.ok(normalized.claims[2].text.includes(spans[1].text));
  assert.equal(normalized.claims[3].kind, "interpretation");
  const fact = normalized.claims.find((claim) => claim.kind === "source_fact")!;
  assert.equal(fact.text, corpus.passages.get(selected[0].passageIds[0])!.excerpt);
  assert.deepEqual(fact.dependsOnClaimIds, []);
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
      missingEvidenceRequests: [],
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
    }
  const draft = parseAssessmentDraft(output, corpus);
  const roles = artifactRoles(draft, "context_only");
  const verdicts = new Map<string, SupportVerdict>(draft.claims.map((claim) => [claim.claimId, "supported"]));
  const invalid = validateAssessmentDraft(draft, request, corpus);
  const checked = buildCheckedAssessment(draft, verdicts, invalid, corpus, roles, { ...emptyRequirementReview, request, constraints });
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
  assert.equal(buildCheckedAssessment(draft, verdicts, invalid, corpus, roles, { ...emptyRequirementReview, request, constraints: { ...constraints, recovery_operations: [] } }).conclusion, "cannot_be_established");
  const unresolved = structuredClone(roles);
  unresolved.get("case-1/request")!.role = "unresolved";
  assert.equal(buildCheckedAssessment(draft, verdicts, invalid, corpus, unresolved, { ...emptyRequirementReview, request, constraints }).conclusion, "cannot_be_established");
  const unsupported = new Map(verdicts);
  for (const claimId of unsupported.keys()) {
    if (draft.cases.some((item) => item.artifactWork.some((work) => work.claimIds.includes(claimId) && claimId !== work.dispositionClaimId)) || claimId.startsWith("comparison-0-")) {
      unsupported.set(claimId, "unsupported");
    }
  }
  const unsupportedRoles = syncArtifactFindings(draft, artifactRoles(draft, "context_only"), unsupported);
  assert.equal(buildCheckedAssessment(draft, unsupported, invalid, corpus, unsupportedRoles, { ...emptyRequirementReview, request, constraints }).conclusion, "cannot_be_established");
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
    missingEvidenceRequests: [], missingEvidenceReview: emptyRequirementReview.missingEvidenceReview,
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
    missingEvidenceRequests: [], missingEvidenceReview: emptyRequirementReview.missingEvidenceReview,
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

function excludedOutput(corpus: CorpusSnapshot, constraints: RequestConstraints): AssessmentOutput {
  const labels = assessmentPassageIds(corpus);
  return {
    requestConstraints: constraints, claims: [], clarifyingClaimIds: [], missingEvidenceRequests: [], leads: [], contrasts: [],
    cases: corpus.manifest.cases.map((item) => ({
      caseId: item.caseId, outcome: "unknown",
      artifactWork: item.artifacts.map((artifact) => proposal(artifact.artifactId, [labels.get(artifact.versions[0].passages[0].passageId)!], null)),
    })),
  };
}

test("a combined conditional target binds every exact span without converting the target into history", () => {
  const corpus = fixture();
  const scope = "Map only the 36 active sandbox rows.";
  const timing = "Reconcile accepted and rejected rows within 7 elapsed hours of receipt, with zero production writes.";
  const request = `${scope} ${timing}`;
  const constraints = { ...emptyRequirementReview.constraints, scale: [scope, timing], environment: [scope, timing], recovery_operations: [timing] };
  const output = excludedOutput(corpus, constraints);
  const work = proposal("request", output.cases[0].artifactWork[0].historicalEvidence, "adapt", [scope, timing], "data_mapping");
  work.adaptations = [{
    text: "Map only the 36 active sandbox rows and reconcile accepted and rejected rows within 7 elapsed hours of receipt, with zero production writes; feasibility remains unverified.",
    sourceRefs: work.historicalEvidence, requestQuotes: [scope, timing],
  }];
  work.checks = [
    ...["field_identity", "reconciliation"].map((kind) => ({
      kind: kind as OperationCheckKind, sourceRefs: work.historicalEvidence, requestQuotes: [],
    })),
    ...[scope, timing].map((quote) => ({ kind: "completion_feasibility" as const, sourceRefs: work.historicalEvidence, requestQuotes: [quote] })),
    { kind: "environment_boundary" as const, sourceRefs: work.historicalEvidence, requestQuotes: [] },
  ];
  work.obligations = [scope, timing].map((quote) => ({
    requestQuote: quote, requirement: quote, requiresAdaptation: true, checkKind: "completion_feasibility",
    adaptationIndexes: ["0"], checkIndexes: [conditionSlot(work.checks.findIndex((check) => check.kind === "completion_feasibility" && check.requestQuotes[0] === quote))],
  }));
  output.cases[0].artifactWork[0] = work;
  const build = (value: AssessmentOutput) => {
    const draft = parseAssessmentDraft(value, corpus);
    return buildCheckedAssessment(draft, new Map(draft.claims.map((claim) => [claim.claimId, "supported"])),
      validateAssessmentDraft(draft, request, corpus), corpus, artifactRoles(draft),
      { ...emptyRequirementReview, request, constraints });
  };
  const checked = build(output);
  const selection = [{ caseId: "case-1", artifactId: "request", versionId: "request-v1", passageIds: ["p-request-v1"] }];
  assert.deepEqual(validateSelections(selection, revalidateAssessment(checked, request, corpus), corpus), selection);
  assert.ok(checked.claims.some((claim) => claim.kind === "recommendation" && claim.text.includes(work.adaptations[0].text)));
  assert.ok(checked.claims.filter((claim) => claim.kind === "source_fact").every((claim) => !claim.text.includes("36 active")));
  const wrongBinding = structuredClone(output);
  wrongBinding.cases[0].artifactWork[0].checks.find((check) => check.kind === "completion_feasibility" && check.requestQuotes[0] === scope)!.requestQuotes = [timing];
  assert.equal(build(wrongBinding).cases[0].artifactWork[0].disposition, null);
  const unquotedAdaptation = structuredClone(output);
  unquotedAdaptation.cases[0].artifactWork[0].adaptations[0].requestQuotes = [scope];
  assert.equal(build(unquotedAdaptation).cases[0].artifactWork[0].disposition, null);
});

test("conditional recovery cannot omit checkpoint responsibility even when every declared claim is supported", () => {
  const corpus = fixture();
  const output = excludedOutput(corpus, emptyRequirementReview.constraints);
  const work = proposal("handover", output.cases[0].artifactWork[1].historicalEvidence, "adapt", [currentRequest], "recovery_handover");
  work.checks = Object.keys(OPERATION_CHECKS.recovery_handover).map((kind) => ({
    kind: kind as OperationCheckKind, sourceRefs: work.historicalEvidence, requestQuotes: [currentRequest],
  }));
  output.cases[0].artifactWork[1] = work;
  const build = () => {
    const draft = parseAssessmentDraft(output, corpus);
    return buildCheckedAssessment(draft, new Map(draft.claims.map((claim) => [claim.claimId, "supported"])),
      validateAssessmentDraft(draft, currentRequest, corpus), corpus, artifactRoles(draft), emptyRequirementReview);
  };
  assert.equal(build().cases[0].artifactWork[1].disposition, "adapt");
  work.checks = work.checks.filter((check) => check.kind !== "checkpoint_replay");
  assert.equal(build().cases[0].artifactWork[1].disposition, null);
});

test("checked missing-evidence requests survive all-context exclusions and fail closed on incomplete or unsupported answers", () => {
  const corpus = fixture();
  const request = "Require offline card revocation and a witnessed no-loss drill within 9 minutes. List the missing evidence.";
  const quote = requestSpans(request)[0].text;
  const constraints = { ...emptyRequirementReview.constraints, identity_access: [quote], recovery_operations: [quote] };
  const output = excludedOutput(corpus, constraints);
  output.missingEvidenceRequests = [{
    caseId: "case-1", artifactId: "handover",
    text: "Provide the local card trust and revocation policy, named owner and backup acceptance, and witnessed production-like no-loss drill evidence at the requested bound; none is established here.",
    sourceRefs: output.cases[0].artifactWork[1].historicalEvidence, requestQuotes: [quote],
  }];
  const build = (answerVerdict: SupportVerdict = "supported", requestVerdict: SupportVerdict = "supported", reviewConstraints = constraints) => {
    const draft = parseAssessmentDraft(output, corpus);
    const ids = new Set(draft.missingEvidenceRequests.map((item) => item.claimId));
    const verdicts = new Map(draft.claims.map((claim) => [claim.claimId, ids.has(claim.claimId) ? requestVerdict : "supported" as SupportVerdict]));
    return buildCheckedAssessment(draft, verdicts, validateAssessmentDraft(draft, request, corpus), corpus, artifactRoles(draft, "context_only"), {
      request, constraints: reviewConstraints, missingEvidenceReview: answerVerdict === "supported" ? { verdict: "supported", reason: null, claimIds: [...ids] } : {
        verdict: answerVerdict, claimIds: [...ids], reason: { explanation: "Required evidence requests remain incomplete.", sourceRefs: draft.claims[0].sourceRefs, requestQuotes: [quote] },
      },
    });
  };
  const checked = build();
  assert.equal(checked.conclusion, "no_useful_precedent");
  assert.equal(checked.missingEvidenceRequests.length, 1);
  assert.equal(checked.claims.find((claim) => claim.claimId === checked.missingEvidenceRequests[0].claimId)?.kind, "interpretation");
  assert.deepEqual(checked.nextActions, []);
  assert.ok(checked.cases.every((item) => item.artifactWork.every((work) => work.disposition === null)));
  assert.deepEqual(revalidateAssessment(checked, request, corpus).missingEvidenceRequests, checked.missingEvidenceRequests);
  assert.equal(build("unsupported").conclusion, "cannot_be_established");
  assert.equal(build("supported", "uncertain").conclusion, "cannot_be_established");
  assert.deepEqual(build("supported", "uncertain").missingEvidenceRequests, []);
  assert.equal(revalidateAssessment(build("supported", "uncertain"), request, corpus).conclusion, "cannot_be_established");
  assert.equal(build("supported", "supported", { ...constraints, recovery_operations: [] }).conclusion, "cannot_be_established");
  const foreign = structuredClone(output);
  foreign.missingEvidenceRequests[0].artifactId = "request";
  assert.throws(() => parseAssessmentDraft(foreign, corpus), /evidence|scope|artifact/i);
  output.missingEvidenceRequests = [];
  assert.equal(build("unsupported").conclusion, "cannot_be_established", "Empty all-context drafting does not establish a complete requested gap answer.");
});

test("a checked gap request survives persisted reread when its independent artifact exclusion is unsettled", () => {
  const corpus = fixture();
  const output = excludedOutput(corpus, emptyRequirementReview.constraints);
  output.missingEvidenceRequests = [{
    caseId: "case-1", artifactId: "handover", text: "Provide witnessed current-client acceptance evidence before deciding applicability.",
    sourceRefs: output.cases[0].artifactWork[1].historicalEvidence, requestQuotes: [currentRequest],
  }];
  const draft = parseAssessmentDraft(output, corpus);
  const reviews = artifactRoles(draft, "context_only");
  const review = reviews.get("case-1/handover")!;
  review.verdict = "uncertain";
  review.reasons = [{
    target: "disposition", explanation: "The available historical procedure does not settle applicability.",
    sourceRefs: review.decision.historicalEvidence, requestQuotes: [currentRequest],
  }];
  const checked = buildCheckedAssessment(draft, new Map(draft.claims.map((claim) => [claim.claimId, "supported"])),
    validateAssessmentDraft(draft, currentRequest, corpus), corpus, reviews, {
      ...emptyRequirementReview,
      missingEvidenceReview: { verdict: "supported", reason: null, claimIds: draft.missingEvidenceRequests.map((item) => item.claimId) },
    });
  assert.equal(checked.cases[0].artifactWork[1].dispositionClaimId, null);
  assert.equal(checked.missingEvidenceRequests.length, 1);
  const reread = revalidateAssessment(checked, currentRequest, corpus);
  assert.deepEqual(reread.missingEvidenceRequests, checked.missingEvidenceRequests);
  assert.equal(reread.claims.find((claim) => claim.claimId === checked.missingEvidenceRequests[0].claimId)?.text,
    checked.claims.find((claim) => claim.claimId === checked.missingEvidenceRequests[0].claimId)?.text);
  assert.equal(reread.conclusion, "cannot_be_established");
});
