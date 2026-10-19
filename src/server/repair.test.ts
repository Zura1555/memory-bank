import assert from "node:assert/strict";
import test from "node:test";
import type { ArtifactReview, AssessmentResult, BriefResult, Claim, ClaimFinding, Selection } from "../shared/protocol.ts";
import { REQUIRED_OPERATION_CHECKS, renderOperationCheck, type OperationCheckKind } from "../shared/operations.ts";
import type { CorpusSnapshot } from "./corpus.ts";
import { briefSupportReviewSchema, obligationClaimText, type AssessmentDraft, type AssessmentReview, type BriefDraft, type BriefSupportReview } from "./schemas.ts";
import { buildCheckedBrief, validateBriefDraft, validateSupportReview } from "./gates.ts";
import { requestSpans } from "./request-constraints.ts";
import { assertRepairAccepted, assertRepairScope, assessmentRepairPlan, briefRepairPlan, schemaRepairPlan, type RepairPlan } from "./repair.ts";

const emptyConstraints = { product_version: [], environment: [], scale: [], identity_access: [], recovery_operations: [] };
const request = "Set the timeout to 5 minutes.";
interface AssessmentFixture {
  draft: AssessmentDraft;
  review: AssessmentReview;
  checked: AssessmentResult;
  corpus: CorpusSnapshot;
  caseId: string;
  artifactId: string;
  versionId: string;
  factId: string;
  decisionId: string;
}

