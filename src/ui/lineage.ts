import type { AssessmentResult, BriefDisposition, Claim } from "../shared/protocol.ts";

export interface DispositionChange {
  caseId: string;
  artifactId: string;
  before: BriefDisposition;
  after: BriefDisposition | null;
  previousClaim: Claim;
  currentClaim: Claim | null;
}

// Compare checked recommendations, not prose similarity or a claim of causation.
export function dispositionChanges(previous: AssessmentResult, current: AssessmentResult): DispositionChange[] {
  const previousClaims = new Map(previous.claims.map((claim) => [claim.claimId, claim]));
  const currentClaims = new Map(current.claims.map((claim) => [claim.claimId, claim]));
  const relevant = new Set([...previous.leads, ...current.leads].flatMap((lead) => lead.usefulArtifactIds.map((id) => `${lead.caseId}/${id}`)));
  return previous.cases.flatMap((item) => item.artifactWork.flatMap((old) => {
    if (!relevant.has(`${item.caseId}/${old.artifactId}`) || !old.disposition) return [];
    const work = current.cases.find((candidate) => candidate.caseId === item.caseId)?.artifactWork.find((candidate) => candidate.artifactId === old.artifactId);
    const previousClaim = old.dispositionClaimId ? previousClaims.get(old.dispositionClaimId) : undefined;
    const currentClaim = work?.dispositionClaimId ? currentClaims.get(work.dispositionClaimId) : undefined;
    if (previousClaim?.kind !== "recommendation") return [];
    const established = work?.disposition && currentClaim?.kind === "recommendation";
    if (established && old.disposition === work.disposition) return [];
    return [{
      caseId: item.caseId, artifactId: old.artifactId, before: old.disposition,
      after: established ? work.disposition : null, previousClaim, currentClaim: established ? currentClaim : null,
    }];
  }));
}
