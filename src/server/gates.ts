import type { ArtifactReview, AssessmentResult, BriefConstraintReview, BriefResult, BriefDisposition, Claim, CaseAssessment, Lead, RequestConstraints, SupportVerdict } from "../shared/protocol.ts";
import { EvidenceUnavailable, type CorpusSnapshot } from "./corpus.ts";
import type { AssessmentDraft, AssessmentReview, BriefDraft, SupportReview } from "./schemas.ts";
import { artifactReviewsSchema, briefSupportReviewSchema, requestConstraintsSchema } from "./schemas.ts";
import { completeRequestQuotes } from "./request-constraints.ts";
import { invalidSourceHistoryQualifications, isSourceHistoryQualification } from "./source-history.ts";

export class GateFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "GateFailure";
  }
}

function allIdsExist(ids: string[], claims: Map<string, Claim>): boolean {
  return ids.every((id) => claims.has(id));
}

function assertAcyclic(claims: Map<string, Claim>): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new GateFailure("INVALID_DEPENDENCY_GRAPH", "Claim dependencies contain a cycle.");
    visiting.add(id);
    for (const dependency of claims.get(id)?.dependsOnClaimIds ?? []) {
      if (!claims.has(dependency)) throw new GateFailure("INVALID_DEPENDENCY_GRAPH", "A claim dependency is missing.");
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of claims.keys()) visit(id);
}

function assertCaseReferences(draft: AssessmentDraft, corpus: CorpusSnapshot): void {
  const expected = new Set(corpus.manifest.cases.map((item) => item.caseId));
  const received = new Set(draft.cases.map((item) => item.caseId));
  if (received.size !== 8 || received.size !== expected.size || [...expected].some((id) => !received.has(id))) {
    throw new GateFailure("INCOMPLETE_CASE_SET", "The assessment did not include exactly the eight published cases.");
  }
  const artifactsByCase = new Map(corpus.manifest.cases.map((item) => [item.caseId, new Set(item.artifacts.map((artifact) => artifact.artifactId))]));
  const usableArtifactsByCase = new Map(corpus.manifest.cases.map((item) => [
    item.caseId,
    new Set(item.artifacts.filter((artifact) => artifact.versions.some((version) => version.extractionStatus === "complete" && corpus.availableVersions.has(version.versionId))).map((artifact) => artifact.artifactId)),
  ]));
  const claims = new Map(draft.claims.map((claim) => [claim.claimId, claim]));
  const leadCases = new Set<string>();
  const contrastCases = new Set<string>();
  for (const [items, seenCases] of [[draft.leads, leadCases], [draft.contrasts, contrastCases]] as const) {
    for (const item of items) {
      if (!expected.has(item.caseId)) throw new GateFailure("UNKNOWN_CASE_REFERENCE", "A lead or contrast refers to an unknown case.");
      if (seenCases.has(item.caseId)) throw new GateFailure("DUPLICATE_CASE_TIER", "A case appears more than once in a result tier.");
      seenCases.add(item.caseId);
      const artifactIds = artifactsByCase.get(item.caseId);
      if (new Set(item.usefulArtifactIds).size !== item.usefulArtifactIds.length || item.usefulArtifactIds.some((id) => !artifactIds?.has(id))) {
        throw new GateFailure("UNKNOWN_ARTIFACT_REFERENCE", "A lead refers to work outside its case.");
      }
      for (const claimId of item.reasonClaimIds) {
        if (!claims.get(claimId)?.sourceRefs.some((ref) => ref.caseId === item.caseId)) {
          throw new GateFailure("CLAIM_CASE_SCOPE", "A lead or contrast reason lacks evidence from its own case.");
        }
      }
    }
  }
  if ([...leadCases].some((id) => contrastCases.has(id))) throw new GateFailure("CONFLICTING_CASE_TIER", "A case cannot be both a lead and a contrast.");
  const dispositionClaimIds = new Set<string>();
  for (const item of draft.cases) {
    const artifactIds = artifactsByCase.get(item.caseId);
    if (!artifactIds) throw new GateFailure("UNKNOWN_CASE_REFERENCE", "A case entry refers to an unknown case.");
    for (const claimId of [...item.claimIds, ...item.outcomeClaimIds]) {
      if (!claims.get(claimId)?.sourceRefs.some((ref) => ref.caseId === item.caseId)) {
        throw new GateFailure("CLAIM_CASE_SCOPE", "A case claim lacks evidence from its own case.");
      }
    }
    const workIds = new Set<string>();
    const usableArtifactIds = usableArtifactsByCase.get(item.caseId) ?? new Set<string>();
    for (const work of item.artifactWork) {
      if (!artifactIds.has(work.artifactId)) throw new GateFailure("UNKNOWN_ARTIFACT_REFERENCE", "Artifact work refers outside its case.");
      if (workIds.has(work.artifactId)) throw new GateFailure("DUPLICATE_ARTIFACT_WORK", "An artifact appears more than once in a case.");
      workIds.add(work.artifactId);
      if (!usableArtifactIds.has(work.artifactId)) throw new GateFailure("UNAVAILABLE_ARTIFACT_WORK", "The assessment classified an artifact without verified usable source evidence.");
      if (!allIdsExist([...work.claimIds, ...work.blockerClaimIds, ...work.verificationClaimIds], claims)) {
        throw new GateFailure("UNKNOWN_CLAIM_REFERENCE", "Artifact work refers to a missing claim.");
      }
      for (const claimId of work.claimIds) {
        if (!claims.get(claimId)?.sourceRefs.some((ref) => ref.caseId === item.caseId && ref.artifactId === work.artifactId)) {
          throw new GateFailure("CLAIM_ARTIFACT_SCOPE", "Artifact work lacks evidence from that exact artifact.");
        }
      }
      const dispositionClaim = claims.get(work.dispositionClaimId);
      if (!work.claimIds.includes(work.dispositionClaimId) || dispositionClaim?.kind !== (work.disposition === null ? "interpretation" : "recommendation") || dispositionClaimIds.has(work.dispositionClaimId)) {
        throw new GateFailure("DISPOSITION_RECOMMENDATION_REQUIRED", "Each artifact needs its own reviewed recommendation or explicit exclusion interpretation.");
      }
      dispositionClaimIds.add(work.dispositionClaimId);
      if (work.blockerClaimIds.some((id) => !work.claimIds.includes(id)) || work.verificationClaimIds.some((id) => !work.claimIds.includes(id))) {
        throw new GateFailure("INVALID_WORK_CLAIMS", "Blockers and verification checks must be included in the work's reviewed claim set.");
      }
      if (work.disposition === "reuse" && (work.blockerClaimIds.length > 0 || work.verificationClaimIds.length > 0)) {
        throw new GateFailure("REUSE_BLOCKED", "Unchanged reuse cannot include a blocker or decisive verification requirement.");
      }
      if (work.disposition === "verify" && work.verificationClaimIds.length === 0) {
        throw new GateFailure("VERIFY_WITHOUT_CHECK", "A verify item must identify a concrete verification claim.");
      }
    }
    if (workIds.size !== usableArtifactIds.size || [...usableArtifactIds].some((id) => !workIds.has(id))) {
      throw new GateFailure("INCOMPLETE_ARTIFACT_WORK", "The assessment omits an artifact with verified usable source evidence.");
    }
    const lead = draft.leads.find((leadItem) => leadItem.caseId === item.caseId);
    if (lead && lead.usefulArtifactIds.some((id) => !item.artifactWork.some((work) => work.artifactId === id && (work.disposition === "reuse" || work.disposition === "adapt")))) {
      throw new GateFailure("LEAD_ARTIFACT_NOT_USABLE", "A lead includes work that was not checked as reusable or adaptable.");
    }
  }
}