function assessmentFixture(options: {
  proposal?: "supported" | "unsupported" | "uncertain";
  fact?: "supported" | "unsupported" | "uncertain";
  operation?: "supported" | "unsupported" | "uncertain";
  check?: "supported" | "unsupported" | "uncertain";
  role?: "starting_point" | "context_only";
  verdict?: "supported" | "unsupported" | "uncertain";
  disposition?: "adapt" | null;
  available?: boolean;
  unrelatedNegative?: boolean;
  missingObligation?: boolean;
  caseId?: string;
  artifactId?: string;
  versionId?: string;
} = {}): AssessmentFixture {
  const caseId = options.caseId ?? "case-a";
  const artifactId = options.artifactId ?? "api";
  const versionId = options.versionId ?? "v1";
  const ref = { caseId, artifactId, versionId, passageId: `passage-${caseId}` };
  const factId = `fact-${caseId}`;
  const operationId = `operation-${caseId}`;
  const decisionId = `decision-${caseId}`;
  const adaptationId = `adaptation-${caseId}`;
  const obligationId = `obligation-${caseId}`;
  const checkPrefix = `check-${caseId}-`;
  const unrelatedId = `unrelated-${caseId}`;
  const proposalVerdict = options.proposal ?? "unsupported";
  const factVerdict = options.fact ?? "supported";
  const operationVerdict = options.operation ?? "supported";
  const role = options.role ?? "starting_point";
  const disposition = options.disposition === undefined ? "adapt" : options.disposition;
  const sourceFact: Claim = {
    claimId: factId, kind: "source_fact", text: "Recorded API procedure.", sourceRefs: [ref], requestQuotes: [], dependsOnClaimIds: [],
  };
  const operationClaim: Claim = {
    claimId: operationId, kind: "interpretation", text: "The historical operation documented by this artifact is api adapter.",
    sourceRefs: [ref], requestQuotes: [], dependsOnClaimIds: [factId],
  };
  const dispositionClaim: Claim = {
    claimId: decisionId, kind: "recommendation", text: "Conditional Adapt starting material.", sourceRefs: [ref],
    requestQuotes: [request], dependsOnClaimIds: [factId, operationId],
  };
  const adaptation = { text: "Set the adapter timeout to the requested duration.", sourceRefs: [ref], requestQuotes: [request] };
  const checks = REQUIRED_OPERATION_CHECKS.api_adapter.map((kind) => ({
    kind: kind as OperationCheckKind, text: renderOperationCheck("api_adapter", kind, []), sourceRefs: [ref], requestQuotes: [],
  }));
  const checkClaims = checks.map((check, index): Claim => ({
    claimId: `${checkPrefix}${index}`, kind: "recommendation", text: check.text, sourceRefs: [ref], requestQuotes: [],
    dependsOnClaimIds: [decisionId, factId],
  }));
  const obligation = {
    claimId: obligationId, requestQuote: request, requirement: "5 minutes", requiresAdaptation: true,
    checkKind: null, adaptationClaimIds: [adaptationId], checkClaimIds: [],
  };
  const obligationClaim: Claim = {
    claimId: obligation.claimId, kind: "interpretation", text: obligationClaimText(obligation.requirement), sourceRefs: [ref],
    requestQuotes: [request], dependsOnClaimIds: [decisionId, adaptationId],
  };
  const adaptationClaim: Claim = {
    claimId: adaptationId, kind: "recommendation", text: adaptation.text, sourceRefs: [ref], requestQuotes: [request],
    dependsOnClaimIds: [decisionId, factId],
  };
  const unrelated: Claim = {
    claimId: unrelatedId, kind: "interpretation", text: "Unrelated note.", sourceRefs: [ref], requestQuotes: [], dependsOnClaimIds: [],
  };
  const claims = [sourceFact, operationClaim, dispositionClaim, adaptationClaim, ...checkClaims,
    ...(options.missingObligation ? [] : [obligationClaim]), ...(options.unrelatedNegative ? [unrelated] : [])];
  const work = {
    artifactId, disposition, operation: disposition ? "api_adapter" as const : null,
    historicalEvidence: [ref], requestQuotes: [request], adaptations: disposition ? [adaptation] : [],
    checks: disposition ? checks : [], obligations: disposition && !options.missingObligation ? [obligation] : [],
    dispositionClaimId: decisionId, claimIds: [factId, operationId, decisionId, adaptationId, ...checkClaims.map((claim) => claim.claimId), ...(options.missingObligation ? [] : [obligationId])],
    blockerClaimIds: [], verificationClaimIds: checkClaims.map((claim) => claim.claimId),
  };
  const decision = {
    disposition: work.disposition, operation: work.operation, historicalEvidence: work.historicalEvidence,
    requestQuotes: work.requestQuotes, adaptations: work.adaptations, checks: work.checks, obligations: work.obligations,
  };
  const draft = {
    requestConstraints: emptyConstraints,
    cases: [{ caseId, outcome: "unknown", claimIds: [], outcomeClaimIds: [], artifactWork: [{ ...work, decision }] }],
    leads: [], contrasts: [], comparisons: [], clarifyingClaimIds: [], missingEvidenceRequests: [], claims,
  } as unknown as AssessmentDraft;
  const checkVerdict = options.check ?? "supported";
  const status = new Map<string, "supported" | "unsupported" | "uncertain">([
    [factId, factVerdict], [operationId, operationVerdict], [adaptationId, proposalVerdict], [obligationId, "supported"],
    ...checkClaims.map((claim, index) => [claim.claimId, index === 0 ? checkVerdict : "supported"] as [string, "supported" | "unsupported" | "uncertain"]),
    ...(options.unrelatedNegative ? [[unrelatedId, "unsupported"] as [string, "unsupported"]] : []),
  ]);
  const claimFindings = draft.cases[0].artifactWork[0].claimIds.filter((id) => id !== decisionId).map<ClaimFinding>((claimId) => {
    const verdict = status.get(claimId)!;
    if (verdict === "supported") return { claimId, verdict, reason: null };
    return { claimId, verdict, reason: {
      explanation: `Independent ${verdict} finding.`, sourceRefs: [ref],
      requestQuotes: claimId === factId || claimId === operationId ? [] : [request],
    } };
  });
  const claimReasons = claimFindings.flatMap((finding) => finding.reason === null ? [] : [{
    ...finding.reason,
    target: finding.claimId === adaptationId ? "adaptation" as const
      : finding.claimId.startsWith(checkPrefix) ? "check" as const
        : finding.claimId === obligationId ? "request_constraint" as const : "history" as const,
    claimId: finding.claimId,
  }] as const);
  const missingReason = options.missingObligation ? [{
    target: "request_constraint" as const, explanation: "An explicit requested duration has no operation obligation.",
    sourceRefs: [ref], requestQuotes: [request], requirement: "5 minutes",
  }] : [];
  const reasons = [...claimReasons, ...missingReason];
  const reviewVerdict = options.verdict ?? (reasons.length > 0 ? "unsupported" : "supported");
  const artifactReview = {
    caseId, artifactId, disposition,
    role, verdict: reviewVerdict, reasons, claimFindings,
  };
  const review = {
    requestConstraints: emptyConstraints,
    missingEvidenceReview: { verdict: "supported", reason: null, claimIds: [] },
    artifactReviews: [artifactReview],
    claimReviews: claims.filter((claim) => claim.claimId !== decisionId).map((claim) => ({ claimId: claim.claimId, verdict: status.get(claim.claimId)! })),
  } as unknown as AssessmentReview;
  const accepted = new Set<string>([...status].filter(([, verdict]) => verdict === "supported").map(([id]) => id));
  if (reviewVerdict === "supported" && role === "starting_point"
    && work.claimIds.filter((id) => id !== work.dispositionClaimId).every((id) => status.get(id) === "supported")) accepted.add(decisionId);
  else accepted.delete(decisionId);
  let changed = true;
  while (changed) {
    changed = false;
    for (const claim of claims) if (accepted.has(claim.claimId) && claim.dependsOnClaimIds.some((id) => !accepted.has(id))) {
      accepted.delete(claim.claimId);
      changed = true;
    }
  }
  const checkedArtifactReview: ArtifactReview = {
    caseId, artifactId,
    decision: decision as ArtifactReview["decision"],
    role, verdict: reviewVerdict, reasons: [...reasons], claimFindings,
  };
  const checked = {
    conclusion: "cannot_be_established", clarifyingClaimIds: [], missingEvidenceRequests: [],
    missingEvidenceReview: review.missingEvidenceReview, comparisons: [], requestConstraints: emptyConstraints,
    artifactReviews: [checkedArtifactReview], nextActions: [],
    cases: [{ caseId, availability: "available", outcome: "unknown", outcomeClaimIds: [], claimIds: [], artifactWork: [{
      artifactId, availability: "available", exclusionReasons: [],
      disposition: accepted.has(decisionId) && work.disposition !== null ? work.disposition : null,
      dispositionClaimId: accepted.has(decisionId) ? decisionId : null,
      claimIds: [...accepted].filter((id) => work.claimIds.includes(id)), blockerClaimIds: [], verificationClaimIds: [],
    }] }],
    leads: [], contrasts: [], claims: claims.filter((claim) => accepted.has(claim.claimId)), withheldClaimCount: claims.length - accepted.size,
  } as unknown as AssessmentResult;
  const corpus = {
    manifest: { cases: [{ caseId, records: [], artifacts: [{ artifactId, versions: [{ versionId, extractionStatus: "complete" }] }] }] },
    availableVersions: new Set(options.available === false ? [] : [versionId]),
    passages: new Map([[ref.passageId, { ...ref, excerpt: sourceFact.text }]]),
  } as unknown as CorpusSnapshot;
  return { draft, review, checked, corpus, caseId, artifactId, versionId, factId, decisionId };
}
function combineAssessmentFixtures(fixtures: AssessmentFixture[]): AssessmentFixture {
  const [first, ...rest] = fixtures;
  for (const fixture of rest) {
    first.draft.cases.push(...fixture.draft.cases);
    first.draft.claims.push(...fixture.draft.claims);
    first.review.artifactReviews.push(...fixture.review.artifactReviews);
    first.review.claimReviews.push(...fixture.review.claimReviews);
    first.checked.cases.push(...fixture.checked.cases);
    first.checked.artifactReviews.push(...fixture.checked.artifactReviews);
    first.checked.claims.push(...fixture.checked.claims);
    first.checked.withheldClaimCount += fixture.checked.withheldClaimCount;
    first.corpus.manifest.cases.push(...fixture.corpus.manifest.cases);
    for (const versionId of fixture.corpus.availableVersions) first.corpus.availableVersions.add(versionId);
    for (const [passageId, passage] of fixture.corpus.passages) first.corpus.passages.set(passageId, passage);
  }
  return first;
}

 

