import type { AssessmentResult, BriefResult, BriefDisposition, Claim, CaseAssessment, Lead, SupportVerdict } from "../shared/protocol.ts";
import type { CorpusSnapshot } from "./corpus.ts";
import type { AssessmentDraft, BriefDraft, SupportReview } from "./schemas.ts";

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
      if (!work.claimIds.includes(work.dispositionClaimId) || dispositionClaim?.kind !== "recommendation" || dispositionClaimIds.has(work.dispositionClaimId)) {
        throw new GateFailure("DISPOSITION_RECOMMENDATION_REQUIRED", "Each artifact disposition needs its own reviewed recommendation claim.");
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
    if (lead && lead.usefulArtifactIds.some((id) => !item.artifactWork.some((work) => work.artifactId === id && work.disposition !== "verify"))) {
      throw new GateFailure("LEAD_ARTIFACT_NOT_USABLE", "A lead includes work that was not checked as reusable or adaptable.");
    }
  }
}

function validClaimReferences(claims: Claim[], request: string, corpus: CorpusSnapshot): Set<string> {
  const byId = new Map(claims.map((claim) => [claim.claimId, claim]));
  if (byId.size !== claims.length) throw new GateFailure("DUPLICATE_CLAIM_ID", "The model returned duplicate claim identities.");
  assertAcyclic(byId);
  const invalid = new Set<string>();
  for (const claim of claims) {
    if (claim.sourceRefs.some((ref) => {
      const passage = corpus.passages.get(ref.passageId);
      return !passage || passage.caseId !== ref.caseId || passage.artifactId !== ref.artifactId || passage.versionId !== ref.versionId;
    })) invalid.add(claim.claimId);
    if (claim.requestQuotes.some((quote) => !request.includes(quote))) invalid.add(claim.claimId);
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
  const claimLinks = [
    ...draft.cases.flatMap((item) => [...item.claimIds, ...item.outcomeClaimIds]),
    ...draft.cases.flatMap((item) => item.artifactWork.flatMap((work) => [...work.claimIds, ...work.blockerClaimIds, ...work.verificationClaimIds])),
    ...draft.leads.flatMap((item) => item.reasonClaimIds),
    ...draft.contrasts.flatMap((item) => item.reasonClaimIds),
    ...draft.clarifyingClaimIds,
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

function supportedClaims(claims: Claim[], verdicts: Map<string, SupportVerdict>, referenceInvalid: Set<string>) {
  const all = new Map(claims.map((claim) => [claim.claimId, claim]));
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
  return { accepted, visible: claims.filter((claim) => accepted.has(claim.claimId)), withheld: claims.length - accepted.size };
}

function keepAll(ids: string[], accepted: Set<string>): boolean {
  return ids.length > 0 && ids.every((id) => accepted.has(id));
}

export function buildCheckedAssessment(draft: AssessmentDraft, verdicts: Map<string, SupportVerdict>, invalidRefs: Set<string>, corpus: CorpusSnapshot): AssessmentResult {
  const checked = supportedClaims(draft.claims, verdicts, invalidRefs);
  const cases: CaseAssessment[] = draft.cases.map((item) => {
    const outcomeClaimsValid = item.outcomeClaimIds.length > 0 && keepAll(item.outcomeClaimIds, checked.accepted);
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
      const accepted = work !== undefined && keepAll(work.claimIds, checked.accepted)
        && !(work.disposition === "reuse" && (work.blockerClaimIds.length > 0 || work.verificationClaimIds.length > 0));
      return {
        artifactId: artifact.artifactId,
        availability,
        exclusionReasons,
        disposition: accepted ? work.disposition : null,
        dispositionClaimId: accepted ? work.dispositionClaimId : null,
        claimIds: accepted ? work.claimIds : [],
        blockerClaimIds: accepted ? work.blockerClaimIds : [],
        verificationClaimIds: accepted ? work.verificationClaimIds : [],
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
  const conclusion = leads.length > 0 ? "precedent_found" : complete && checked.withheld === 0 ? "no_useful_precedent" : "cannot_be_established";
  return {
    conclusion,
    clarifyingClaimIds: draft.clarifyingClaimIds.filter((id) => checked.accepted.has(id)),
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

export function buildCheckedBrief(draft: BriefDraft, verdicts: Map<string, SupportVerdict>, invalidRefs: Set<string>): BriefResult {
  const checked = supportedClaims(draft.claims, verdicts, invalidRefs);
  const keep = (items: BriefDraft["reuse"], disposition: BriefDisposition) => items.flatMap((item) => {
    if (!keepAll(item.claimIds, checked.accepted)) return [];
    return [{ ...item, disposition }];
  });
  return {
    reuse: keep(draft.reuse, "reuse"),
    adapt: keep(draft.adapt, "adapt"),
    verify: keep(draft.verify, "verify"),
    claims: checked.visible,
    withheldClaimCount: checked.withheld,
  };
}