function validClaimReferences(claims: Claim[], request: string, corpus: CorpusSnapshot): Set<string> {
  const byId = new Map(claims.map((claim) => [claim.claimId, claim]));
  if (byId.size !== claims.length) throw new GateFailure("DUPLICATE_CLAIM_ID", "The model returned duplicate claim identities.");
  assertAcyclic(byId);
  const invalid = invalidSourceHistoryQualifications(corpus, claims);
  for (const claim of claims) {
    if (claim.sourceRefs.some((ref) => {
      const passage = corpus.passages.get(ref.passageId);
      return !passage || passage.caseId !== ref.caseId || passage.artifactId !== ref.artifactId || passage.versionId !== ref.versionId;
    })) invalid.add(claim.claimId);
    if (claim.requestQuotes.some((quote) => !request.includes(quote))) invalid.add(claim.claimId);
    if (claim.sourceRefs.length === 0) invalid.add(claim.claimId);
    if (claim.kind === "source_fact" && (claim.requestQuotes.length > 0
      || (!isSourceHistoryQualification(corpus, claim)
        && claim.text !== claim.sourceRefs.map((ref) => corpus.passages.get(ref.passageId)?.excerpt ?? "").join("\n")))) invalid.add(claim.claimId);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const claim of claims) {
      if (!invalid.has(claim.claimId) && claim.dependsOnClaimIds.some((id) => invalid.has(id))) {
        invalid.add(claim.claimId);
        changed = true;
      }
    }
  }
  return invalid;
}

export function validateAssessmentDraft(draft: AssessmentDraft, request: string, corpus: CorpusSnapshot): Set<string> {
  assertCaseReferences(draft, corpus);
  const claimById = new Map(draft.claims.map((claim) => [claim.claimId, claim]));
  for (const row of draft.comparisons) {
    const requirement = row.requirementClaimId === null ? null : claimById.get(row.requirementClaimId);
    const evidence = claimById.get(row.evidenceClaimId);
    const assessment = claimById.get(row.assessmentClaimId);
    const implication = claimById.get(row.implicationClaimId);
    if (![...draft.leads, ...draft.contrasts].some((item) => item.caseId === row.caseId)) {
      throw new GateFailure("INVALID_COMPARISON_SCOPE", "Comparisons must describe a lead or contrast.");
    }
    if ((row.requirementClaimId !== null && (requirement?.kind !== "interpretation" || requirement.requestQuotes.length !== 1))
      || (row.requirementClaimId === null && row.relation !== "unknown")
      || evidence?.kind !== "source_fact" || assessment?.kind !== "interpretation"
      || implication?.kind !== (row.implicationEffect === "checked_decision" ? "recommendation" : "interpretation")
      || ![evidence, assessment, implication].every((item) => item?.sourceRefs.some((ref) => ref.caseId === row.caseId))
      || !assessment.dependsOnClaimIds.includes(row.evidenceClaimId)
      || (row.requirementClaimId !== null && !assessment.dependsOnClaimIds.includes(row.requirementClaimId))
      || !implication.dependsOnClaimIds.includes(row.assessmentClaimId)) {
      throw new GateFailure("INVALID_COMPARISON_CLAIMS", "Comparison facts, relation, and reuse implication require scoped, dependent reviewed claims; absent requirements are unknown.");
    }
    const work = draft.cases.find((item) => item.caseId === row.caseId)?.artifactWork.find((item) => item.artifactId === row.artifactId);
    if (!work || !["checked_decision", "context_only", "missing_evidence"].includes(row.implicationEffect)
      || (row.implicationEffect === "checked_decision" && !implication.dependsOnClaimIds.includes(work.dispositionClaimId))) {
      throw new GateFailure("INVALID_IMPLICATION_DECISION", "A positive implication must depend on its exact reviewed artifact decision.");
    }
  }
  const claimLinks = [
    ...draft.cases.flatMap((item) => [...item.claimIds, ...item.outcomeClaimIds]),
    ...draft.cases.flatMap((item) => item.artifactWork.flatMap((work) => [...work.claimIds, ...work.blockerClaimIds, ...work.verificationClaimIds])),
    ...draft.leads.flatMap((item) => item.reasonClaimIds),
    ...draft.contrasts.flatMap((item) => item.reasonClaimIds),
    ...draft.clarifyingClaimIds,
    ...draft.comparisons.flatMap((row) => [row.evidenceClaimId, row.assessmentClaimId, row.implicationClaimId, ...(row.requirementClaimId === null ? [] : [row.requirementClaimId])]),
  ];
  if (!allIdsExist(claimLinks, claimById)) throw new GateFailure("UNKNOWN_CLAIM_REFERENCE", "The assessment references a missing claim.");
  const assigned = new Set(claimLinks);
  if (draft.claims.some((claim) => !assigned.has(claim.claimId))) throw new GateFailure("UNUSED_CLAIM", "The assessment contains unassigned model prose.");
  return validClaimReferences(draft.claims, request, corpus);
}