test("assessment repairs actionable work only with supported operation evidence", () => {
  const positive = assessmentFixture({ unrelatedNegative: true });
  const plan = assessmentRepairPlan(request, positive.corpus, positive.draft, positive.review, positive.checked);
  assert.deepEqual(plan?.editablePaths, [["cases", "case-a", "artifactWork", "api"]]);

  const fresh = assessmentFixture({ proposal: "supported", verdict: "supported", unrelatedNegative: true });
  assertRepairAccepted(request, plan!, fresh.draft, fresh.review, fresh.checked);
  const rejectedTarget = assessmentFixture({ proposal: "supported", verdict: "supported" });
  rejectedTarget.checked.cases[0].artifactWork[0].disposition = null;
  assert.throws(() => assertRepairAccepted(request, plan!, rejectedTarget.draft, rejectedTarget.review, rejectedTarget.checked), { code: "REPAIR_NOT_ACCEPTED" });

  const rejectedCheck = assessmentFixture({ proposal: "supported", check: "unsupported" });
  assert.ok(assessmentRepairPlan(request, rejectedCheck.corpus, rejectedCheck.draft, rejectedCheck.review, rejectedCheck.checked)?.defects.some((defect) => defect.code === "unsupported_check"));
  const missingObligation = assessmentFixture({ proposal: "supported", missingObligation: true });
  const obligationPlan = assessmentRepairPlan(request, missingObligation.corpus, missingObligation.draft, missingObligation.review, missingObligation.checked);
  assert.equal(obligationPlan?.defects[0].code, "missing_operation_obligation");
  assert.doesNotThrow(() => assertRepairAccepted(request, obligationPlan!, fresh.draft, fresh.review, fresh.checked));

  const boundedNegative = assessmentFixture({ disposition: null, verdict: "supported", proposal: "supported" });
  assert.equal(assessmentRepairPlan(request, boundedNegative.corpus, boundedNegative.draft, boundedNegative.review, boundedNegative.checked), null);
  for (const ineligible of [
    assessmentFixture({ fact: "unsupported" }),
    assessmentFixture({ fact: "uncertain" }),
    assessmentFixture({ operation: "unsupported" }),
    assessmentFixture({ operation: "uncertain" }),
    assessmentFixture({ proposal: "uncertain" }),
    assessmentFixture({ role: "context_only", verdict: "supported", proposal: "supported" }),
    assessmentFixture({ available: false }),
  ]) assert.equal(assessmentRepairPlan(request, ineligible.corpus, ineligible.draft, ineligible.review, ineligible.checked), null);
  const malformedReview = assessmentFixture();
  malformedReview.review.claimReviews.pop();
  assert.equal(assessmentRepairPlan(request, malformedReview.corpus, malformedReview.draft,
    malformedReview.review, malformedReview.checked), null);

  const unrelatedRejectedHistory = combineAssessmentFixtures([
    assessmentFixture(),
    assessmentFixture({ caseId: "case-b", versionId: "v2", fact: "unsupported" }),
  ]);
  assert.deepEqual(assessmentRepairPlan(request, unrelatedRejectedHistory.corpus, unrelatedRejectedHistory.draft,
    unrelatedRejectedHistory.review, unrelatedRejectedHistory.checked)?.editablePaths,
  [["cases", "case-a", "artifactWork", "api"]]);

  const mismatched = assessmentFixture({ proposal: "supported", verdict: "supported" });
  mismatched.draft.leads = [{ caseId: mismatched.caseId, state: "conditional", usefulArtifactIds: [mismatched.artifactId], reasonClaimIds: [mismatched.factId] }];
  mismatched.checked.leads = mismatched.draft.leads;
  const reviewedConstraints = { ...emptyConstraints, environment: [request] };
  mismatched.review.requestConstraints = reviewedConstraints;
  mismatched.checked.requestConstraints = reviewedConstraints;
  assert.deepEqual(assessmentRepairPlan(request, mismatched.corpus, mismatched.draft, mismatched.review, mismatched.checked)?.editablePaths,
    [["requestConstraints", "environment"]]);
});

