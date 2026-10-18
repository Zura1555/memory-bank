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