export function validateBriefDraft(draft: BriefDraft, request: string, selections: { caseId: string; artifactId: string; versionId: string }[], corpus: CorpusSnapshot): Set<string> {
  const claims = new Map(draft.claims.map((claim) => [claim.claimId, claim]));
  if (claims.size !== draft.claims.length) throw new GateFailure("DUPLICATE_CLAIM_ID", "The model returned duplicate claim identities.");
  const selected = new Set(selections.map((item) => `${item.caseId}/${item.artifactId}/${item.versionId}`));
  const assigned = new Set<string>();
  const includedClaims = new Set<string>();
  const dispositionClaimIds = new Set<string>();
  const validateSection = (items: BriefDraft["reuse"], disposition: BriefDisposition): void => {
    for (const item of items) {
      if (item.disposition !== disposition) throw new GateFailure("INVALID_BRIEF_CLASSIFICATION", "A brief item is in a section that conflicts with its disposition.");
      const key = `${item.caseId}/${item.artifactId}/${item.versionId}`;
      if (!selected.has(key)) throw new GateFailure("UNSELECTED_ARTIFACT", "The brief refers to work or a source version the lead did not select.");
      if (assigned.has(key)) throw new GateFailure("DUPLICATE_BRIEF_ITEM", "Selected work appears in more than one brief section.");
      assigned.add(key);
      const source = corpus.manifest.cases.find((pastCase) => pastCase.caseId === item.caseId)?.artifacts.find((artifact) => artifact.artifactId === item.artifactId);
      if (!source || !source.versions.some((version) => version.versionId === item.versionId && version.extractionStatus === "complete" && corpus.availableVersions.has(version.versionId))) {
        throw new GateFailure("UNAVAILABLE_SELECTED_ARTIFACT", "The brief refers to incomplete or unavailable work.");
      }
      if (!item.claimIds.length || !allIdsExist(item.claimIds, claims)) throw new GateFailure("UNKNOWN_CLAIM_REFERENCE", "A brief item lacks complete checked claim references.");
      const dispositionClaim = claims.get(item.dispositionClaimId);
      if (!item.claimIds.includes(item.dispositionClaimId) || dispositionClaim?.kind !== "recommendation" || dispositionClaimIds.has(item.dispositionClaimId)) {
        throw new GateFailure("DISPOSITION_RECOMMENDATION_REQUIRED", "Each brief disposition needs its own reviewed recommendation claim.");
      }
      dispositionClaimIds.add(item.dispositionClaimId);
      for (const claimId of item.claimIds) {
        if (claims.get(claimId)?.dependsOnClaimIds.some((dependency) => claims.has(dependency) && !item.claimIds.includes(dependency))) {
          throw new GateFailure("BRIEF_DEPENDENCY_SCOPE", "A brief claim depends on another item's claims.");
        }
        if (!claims.get(claimId)?.sourceRefs.some((ref) => ref.caseId === item.caseId && ref.artifactId === item.artifactId && ref.versionId === item.versionId)) {
          throw new GateFailure("CLAIM_VERSION_SCOPE", "A brief item lacks evidence from its exact selected source version.");
        }
        includedClaims.add(claimId);
      }
    }
  };
  validateSection(draft.reuse, "reuse");
  validateSection(draft.adapt, "adapt");
  validateSection(draft.verify, "verify");
  if (assigned.size !== selected.size) throw new GateFailure("INCOMPLETE_BRIEF_SELECTION", "Every selected work item must appear exactly once in the brief.");
  if (includedClaims.size !== claims.size) throw new GateFailure("UNUSED_CLAIM", "The brief contains unassigned model prose.");
  return validClaimReferences(draft.claims, request, corpus);
}

export function validateSupportReview(claims: Claim[], review: SupportReview): Map<string, SupportVerdict> {
  const expected = new Set(claims.map((claim) => claim.claimId));
  const verdicts = new Map(review.claimReviews.map((item) => [item.claimId, item.verdict]));
  if (verdicts.size !== review.claimReviews.length || verdicts.size !== expected.size || [...expected].some((id) => !verdicts.has(id))) {
    throw new GateFailure("INCOMPLETE_SUPPORT_REVIEW", "The separate support review did not return exactly one disposition for every claim.");
  }
  return verdicts;
}

export function validateArtifactReview(draft: AssessmentDraft, review: AssessmentReview): Map<string, ArtifactReview> {
  const works = new Map(draft.cases.flatMap((item) => item.artifactWork.map((work) => [`${item.caseId}/${work.artifactId}`, work] as const)));
  const decisions = new Map(review.artifactReviews.map((item) => {
    const work = works.get(`${item.caseId}/${item.artifactId}`);
    if (!work?.decision || item.disposition !== work.decision.disposition || (item.verdict !== "supported" && item.reasons.length === 0)) {
      throw new GateFailure("INVALID_ARTIFACT_DECISION_REVIEW", "Review must judge the exact proposed disposition and explain every non-supported decision.");
    }
    const { disposition: _, ...independent } = item;
    return [`${item.caseId}/${item.artifactId}`, { ...independent, decision: work.decision }] as const;
  }));
  if (decisions.size !== review.artifactReviews.length || decisions.size !== works.size || [...works.keys()].some((id) => !decisions.has(id))) {
    throw new GateFailure("INCOMPLETE_ARTIFACT_REVIEW", "Every assessed artifact needs exactly one independent decision review.");
  }
  return decisions;
}

