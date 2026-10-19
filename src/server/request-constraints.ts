import type { AssessmentResult, Claim } from "../shared/protocol.ts";

export interface RequestSpan {
  spanId: string;
  sentenceId: string;
  start: number;
  end: number;
  text: string;
  coverageIds: string[];
}

// Offsets and bounds are UTF-16, like String.slice and the stored quotation limit.
// A selected clause never certifies only the front of its owning sentence.
export function requestSpans(request: string): RequestSpan[] {
  const spans: RequestSpan[] = [];
  for (const { segment, index } of new Intl.Segmenter("en", { granularity: "sentence" }).segment(request)) {
    const sentenceId = `sentence-${index}`;
    const start = index + segment.length - segment.trimStart().length;
    const end = index + segment.trimEnd().length;
    let cursor = start;
    const sentence: RequestSpan[] = [];
    while (cursor < end) {
      let stop = end;
      if (end - cursor > 500) {
        const window = request.slice(cursor, cursor + 501);
        // Prefer a complete clause; otherwise a word boundary. Never cut a word,
        // surrogate pair or combining sequence just to meet the quotation bound.
        const clauses = [...window.matchAll(/[,;:]\s+|\s+(?=(?:and|but|unless|until|when|provided|without)\b)/giu)];
        const words = [...window.matchAll(/\s+/gu)];
        const boundary = clauses.filter((match) => match.index! > 0 && match.index! + match[0].length <= 500).at(-1)
          ?? words.filter((match) => match.index! > 0 && match.index! <= 500).at(-1);
        if (!boundary) throw new Error("REQUEST_QUOTATION_TOKEN_TOO_LONG");
        stop = cursor + boundary.index!;
        if (/^[,;:]/u.test(boundary[0])) stop++;
      }
      const text = request.slice(cursor, stop).trimEnd();
      const spanEnd = cursor + text.length;
      sentence.push({ spanId: `quote-${cursor}-${spanEnd}`, sentenceId, start: cursor, end: spanEnd, text, coverageIds: [] });
      cursor = stop;
      while (cursor < end && /\s/u.test(request[cursor])) cursor++;
    }
    const coverageIds = sentence.map((span) => span.spanId);
    for (const span of sentence) span.coverageIds = coverageIds;
    spans.push(...sentence);
  }
  if (!spans.length) throw new Error("REQUEST_QUOTATION_REQUIRED");
  return spans;
}

export function completeRequestQuotes(request: string, quotes: string[]): string[] {
  const spans = requestSpans(request);
  const intervals = quotes.flatMap((quote) => {
    if (!quote || !request.includes(quote)) throw new Error("INVALID_REQUEST_QUOTATION");
    const matches: { start: number; end: number }[] = [];
    for (let start = request.indexOf(quote); start >= 0; start = request.indexOf(quote, start + 1)) {
      matches.push({ start, end: start + quote.length });
    }
    return matches;
  });
  const sentences = new Set(spans.filter((span) => intervals.some((interval) =>
    interval.start < span.end && interval.end > span.start,
  )).map((span) => span.sentenceId));
  return [...new Set(spans.filter((span) => sentences.has(span.sentenceId)).map((span) => span.text))];
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