test("a missing lead can edit only tier, state, reasons, and comparisons", () => {
  const fixture = assessmentFixture({ proposal: "supported", verdict: "supported" });
  const plan = assessmentRepairPlan(request, fixture.corpus, fixture.draft, fixture.review, fixture.checked);
  assert.deepEqual(plan?.editablePaths, [
    ["cases", "case-a", "tier"], ["cases", "case-a", "state"],
    ["cases", "case-a", "reasons"], ["cases", "case-a", "comparisons"],
  ]);
});

test("an existing checked lead prevents unnecessary promotion of an additional useful contrast", () => {
  const leadFixture = assessmentFixture({ proposal: "supported", verdict: "supported" });
  const contrastFixture = assessmentFixture({ caseId: "case-b", versionId: "v2", proposal: "supported", verdict: "supported" });
  const fixture = combineAssessmentFixtures([leadFixture, contrastFixture]);
  const lead = { caseId: leadFixture.caseId, state: "useful" as const, usefulArtifactIds: [leadFixture.artifactId], reasonClaimIds: [leadFixture.factId], comparisons: [] };
  const contrast = { caseId: contrastFixture.caseId, state: "partial" as const, usefulArtifactIds: [contrastFixture.artifactId], reasonClaimIds: [contrastFixture.factId], comparisons: [] };
  fixture.draft.leads = [lead];
  fixture.checked.leads = [lead];
  fixture.draft.contrasts = [contrast];
  fixture.checked.contrasts = [contrast];
  assert.equal(assessmentRepairPlan(request, fixture.corpus, fixture.draft, fixture.review, fixture.checked), null);
});