function supportedClaims(claims: Claim[], verdicts: Map<string, SupportVerdict>, referenceInvalid: Set<string>) {
  const all = new Map(claims.map((claim) => [claim.claimId, claim]));
  assertAcyclic(all);
  const accepted = new Set<string>();
  for (const claim of claims) if (!referenceInvalid.has(claim.claimId) && verdicts.get(claim.claimId) === "supported") accepted.add(claim.claimId);
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...accepted]) {
      if (all.get(id)?.dependsOnClaimIds.some((dependency) => !accepted.has(dependency))) {
        accepted.delete(id);
        changed = true;
      }
    }
  }
  for (const claim of claims) {
    if (accepted.has(claim.claimId) && claim.claimId.startsWith("source-history-")
      && !claims.some((consumer) => accepted.has(consumer.claimId) && consumer.dependsOnClaimIds.includes(claim.claimId))) accepted.delete(claim.claimId);
  }
  return { accepted, visible: claims.filter((claim) => accepted.has(claim.claimId)), withheld: claims.length - accepted.size };
}

function keepAll(ids: string[], accepted: Set<string>): boolean {
  return ids.length > 0 && ids.every((id) => accepted.has(id));
}

function invalidDecisionReasons(review: ArtifactReview, request: string, corpus: CorpusSnapshot): boolean {
  return review.reasons.some((reason) => reason.requestQuotes.some((quote) => !request.includes(quote))
    || reason.sourceRefs.some((ref) => {
      const passage = corpus.passages.get(ref.passageId);
      return !passage || passage.caseId !== ref.caseId || passage.artifactId !== ref.artifactId || passage.versionId !== ref.versionId;
    }));
}

