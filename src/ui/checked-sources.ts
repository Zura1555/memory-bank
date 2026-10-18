import type { ArtifactAssessment, CaseAvailability, Claim, SourceRef } from "../shared/protocol.ts";

// Checked claims pin source versions; selection may use any verified original passage in those versions.
export function checkedArtifactRefs(caseId: string, availability: CaseAvailability, item: ArtifactAssessment, claims: Map<string, Claim>): SourceRef[] {
  if (item.availability === "unavailable" || !["available", "partial"].includes(availability)) return [];
  const refs = new Map<string, SourceRef>();
  for (const id of item.claimIds) {
    for (const ref of claims.get(id)?.sourceRefs ?? []) {
      if (ref.caseId === caseId && ref.artifactId === item.artifactId) {
        refs.set(`${ref.versionId}\u0000${ref.passageId}`, ref);
      }
    }
  }
  return [...refs.values()];
}