test("zero checked leads promotes at most one useful case even when four are available", () => {
  const fixture = combineAssessmentFixtures(["case-a", "case-b", "case-c", "case-d"].map((caseId, index) =>
    assessmentFixture({ caseId, versionId: `v${index + 1}`, proposal: "supported", verdict: "supported" })));
  const plan = assessmentRepairPlan(request, fixture.corpus, fixture.draft, fixture.review, fixture.checked);
  assert.equal(plan?.editablePaths.length, 4);
  assert.equal(new Set(plan?.editablePaths.map((path) => path[1])).size, 1);
  assert.ok(plan?.editablePaths.every((path) => path[0] === "cases"
    && ["tier", "state", "reasons", "comparisons"].includes(String(path[2]))));
});

function briefFixture(options: { twoItems?: boolean; optionalUnsupported?: boolean; factUnsupported?: boolean } = {}) {
  const quote = requestSpans(request)[0].text;
  const selected: Selection[] = [{ caseId: "case-a", artifactId: "api", versionId: "v1", passageIds: ["passage-a"] }];
  if (options.twoItems) selected.push({ caseId: "case-b", artifactId: "api", versionId: "v2", passageIds: ["passage-b"] });
  const refs = selected.map((item) => ({ caseId: item.caseId, artifactId: item.artifactId, versionId: item.versionId, passageId: item.passageIds[0] }));
  const passageText = new Map(refs.map((source, index) => [source.passageId, `Recorded procedure ${index + 1}.`]));
  const assessment = {
    cases: selected.map((item) => ({ caseId: item.caseId, artifactWork: [{
      artifactId: item.artifactId, availability: "available", exclusionReasons: [], disposition: "adapt",
      dispositionClaimId: `work-${item.caseId}`, claimIds: [`work-${item.caseId}`], blockerClaimIds: [], verificationClaimIds: [],
    }] })),
    artifactReviews: selected.map((item, index) => ({
      caseId: item.caseId, artifactId: item.artifactId, role: "starting_point", verdict: "supported",
      decision: { disposition: "adapt", operation: "api_adapter", historicalEvidence: [refs[index]], requestQuotes: [], adaptations: [], checks: [], obligations: [] },
    })),
    claims: [],
  } as unknown as AssessmentResult;
  const corpus = {
    manifest: { cases: selected.map((item) => ({ caseId: item.caseId, records: [], artifacts: [{ artifactId: item.artifactId, versions: [{ versionId: item.versionId, extractionStatus: "complete" }] }] })) },
    availableVersions: new Set(selected.map((item) => item.versionId)),
    versions: new Map(selected.map((item) => [item.versionId, { version: { extractionStatus: "complete" } }])),
    passages: new Map(refs.map((source) => [source.passageId, { ...source, excerpt: passageText.get(source.passageId)! }])),
  } as unknown as CorpusSnapshot;
  const claims: Claim[] = [];
  const items = selected.map((item, index) => {
    const factId = `fact-${item.caseId}`;
    const baseId = `base-${item.caseId}`;
    const carrierId = `carrier-${item.caseId}`;
    claims.push({ claimId: factId, kind: "source_fact", text: passageText.get(refs[index].passageId)!, sourceRefs: [refs[index]], requestQuotes: [], dependsOnClaimIds: [] });
    claims.push({ claimId: baseId, kind: "recommendation", text: "Use this checked starting material.", sourceRefs: [refs[index]], requestQuotes: [], dependsOnClaimIds: [factId] });
    const claimIds = [factId, baseId];
    if (!options.twoItems || index === 0) {
      claims.push({ claimId: carrierId, kind: "recommendation", text: `${quote} Verify the requested timing before use.`, sourceRefs: [refs[index]], requestQuotes: [quote], dependsOnClaimIds: [baseId, factId] });
      claimIds.push(carrierId);
    }
    if (options.optionalUnsupported && index === 0) {
      claims.push({ claimId: "optional-note", kind: "interpretation", text: "An optional interpretation.", sourceRefs: [refs[index]], requestQuotes: [], dependsOnClaimIds: [factId] });
      claimIds.push("optional-note");
    }
    return { caseId: item.caseId, artifactId: item.artifactId, versionId: item.versionId, disposition: "adapt" as const, dispositionClaimId: baseId, claimIds };
  });
  const draft: BriefDraft = {
    reuse: [], adapt: items, verify: [], claims,
  };
  const constraintReviews = selected.map((item) => ({ caseId: item.caseId, artifactId: item.artifactId, versionId: item.versionId, requestQuotes: [quote] }));
  const review: BriefSupportReview = {
    claimReviews: claims.map((claim) => ({ claimId: claim.claimId, verdict: claim.claimId === "optional-note" || (options.factUnsupported && claim.kind === "source_fact")
      ? "unsupported" : "supported" })),
    constraintReviews,
  };
  briefSupportReviewSchema.parse(review);
  const invalid = validateBriefDraft(draft, request, selected, corpus);
  const checked = buildCheckedBrief(draft, validateSupportReview(claims, review), invalid, { request, constraintReviews, assessment });
  return { request, selected, draft, review, checked, assessment, corpus, quote };
}