export function buildCheckedAssessment(
  draft: AssessmentDraft,
  verdicts: Map<string, SupportVerdict>,
  invalidRefs: Set<string>,
  corpus: CorpusSnapshot,
  artifactReviews: Map<string, ArtifactReview>,
  requirementReview: { request: string; constraints: RequestConstraints },
): AssessmentResult {
  const reviewEntries = [...artifactReviews.entries()];
  if (reviewEntries.some(([key, review]) => key !== `${review.caseId}/${review.artifactId}`)
    || !artifactReviewsSchema.safeParse(reviewEntries.map(([, review]) => review)).success) {
    throw new GateFailure("INVALID_ARTIFACT_DECISION_REVIEW", "Artifact decisions must satisfy their canonical operation and evidence contract.");
  }
  const rejected = new Set(invalidRefs);
  const decisionVerdicts = new Map(verdicts);
  const constraints = requestConstraintsSchema.safeParse(requirementReview.constraints);
  const draftConstraints = requestConstraintsSchema.safeParse(draft.requestConstraints);
  if (!constraints.success || !draftConstraints.success
    || Object.values(constraints.data).some((quotes) => quotes.some((quote) => !requirementReview.request.includes(quote)))
    || Object.values(draftConstraints.data).some((quotes) => quotes.some((quote) => !requirementReview.request.includes(quote)))) {
    throw new GateFailure("INVALID_REQUEST_CONSTRAINT_REVIEW", "Draft and independent review need every request-constraint dimension with exact request quotations.");
  }
  try {
    for (const inventory of [constraints.data, draftConstraints.data]) {
      for (const quotes of Object.values(inventory)) {
        if (completeRequestQuotes(requirementReview.request, quotes).some((quote) => !quotes.includes(quote))) {
          throw new Error("Incomplete sentence coverage");
        }
      }
    }
  } catch {
    throw new GateFailure("INVALID_REQUEST_CONSTRAINT_REVIEW", "A request-constraint inventory omits part of a selected sentence.");
  }
  const knownArtifacts = new Set(corpus.manifest.cases.flatMap((item) => item.artifacts.map((artifact) => `${item.caseId}/${artifact.artifactId}`)));
  if ([...artifactReviews.keys()].some((key) => !knownArtifacts.has(key))
    || draft.cases.some((item) => item.artifactWork.some((work) => !artifactReviews.has(`${item.caseId}/${work.artifactId}`)))) {
    throw new GateFailure("INCOMPLETE_ARTIFACT_REVIEW", "Missing or unknown artifact-role review.");
  }
  let requirementConflict = (Object.keys(constraints.data) as (keyof RequestConstraints)[])
    .some((dimension) => constraints.data[dimension].some((quote) => !draftConstraints.data[dimension].includes(quote))
      || draftConstraints.data[dimension].some((quote) => !constraints.data[dimension].includes(quote)));
  for (const row of draft.comparisons) {
    if ((row.requirementClaimId === null) !== (constraints.data[row.dimension].length === 0)
      || (row.requirementClaimId === null) !== (draftConstraints.data[row.dimension].length === 0)) {
      rejected.add(row.assessmentClaimId);
      requirementConflict = true;
    }
  }
  const draftClaims = new Map(draft.claims.map((claim) => [claim.claimId, claim]));
  const scaleQuotes = [...new Set([...constraints.data.scale, ...draftConstraints.data.scale])];
  const missingLimitQuotes = new Map<string, string[]>();
  for (const item of draft.cases) {
    for (const work of item.artifactWork) {
      const review = artifactReviews.get(`${item.caseId}/${work.artifactId}`)!;
      decisionVerdicts.set(work.dispositionClaimId, review.verdict);
      if (review.decision.disposition !== work.disposition || JSON.stringify(review.decision) !== JSON.stringify(work.decision)
        || (review.verdict !== "supported" && review.reasons.length === 0)
        || invalidDecisionReasons(review, requirementReview.request, corpus)) {
        throw new GateFailure("INVALID_ARTIFACT_DECISION_REVIEW", "Decision review has mismatched disposition, missing reasons or invalid evidence.");
      }
      if (work.disposition !== null && review.role !== "starting_point") rejected.add(work.dispositionClaimId);
      if (review.decision.operation === "api_adapter" && (work.disposition === "adapt" || work.disposition === "verify")) {
        const ownedQuotes = new Set(completeRequestQuotes(requirementReview.request, [
          ...review.decision.requestQuotes,
          ...review.decision.adaptations.flatMap((condition) => condition.requestQuotes),
          ...review.decision.checks.flatMap((condition) => condition.requestQuotes),
        ]));
        const missing = scaleQuotes.filter((quote) => ownedQuotes.has(quote) && !review.decision.checks.some((check) =>
          check.kind === "client_operation_limits" && check.requestQuotes.includes(quote)
          && work.verificationClaimIds.some((id) => {
            const claim = draftClaims.get(id);
            return work.claimIds.includes(id) && claim?.kind === "recommendation"
              && claim.text === check.text && claim.requestQuotes.includes(quote)
              && claim.sourceRefs.length === check.sourceRefs.length
              && claim.sourceRefs.every((ref, index) => {
                const checkedRef = check.sourceRefs[index];
                return ref.caseId === checkedRef.caseId && ref.artifactId === checkedRef.artifactId
                  && ref.versionId === checkedRef.versionId && ref.passageId === checkedRef.passageId;
              });
          })));
        if (missing.length) {
          missingLimitQuotes.set(`${item.caseId}/${work.artifactId}`, missing);
          rejected.add(work.dispositionClaimId);
        }
      }
    }
  }
  const offeringIds = new Set<string>();
  for (const item of draft.cases) for (const work of item.artifactWork) {
    offeringIds.add(work.dispositionClaimId);
    const rejectedDecision = work.disposition === null || rejected.has(work.dispositionClaimId)
      || decisionVerdicts.get(work.dispositionClaimId) !== "supported";
    for (const claimId of work.claimIds) {
      const claim = draftClaims.get(claimId);
      if (claim?.kind === "recommendation") {
        offeringIds.add(claimId);
        if (rejectedDecision) rejected.add(claimId);
      } else if (claim?.kind === "interpretation" && claimId !== work.dispositionClaimId && rejectedDecision) {
        rejected.add(claimId);
      }
    }
  }
  for (const row of draft.comparisons) {
    const implication = draftClaims.get(row.implicationClaimId);
    const work = draft.cases.find((item) => item.caseId === row.caseId)?.artifactWork.find((item) => item.artifactId === row.artifactId);
    if (!work || !implication) {
      rejected.add(row.assessmentClaimId);
      rejected.add(row.implicationClaimId);
      continue;
    }
    if (draftClaims.get(row.assessmentClaimId)?.text !== `Recorded evidence has relation ${row.relation} to the current ${row.dimension} requirement; unestablished applicability remains unknown.`) rejected.add(row.assessmentClaimId);
    if (row.implicationEffect === "checked_decision") {
      offeringIds.add(implication.claimId);
      if (implication.kind !== "recommendation" || work.disposition === null
        || !implication.dependsOnClaimIds.includes(work.dispositionClaimId)) rejected.add(implication.claimId);
      if (implication.text !== `Checked artifact decision: ${work.disposition ?? "excluded"}; proposed changes and required checks are not established client capabilities.`) rejected.add(implication.claimId);
    } else {
      const expected = row.implicationEffect === "context_only" ? "Context only; no implementation starting work is offered."
        : row.implicationEffect === "missing_evidence" ? "Missing evidence must be obtained before a starting-work decision; no implementation starting work is offered." : null;
      if (implication.kind !== "interpretation" || implication.text !== expected) rejected.add(implication.claimId);
    }
  }
  const structuredInterpretations = new Set([
    ...draft.cases.flatMap((item) => [...item.outcomeClaimIds, ...item.artifactWork.flatMap((work) => work.claimIds)]),
    ...draft.comparisons.flatMap((row) => [row.requirementClaimId, row.assessmentClaimId, row.implicationClaimId]),
  ]);
  for (const claim of draft.claims) {
    if (claim.kind === "recommendation" && !offeringIds.has(claim.claimId)) rejected.add(claim.claimId);
    if (claim.kind === "interpretation" && !structuredInterpretations.has(claim.claimId)
      && claim.text !== `The current request states: ${claim.requestQuotes.map((quote) => JSON.stringify(quote)).join(" ")}`) rejected.add(claim.claimId);
  }
  for (const item of [...draft.leads, ...draft.contrasts]) {
    for (const claimId of item.reasonClaimIds) if (draftClaims.get(claimId)?.kind !== "source_fact") rejected.add(claimId);
  }
  let checked = supportedClaims(draft.claims, decisionVerdicts, rejected);
  for (const item of draft.cases) for (const work of item.artifactWork) {
    // Every proposed change and required check is decisive. Historical truth
    // alone cannot approve a disposition when one of these was rejected.
    if (work.disposition !== null && work.claimIds.some((id) => !checked.accepted.has(id))) rejected.add(work.dispositionClaimId);
  }
  checked = supportedClaims(draft.claims, decisionVerdicts, rejected);
  const explainedReviews = [...artifactReviews.values()].map((review) => {
    const work = draft.cases.find((item) => item.caseId === review.caseId)?.artifactWork.find((work) => work.artifactId === review.artifactId);
    if (!work || checked.accepted.has(work.dispositionClaimId) || review.verdict !== "supported") return review;
    const failed = work.claimIds.flatMap((id) => !checked.accepted.has(id) && id !== work.dispositionClaimId && draftClaims.has(id) ? [draftClaims.get(id)!] : []);
    const reasons = failed.length ? failed.map((claim) => ({
      target: (claim.kind === "source_fact" ? "history" : work.verificationClaimIds.includes(claim.claimId) ? "check" : "adaptation") as "history" | "check" | "adaptation",
      explanation: `Server gate: decisive claim ${claim.claimId} was withheld (${invalidRefs.has(claim.claimId) ? "invalid or unavailable evidence" : verdicts.get(claim.claimId) ?? "dependency rejected"}); the disposition cannot drop that prerequisite.`,
      sourceRefs: claim.sourceRefs, requestQuotes: claim.requestQuotes,
    })) : [{
      target: "disposition" as const,
      explanation: `Server gate: the proposed disposition is not eligible under role ${review.role} or its evidence dependencies.`,
      sourceRefs: review.decision.historicalEvidence, requestQuotes: review.decision.requestQuotes,
    }];
    const missingLimits = (missingLimitQuotes.get(`${review.caseId}/${review.artifactId}`) ?? []).map((quote) => ({
      target: "check" as const,
      explanation: "Server gate: current-tenant acceptance of this exact requested operation limit lacks an owned, reviewed pre-use check; a proposed cap or historical test is not confirmation.",
      sourceRefs: review.decision.historicalEvidence, requestQuotes: [quote],
    }));
    return { ...review, reasons: [...review.reasons, ...missingLimits, ...reasons].slice(0, 8) };
  });
  const cases: CaseAssessment[] = draft.cases.map((item, caseIndex) => {
    const classificationId = `outcome-${caseIndex}`;
    const classification = draft.claims.find((claim) => claim.claimId === classificationId);
    const outcomeClaimsValid = classification?.kind === "interpretation"
      && classification.text === `Observed case outcome: ${item.outcome}.`
      && item.outcomeClaimIds.includes(classificationId)
      && keepAll(item.outcomeClaimIds, checked.accepted);
    const pastCase = corpus.manifest.cases.find((candidate) => candidate.caseId === item.caseId);
    const workByArtifact = new Map(item.artifactWork.map((work) => [work.artifactId, work]));
    const artifactWork = (pastCase?.artifacts ?? []).map((artifact) => {
      const usableVersions = artifact.versions.filter((version) => version.extractionStatus === "complete" && corpus.availableVersions.has(version.versionId));
      const availability: CaseAssessment["artifactWork"][number]["availability"] = usableVersions.length === 0 ? "unavailable" : usableVersions.length === artifact.versions.length ? "available" : "partial";
      const exclusionReasons = [...new Set(artifact.versions.flatMap((version) => {
        if (version.extractionStatus !== "complete") return version.exclusionReasons.length ? version.exclusionReasons : ["Extraction incomplete."];
        return corpus.availableVersions.has(version.versionId) ? [] : ["Original unavailable or failed integrity verification."];
      }))];
      const work = workByArtifact.get(artifact.artifactId);
      const accepted = work !== undefined && work.disposition !== null
        && checked.accepted.has(work.dispositionClaimId)
        && !(work.disposition === "reuse" && (work.blockerClaimIds.length > 0 || work.verificationClaimIds.length > 0));
      const excluded = work?.disposition === null && checked.accepted.has(work.dispositionClaimId);
      return {
        artifactId: artifact.artifactId,
        availability,
        exclusionReasons,
        disposition: accepted ? work.disposition : null,
        dispositionClaimId: accepted || excluded ? work.dispositionClaimId : null,
        claimIds: accepted || excluded ? work.claimIds.filter((id) => checked.accepted.has(id)) : [],
        blockerClaimIds: accepted ? work.blockerClaimIds.filter((id) => checked.accepted.has(id)) : [],
        verificationClaimIds: accepted ? work.verificationClaimIds.filter((id) => checked.accepted.has(id)) : [],
      };
    });
    return {
      caseId: item.caseId,
      availability: corpus.caseAvailability.get(item.caseId) ?? "unavailable",
      outcome: outcomeClaimsValid ? item.outcome : "unknown",
      outcomeClaimIds: outcomeClaimsValid ? item.outcomeClaimIds : [],
      claimIds: item.claimIds.filter((id) => checked.accepted.has(id)),
      artifactWork,
    };
  });
  const leads = draft.leads.flatMap((lead) => {
    if (!keepAll(lead.reasonClaimIds, checked.accepted)) return [];
    const caseResult = cases.find((item) => item.caseId === lead.caseId);
    const usableIds = new Set(caseResult?.artifactWork.filter((work) => work.disposition !== null && work.disposition !== "verify").map((work) => work.artifactId));
    const usefulArtifactIds = lead.usefulArtifactIds.filter((id) => usableIds.has(id));
    if (usefulArtifactIds.length === 0) return [];
    return [{ ...lead, usefulArtifactIds }];
  });
  const contrasts = draft.contrasts.filter((item) => keepAll(item.reasonClaimIds, checked.accepted));
  const complete = [...corpus.caseAvailability.values()].every((state) => state === "available");
  const negativeExplanation = draft.comparisons.some((row) => row.relation !== "match"
    && keepAll([row.evidenceClaimId, row.assessmentClaimId, row.implicationClaimId, ...(row.requirementClaimId === null ? [] : [row.requirementClaimId])], checked.accepted))
    || draft.cases.some((item) => item.artifactWork.some((work) => work.disposition === null && checked.accepted.has(work.dispositionClaimId)));
  const noUsefulPrecedent = complete && invalidRefs.size === 0 && !requirementConflict && negativeExplanation
    && artifactReviews.size === knownArtifacts.size
    && cases.every((item) => item.artifactWork.every((work) => work.availability === "unavailable" || (work.disposition === null && work.dispositionClaimId !== null)))
    && [...artifactReviews.values()].every((review) => review.verdict === "supported" && (review.role === "context_only" || review.role === "not_relevant"));
  const conclusion = leads.length > 0 ? "precedent_found" : noUsefulPrecedent ? "no_useful_precedent" : "cannot_be_established";
  const visibleCases = new Set([...leads, ...contrasts].map((item) => item.caseId));
  const comparisons = draft.comparisons.filter((row) => (visibleCases.has(row.caseId) || row.relation !== "match")
    && keepAll([row.evidenceClaimId, row.assessmentClaimId, row.implicationClaimId, ...(row.requirementClaimId === null ? [] : [row.requirementClaimId])], checked.accepted));
  const claimById = new Map(checked.visible.map((claim) => [claim.claimId, claim]));
  // Prefer checks on current leads; never manufacture an action to fill a slot.
  const orderedCases = [...leads.map((lead) => cases.find((item) => item.caseId === lead.caseId)!), ...cases.filter((item) => !leads.some((lead) => lead.caseId === item.caseId))];
  const nextActions = orderedCases.flatMap((item) => item.artifactWork.flatMap((work) =>
    work.disposition === null ? [] : [...new Set([...work.verificationClaimIds, ...work.blockerClaimIds])].flatMap((claimId) => {
      const claim = claimById.get(claimId);
      return claim?.kind === "recommendation" && claim.requestQuotes.length > 0
        ? [{ caseId: item.caseId, artifactId: work.artifactId, claimId }] : [];
    }))).slice(0, 3);
  return {
    conclusion,
    clarifyingClaimIds: draft.clarifyingClaimIds.filter((id) => checked.accepted.has(id)),
    comparisons,
    requestConstraints: constraints.data,
    artifactReviews: explainedReviews,
    nextActions,
    cases,
    leads: deterministicOrder(leads, cases),
    contrasts,
    claims: checked.visible,
    withheldClaimCount: checked.withheld,
  };
}

