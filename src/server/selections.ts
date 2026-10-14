import type { AssessmentResult, Selection } from "../shared/protocol.ts";
import type { CorpusSnapshot } from "./corpus.ts";
import { HttpFailure } from "./errors.ts";

export function validateSelections(selections: Selection[], assessment: AssessmentResult, corpus: CorpusSnapshot): Selection[] {
  if (selections.length === 0 || selections.length > 32) throw new HttpFailure(422, "INVALID_SELECTION_COUNT");
  const claims = new Map(assessment.claims.map((claim) => [claim.claimId, claim]));
  const seen = new Set<string>();
  for (const selection of selections) {
    const key = `${selection.caseId}/${selection.artifactId}/${selection.versionId}`;
    if (seen.has(key) || new Set(selection.passageIds).size !== selection.passageIds.length) throw new HttpFailure(422, "DUPLICATE_SELECTION");
    seen.add(key);
    const caseResult = assessment.cases.find((item) => item.caseId === selection.caseId);
    const work = caseResult?.artifactWork.find((item) => item.artifactId === selection.artifactId);
    const source = corpus.versions.get(selection.versionId);
    if (!work || !source || source.pastCase.caseId !== selection.caseId || source.artifact.artifactId !== selection.artifactId || source.version.extractionStatus !== "complete" || !corpus.availableVersions.has(selection.versionId)) {
      throw new HttpFailure(422, "UNAVAILABLE_OR_UNCHECKED_SELECTION");
    }
    const cited = new Set<string>();
    for (const claimId of work.claimIds) {
      const claim = claims.get(claimId);
      for (const ref of claim?.sourceRefs ?? []) {
        if (ref.caseId === selection.caseId && ref.artifactId === selection.artifactId && ref.versionId === selection.versionId) cited.add(ref.passageId);
      }
    }
    if (selection.passageIds.length === 0 || selection.passageIds.some((passageId) => {
      const passage = corpus.passages.get(passageId);
      return !cited.has(passageId) || !passage || passage.caseId !== selection.caseId || passage.artifactId !== selection.artifactId || passage.versionId !== selection.versionId;
    })) throw new HttpFailure(422, "INVALID_SELECTION_PASSAGE");
  }
  return selections;
}
