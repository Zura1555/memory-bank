import type { AssessmentResult, Selection } from "../shared/protocol.ts";
import type { CorpusSnapshot } from "./corpus.ts";
import { HttpFailure } from "./errors.ts";

export function validateSelections(selections: Selection[], assessment: AssessmentResult, corpus: CorpusSnapshot): Selection[] {
  if (selections.length === 0 || selections.length > 32) throw new HttpFailure(422, "INVALID_SELECTION_COUNT");
  const claims = new Map(assessment.claims.map((claim) => [claim.claimId, claim]));
  if (claims.size !== assessment.claims.length) throw new HttpFailure(422, "UNAVAILABLE_OR_UNCHECKED_SELECTION");
  const seen = new Set<string>();
  for (const selection of selections) {
    const key = JSON.stringify([selection.caseId, selection.artifactId, selection.versionId]);
    if (seen.has(key) || new Set(selection.passageIds).size !== selection.passageIds.length) throw new HttpFailure(422, "DUPLICATE_SELECTION");
    seen.add(key);
    const cases = assessment.cases.filter((item) => item.caseId === selection.caseId);
    const caseResult = cases.length === 1 ? cases[0] : undefined;
    const works = caseResult?.artifactWork.filter((item) => item.artifactId === selection.artifactId) ?? [];
    const work = works.length === 1 ? works[0] : undefined;
    const reviews = assessment.artifactReviews.filter((item) => item.caseId === selection.caseId && item.artifactId === selection.artifactId);
    const source = corpus.versions.get(selection.versionId);
    const dispositionId = work?.dispositionClaimId;
    const disposition = dispositionId ? claims.get(dispositionId) : undefined;
    const exactVersionWitnessed = work?.claimIds.some((claimId) => claims.get(claimId)?.sourceRefs.some((ref) =>
      ref.caseId === selection.caseId && ref.artifactId === selection.artifactId && ref.versionId === selection.versionId,
    )) ?? false;
    if (!caseResult || caseResult.availability === "unavailable" || caseResult.availability === "failed"
      || !work || work.availability === "unavailable" || work.disposition === null || !dispositionId
      || !work.claimIds.includes(dispositionId)
      || disposition?.kind !== "recommendation"
      || reviews.length !== 1 || reviews[0].role !== "starting_point" || reviews[0].verdict !== "supported"
      || reviews[0].decision.disposition !== work.disposition
      || !Array.isArray(reviews[0].claimFindings)
      || reviews[0].claimFindings.length !== work.claimIds.filter((id) => id !== dispositionId).length
      || new Set(reviews[0].claimFindings.map((finding) => finding.claimId)).size !== reviews[0].claimFindings.length
      || reviews[0].claimFindings.some((finding) => finding.verdict !== "supported" || finding.reason !== null
        || !work.claimIds.includes(finding.claimId) || !claims.has(finding.claimId))
      || !Array.isArray(reviews[0].decision.obligations)
      || reviews[0].decision.obligations.some((obligation) => !work.claimIds.includes(obligation.claimId)
        || !claims.has(obligation.claimId)
        || [...obligation.adaptationClaimIds, ...obligation.checkClaimIds].some((id) => !work.claimIds.includes(id) || !claims.has(id)))
      || !exactVersionWitnessed
      || !source || source.version.versionId !== selection.versionId
      || source.pastCase.caseId !== selection.caseId || source.artifact.artifactId !== selection.artifactId
      || source.version.extractionStatus !== "complete" || !corpus.availableVersions.has(selection.versionId)) {
      throw new HttpFailure(422, "UNAVAILABLE_OR_UNCHECKED_SELECTION");
    }
    if (selection.passageIds.length === 0 || selection.passageIds.some((passageId) => {
      const listed = source.version.passages.some((passage) => passage.passageId === passageId);
      const passage = corpus.passages.get(passageId);
      return !listed || !passage || passage.caseId !== selection.caseId || passage.artifactId !== selection.artifactId || passage.versionId !== selection.versionId;
    })) throw new HttpFailure(422, "INVALID_SELECTION_PASSAGE");
  }
  return selections;
}