function deterministicOrder(leads: Lead[], cases: CaseAssessment[]): Lead[] {
  const stateRank = { useful: 0, conditional: 1, partial: 2 } as const;
  const outcomeRank = { observed_success: 0, partial: 1, failed: 2, unknown: 3 } as const;
  const workCount = new Map(cases.map((item) => [item.caseId, item.artifactWork.filter((work) => work.disposition !== null && work.disposition !== "verify").length]));
  const outcomes = new Map(cases.map((item) => [item.caseId, item.outcome]));
  return [...leads].sort((a, b) => stateRank[a.state] - stateRank[b.state]
    || (workCount.get(b.caseId) ?? 0) - (workCount.get(a.caseId) ?? 0)
    || outcomeRank[outcomes.get(a.caseId) ?? "unknown"] - outcomeRank[outcomes.get(b.caseId) ?? "unknown"]
    || a.caseId.localeCompare(b.caseId));
}

function sameSelectedVersion(claim: Claim, selection: { caseId: string; artifactId: string; versionId: string }): boolean {
  return claim.sourceRefs.some((ref) => ref.caseId === selection.caseId && ref.artifactId === selection.artifactId && ref.versionId === selection.versionId);
}

// Quotations the checked assessment already accepted for this exact artifact/version.
// The brief must keep them even when a later reviewer inventories nothing.
export function boundAssessmentQuotes(
  assessment: AssessmentResult,
  selection: { caseId: string; artifactId: string; versionId: string },
): string[] {
  const work = assessment.cases.find((item) => item.caseId === selection.caseId)?.artifactWork.find((item) => item.artifactId === selection.artifactId);
  const assigned = new Set([
    ...(work?.claimIds ?? []),
    ...(work?.blockerClaimIds ?? []),
    ...(work?.verificationClaimIds ?? []),
    ...(work?.dispositionClaimId ? [work.dispositionClaimId] : []),
  ]);
  // Only claims assigned to this artifact's own work floor its brief coverage.
  // Comparison requirement claims state whole-request dimensions for the case;
  // they are not relevance judgments for this artifact, and flooring from them
  // forced one combined-brief item to carry another item's decisive quotation
  // (a support-access sign-off sentence on a connector item) even though both
  // the draft and the independent brief review judged it irrelevant there.
  // A quotation binds to this item only when its own work claim both declares
  // it in requestQuotes and states it verbatim in prose. Declared-but-unstated
  // provenance (a combined request's disposition claim listing every request
  // sentence) and prose mentions harvested from the global inventory are not
  // per-item coverage obligations; binding them forced a connector item to
  // carry a handover sentence its own checked work never asserted.
  const quotes = new Set<string>();
  const decision = assessment.artifactReviews.find((item) => item.caseId === selection.caseId && item.artifactId === selection.artifactId)?.decision;
  if (decision?.historicalEvidence.some((ref) => ref.versionId === selection.versionId)) {
    for (const quote of [...decision.requestQuotes, ...decision.adaptations.flatMap((item) => item.requestQuotes), ...decision.checks.flatMap((item) => item.requestQuotes)]) quotes.add(quote);
  }
  for (const claim of assessment.claims) {
    if (!sameSelectedVersion(claim, selection) || !assigned.has(claim.claimId)) continue;
    for (const quote of claim.requestQuotes) if (claim.text.includes(quote)) quotes.add(quote);
  }
  return [...quotes];
}