test("brief request coverage is repaired per selected item and ignores optional unsupported interpretations", () => {
  const fixture = briefFixture({ twoItems: true });
  const plan = briefRepairPlan(fixture.request, fixture.corpus, fixture.assessment, fixture.selected,
    fixture.draft, fixture.review, fixture.checked);
  const spanId = requestSpans(request)[0].spanId;
  assert.deepEqual(plan?.editablePaths, [["items", "case-b/api/v2", "requestRecommendations", spanId]]);

  const optional = briefFixture({ optionalUnsupported: true });
  assert.equal(briefRepairPlan(optional.request, optional.corpus, optional.assessment, optional.selected,
    optional.draft, optional.review, optional.checked), null);
  const rejectedFact = briefFixture({ factUnsupported: true });
  assert.equal(briefRepairPlan(rejectedFact.request, rejectedFact.corpus, rejectedFact.assessment, rejectedFact.selected,
    rejectedFact.draft, rejectedFact.review, rejectedFact.checked), null);

  const repaired = briefFixture({ twoItems: true });
  const targetClaim: Claim = {
    claimId: "carrier-case-b", kind: "recommendation", text: `${fixture.quote} Confirm the exact duration before use.`,
    sourceRefs: [repaired.draft.claims.find((claim) => claim.claimId === "fact-case-b")!.sourceRefs[0]],
    requestQuotes: [fixture.quote], dependsOnClaimIds: ["base-case-b", "fact-case-b"],
  };
  repaired.draft.claims.push(targetClaim);
  repaired.draft.adapt[1].claimIds.push(targetClaim.claimId);
  repaired.review.claimReviews.push({ claimId: targetClaim.claimId, verdict: "supported" });
  repaired.checked = buildCheckedBrief(repaired.draft, validateSupportReview(repaired.draft.claims, repaired.review),
    validateBriefDraft(repaired.draft, repaired.request, repaired.selected, repaired.corpus), {
      request: repaired.request, constraintReviews: repaired.review.constraintReviews, assessment: repaired.assessment,
    }) as BriefResult;
  assertRepairAccepted(fixture.request, plan!, repaired.draft, repaired.review, repaired.checked);
});

