import type { PassageView, SourceRef } from "../shared/protocol.ts";

export function isPassage(value: unknown, expected: SourceRef): value is PassageView {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const passage = value as Record<string, unknown>;
  const text = (item: unknown) => typeof item === "string" && item.length > 0;
  return passage.caseId === expected.caseId
    && passage.artifactId === expected.artifactId
    && passage.versionId === expected.versionId
    && passage.passageId === expected.passageId
    && text(passage.title)
    && passage.fictional === true
    && (passage.statedDate === null || text(passage.statedDate))
    && text(passage.excerpt)
    && ["native", "ocr_transcription", "visual_observation", "visual_interpretation"].includes(passage.sourceKind as string)
    && typeof passage.location === "object" && passage.location !== null && !Array.isArray(passage.location)
    && Object.values(passage.location).every((item) =>
      item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean"
      || (Array.isArray(item) && item.every((entry) => typeof entry === "string")));
}