export function withAssessmentConstraintFloor(
  reviews: BriefConstraintReview[],
  assessment: AssessmentResult,
  request: string,
): BriefConstraintReview[] {
  return reviews.map((review) => ({
    ...review,
    requestQuotes: [...new Set([
      ...review.requestQuotes,
      ...boundAssessmentQuotes(assessment, review).filter((quote) => request.includes(quote)),
    ])],
  }));
}

export function buildCheckedBrief(
  draft: BriefDraft,
  verdicts: Map<string, SupportVerdict>,
  invalidRefs: Set<string>,
  requirementReview: { request: string; constraintReviews: BriefConstraintReview[]; assessment?: AssessmentResult },
): BriefResult {
  const reviews = briefSupportReviewSchema.shape.constraintReviews.safeParse(requirementReview.constraintReviews);
  const identity = (item: { caseId: string; artifactId: string; versionId: string }) => `${item.caseId}/${item.artifactId}/${item.versionId}`;
  const items = [...draft.reuse, ...draft.adapt, ...draft.verify];
  const inventory = new Map(reviews.success ? reviews.data.map((item) => [identity(item), item.requestQuotes]) : []);
  if (!reviews.success || inventory.size !== reviews.data.length || inventory.size !== items.length
    || items.some((item) => !inventory.has(identity(item)))
    || reviews.data.some((item) => item.requestQuotes.some((quote) => !requirementReview.request.includes(quote)))) {
    throw new GateFailure("INVALID_BRIEF_CONSTRAINT_REVIEW", "Every selected brief item requires an independent exact request-constraint inventory.");
  }
  const rejected = new Set(invalidRefs);
  const supported = supportedClaims(draft.claims, verdicts, rejected);
  const claims = new Map(draft.claims.map((claim) => [claim.claimId, claim]));
  for (const item of items) {
    const recommendations = item.claimIds.flatMap((id) => {
      const claim = claims.get(id);
      return claim?.kind === "recommendation" ? [claim] : [];
    });
    if (requirementReview.assessment) {
      const work = requirementReview.assessment.cases.find((candidate) => candidate.caseId === item.caseId)?.artifactWork.find((candidate) => candidate.artifactId === item.artifactId);
      if (!work?.disposition || work.disposition !== item.disposition) {
        for (const claim of recommendations) rejected.add(claim.claimId);
      }
    }
    // Every independent inventory and every declared/assessment-bound quotation
    // is mandatory. Clause selection carries its whole sentence, never a tail-less fragment.
    const bound = new Set(completeRequestQuotes(requirementReview.request, [...new Set([
      ...inventory.get(identity(item))!,
      ...recommendations.flatMap((claim) => claim.requestQuotes),
      ...(requirementReview.assessment ? boundAssessmentQuotes(requirementReview.assessment, item) : []),
    ])]));
    if ([...bound].some((quote) => !requirementReview.request.includes(quote)
      || !recommendations.some((claim) => supported.accepted.has(claim.claimId)
        && claim.requestQuotes.includes(quote) && claim.text.includes(quote)))) {
      // A true source fact or hidden requestQuotes metadata cannot stand in for a visible requested check.
      for (const claim of recommendations) rejected.add(claim.claimId);
    }
  }
  const checked = supportedClaims(draft.claims, verdicts, rejected);
  // An item survives on its own disposition claim, for the same reason
  // artifact work does in buildCheckedAssessment: dependency closure in
  // supportedClaims already withholds anything that actually depends on a
  // withheld claim, and the coverage check above has already rejected every
  // recommendation of an item missing a required quotation (including its
  // disposition claim). One unrelated withheld claim therefore withholds
  // only itself instead of erasing the whole selected item.
  const keep = (items: BriefDraft["reuse"], disposition: BriefDisposition) => items.flatMap((item) => {
    if (!item.claimIds.includes(item.dispositionClaimId) || !checked.accepted.has(item.dispositionClaimId)) return [];
    return [{ ...item, disposition, claimIds: item.claimIds.filter((id) => checked.accepted.has(id)) }];
  });
  const kept = {
    reuse: keep(draft.reuse, "reuse"),
    adapt: keep(draft.adapt, "adapt"),
    verify: keep(draft.verify, "verify"),
  };
  const keptIdentities = new Set([...kept.reuse, ...kept.adapt, ...kept.verify].map(identity));
  return {
    ...kept,
    claims: checked.visible,
    constraintReviews: reviews.data.filter((review) => keptIdentities.has(identity(review))),
    withheldClaimCount: checked.withheld,
  };
}