test("scope compares JSON semantics and confines array or key changes to exact editable paths", () => {
  const plan: RepairPlan = {
    editablePaths: [["items", "case-a/api/v1", "requestRecommendations", "span-1"]],
    defects: [{ code: "missing_request_recommendation", path: ["items", "case-a/api/v1", "requestRecommendations", "span-1"], message: "Missing carrier." }],
  };
  const original = {
    items: { "case-a/api/v1": { requestRecommendations: { "span-1": { text: "old", refs: ["p1"] } }, untouched: ["same"] } },
  };
  const reordered = {
    items: { "case-a/api/v1": { untouched: ["same"], requestRecommendations: { "span-1": { refs: ["p1", "p2"], text: "new" } } } },
  };
  assert.doesNotThrow(() => assertRepairScope(original, reordered, plan));
  const keyOrderOnly = {
    items: { "case-a/api/v1": { untouched: ["same"], requestRecommendations: { "span-1": { refs: ["p1"], text: "old" } } } },
  };
  assert.throws(() => assertRepairScope(original, keyOrderOnly, plan), { code: "REPAIR_SCOPE_VIOLATION" });
  assert.throws(() => assertRepairScope(original, {
    items: { "case-a/api/v1": { untouched: ["same"], requestRecommendations: { "span-1": { refs: ["p1"], text: "old" } } } },
  }, plan), { code: "REPAIR_SCOPE_VIOLATION" });
  assert.throws(() => assertRepairScope(original, {
    ...reordered, items: { ...reordered.items, "case-a/api/v1": { ...reordered.items["case-a/api/v1"], extra: true } },
  }, plan), { code: "REPAIR_SCOPE_VIOLATION" });
  assert.throws(() => assertRepairScope(original, {
    ...reordered, items: { ...reordered.items, "case-a/api/v1": { ...reordered.items["case-a/api/v1"], untouched: ["same", "extra"] } },
  }, plan), { code: "REPAIR_SCOPE_VIOLATION" });
  assert.throws(() => assertRepairScope(original, {
    ...reordered, items: { ...reordered.items, "case-a/api/v1": { ...reordered.items["case-a/api/v1"], untouched: [] } },
  }, plan), { code: "REPAIR_SCOPE_VIOLATION" });
  assert.throws(() => assertRepairScope(original, {
    ...reordered, items: { ...reordered.items, "case-a/api/v1": { ...reordered.items["case-a/api/v1"], requestRecommendations: { ...reordered.items["case-a/api/v1"].requestRecommendations, "span-2": { text: "new key" } } } },
  }, plan), { code: "REPAIR_SCOPE_VIOLATION" });
});