export function revalidateAssessment(result: AssessmentResult, request: string, corpus: CorpusSnapshot): AssessmentResult {
  const reviewed = artifactReviewsSchema.safeParse(result.artifactReviews);
  if (!reviewed.success || new Set(reviewed.data.map((item) => `${item.caseId}/${item.artifactId}`)).size !== reviewed.data.length) {
    throw new EvidenceUnavailable("Required independent artifact-role review is unavailable; a new checked assessment is needed.");
  }
  if (reviewed.data.some((review) => invalidDecisionReasons(review, request, corpus))) {
    throw new EvidenceUnavailable("Required independent decision-rejection evidence is unavailable; a new checked assessment is needed.");
  }
  const reviewedPairs = new Set(reviewed.data.map((item) => `${item.caseId}/${item.artifactId}`));
  if (result.cases.some((item) => item.artifactWork.some((work) => work.availability !== "unavailable" && !reviewedPairs.has(`${item.caseId}/${work.artifactId}`)))) {
    throw new EvidenceUnavailable("Required independent artifact-role review is incomplete.");
  }
  const draft: AssessmentDraft = {
    ...result,
    cases: result.cases.map((item) => ({
      ...item,
      artifactWork: item.artifactWork.flatMap((work) => {
        const review = reviewed.data.find((review) => review.caseId === item.caseId && review.artifactId === work.artifactId);
        return work.dispositionClaimId !== null && review
          ? [{ ...work, disposition: work.disposition, dispositionClaimId: work.dispositionClaimId, decision: review.decision }]
          : [];
      }),
    })),
  };
  const verdicts = new Map(result.claims.map((claim) => [claim.claimId, "supported" as const]));
  const artifactReviews = new Map(reviewed.data.map((item) => [`${item.caseId}/${item.artifactId}`, item]));
  try {
    const checked = buildCheckedAssessment(draft, verdicts, validClaimReferences(result.claims, request, corpus), corpus, artifactReviews, { request, constraints: result.requestConstraints });
    // Revalidation may withhold stale evidence, never upgrade a stored uncertain conclusion.
    if (result.conclusion === "cannot_be_established" && checked.conclusion === "no_useful_precedent") checked.conclusion = result.conclusion;
    checked.withheldClaimCount += result.withheldClaimCount;
    return checked;
  } catch (error) {
    if (error instanceof GateFailure && (error.code === "INVALID_REQUEST_CONSTRAINT_REVIEW" || error.code === "INCOMPLETE_ARTIFACT_REVIEW")) {
      throw new EvidenceUnavailable("Required independent request/implementation review is unavailable; a new checked assessment is needed.");
    }
    throw error;
  }
}

export function revalidateBrief(result: BriefResult, request: string, corpus: CorpusSnapshot, assessment?: AssessmentResult): BriefResult {
  const verdicts = new Map(result.claims.map((claim) => [claim.claimId, "supported" as const]));
  let checked: BriefResult;
  try {
    checked = buildCheckedBrief(result, verdicts, validClaimReferences(result.claims, request, corpus), { request, constraintReviews: result.constraintReviews, assessment });
  } catch (error) {
    if (error instanceof GateFailure && error.code === "INVALID_BRIEF_CONSTRAINT_REVIEW") {
      throw new EvidenceUnavailable("Required independent brief-constraint review is unavailable; a new checked brief is needed.");
    }
    throw error;
  }
  checked.withheldClaimCount += result.withheldClaimCount;
  return checked;
}