test("assessment work repair preserves its original operation evidence and request quotations", () => {
  const path = ["cases", "case-a", "artifactWork", "api"];
  const work = {
    disposition: "adapt", operation: "api_adapter", historicalEvidence: ["passage-1"],
    obligations: [{
      adaptation: { text: "Original adaptation.", sourceRefs: ["passage-1"] },
      requirements: [{ requestQuote: "Set the timeout.", requirement: "timeout", checkKind: null }],
    }],
    checks: { client_operation_limits: ["passage-1"] },
  };
  const original = { cases: { "case-a": { artifactWork: { api: work } } } };
  const repaired = structuredClone(original);
  repaired.cases["case-a"].artifactWork.api.obligations[0].adaptation.text = "Repaired adaptation.";
  const proposalPlan: RepairPlan = {
    editablePaths: [path],
    defects: [{ code: "unsupported_adaptation", path, message: "The adaptation was rejected." }],
  };
  assert.doesNotThrow(() => assertRepairScope(original, repaired, proposalPlan));

  const rebound = structuredClone(repaired);
  rebound.cases["case-a"].artifactWork.api.obligations[0].adaptation.sourceRefs = ["passage-2"];
  assert.throws(() => assertRepairScope(original, rebound, proposalPlan), { code: "REPAIR_SCOPE_VIOLATION" });
  const changedQuote = structuredClone(repaired);
  changedQuote.cases["case-a"].artifactWork.api.obligations[0].requirements[0].requestQuote = "Use another request span.";
  assert.throws(() => assertRepairScope(original, changedQuote, proposalPlan), { code: "REPAIR_SCOPE_VIOLATION" });

  const missingObligationPlan: RepairPlan = {
    editablePaths: [path],
    defects: [{ code: "missing_operation_obligation", path, message: "An explicit operation obligation is missing." }],
  };
  const addedObligation = structuredClone(repaired);
  addedObligation.cases["case-a"].artifactWork.api.obligations[0].requirements.push({
    requestQuote: "Set the timeout to 5 minutes.", requirement: "5 minutes", checkKind: null,
  });
  assert.throws(() => assertRepairScope(original, addedObligation, proposalPlan), { code: "REPAIR_SCOPE_VIOLATION" });
  assert.doesNotThrow(() => assertRepairScope(original, addedObligation, missingObligationPlan));
});

test("schema repair defects are bounded and safe for the model prompt", () => {
  const issues = Array.from({ length: 40 }, (_, index) => ({
    path: index === 0 ? ["__proto__"] : ["cases", index],
    message: `\u0001${"x".repeat(400)}`,
  }));
  const plan = schemaRepairPlan(issues);
  assert.equal(plan.defects.length, 32);
  assert.deepEqual(plan.defects[0].path, []);
  assert.equal(plan.defects[0].message.length, 320);
  assert.doesNotMatch(plan.defects[0].message, /[\u0000-\u001f\u007f]/u);
});

test("schema root plans survive JSON round trips and prototype paths are rejected", () => {
  const plan = schemaRepairPlan([{ path: ["items", "bad", "recommendation"], message: "invalid schema" }]);
  assert.deepEqual(plan.editablePaths, [[]]);
  assert.doesNotThrow(() => assertRepairScope({ value: 1 }, { rebuilt: true }, plan));
  const persistedPlan = JSON.parse(JSON.stringify(plan)) as RepairPlan;
  assert.doesNotThrow(() => assertRepairScope({ value: 1 }, { rebuilt: true }, persistedPlan));
  const citedFact = { claims: [{ kind: "source_fact", text: "Server-owned passage text.", sourceRefs: [{ passageId: "p1" }] }] };
  assert.throws(() => assertRepairScope(citedFact, {
    claims: [{ ...citedFact.claims[0], text: "Altered historical text." }],
  }, plan), { code: "REPAIR_SCOPE_VIOLATION" });
  assert.throws(() => assertRepairScope({ value: 1 }, { rebuilt: true }, {
    editablePaths: [[]], defects: [{ code: "repair_defect", path: [], message: "forged root" }],
  } as RepairPlan), { code: "REPAIR_SCOPE_INVALID" });
  assert.throws(() => assertRepairScope({}, {}, {
    editablePaths: [["__proto__"]], defects: [{ code: "repair_defect", path: [], message: "bad path" }],
  } as unknown as RepairPlan), { code: "REPAIR_SCOPE_INVALID" });
});

