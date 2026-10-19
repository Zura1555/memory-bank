import assert from "node:assert/strict";
import test from "node:test";
import { requestSpans, completeRequestQuotes } from "./request-constraints.ts";
import { requestSchema, reviewSchema } from "./schemas.ts";
import { buildCheckedBrief, revalidateBrief } from "./gates.ts";
import type { BriefDraft } from "./schemas.ts";
import type { CorpusSnapshot } from "./corpus.ts";

test("complete sentences fit the UTF-16 quotation bound without a 250-code-point cut", () => {
  for (const sentence of ["é".repeat(499) + ".", "😀".repeat(249) + "é.", "A ".repeat(160) + "requires terminal status before any resubmission."]) {
    const spans = requestSpans(sentence);
    assert.deepEqual(spans.map((span) => span.text), [sentence]);
    assert.equal(sentence.slice(spans[0].start, spans[0].end), sentence);
  }
  assert.equal(requestSchema.safeParse({ request: "x".repeat(501) }).success, false);
});

test("attached requests retain both quotation and attachment trust-boundary checks", () => {
  const attachmentIds = ["00000000-0000-4000-8000-000000000001"];
  assert.deepEqual(requestSchema.parse({ request: "Sandbox writes only.", attachmentIds }).attachmentIds, attachmentIds);
  assert.equal(requestSchema.safeParse({ request: "x".repeat(501), attachmentIds }).success, false);
  assert.equal(requestSchema.safeParse({ request: "Sandbox writes only.", attachmentIds: ["not-a-uuid"] }).success, false);
  assert.equal(requestSchema.safeParse({ request: "Sandbox writes only.", attachmentIds: Array(6).fill(attachmentIds[0]) }).success, false);
});

test("long sentences have stable clause spans and explicit complete coverage, including the decisive tail", () => {
  const request = `Use ${"a documented Unicode 😀 capability ".repeat(19)}; require bulk asynchronous processing and never use the retired route.`;
  const spans = requestSpans(request);
  assert.ok(spans.length > 1);
  for (const span of spans) {
    assert.ok(span.text.length <= 500);
    assert.equal(request.slice(span.start, span.end), span.text);
    assert.deepEqual(span.coverageIds, spans.map((item) => item.spanId));
    assert.ok(!/[\uD800-\uDBFF]$/u.test(span.text));
  }
  assert.deepEqual(requestSpans(request), spans);
  assert.deepEqual(completeRequestQuotes(request, [spans[0].text]), spans.map((span) => span.text));
  const target = { caseId: "case", artifactId: "artifact", versionId: "version" };
  const schema = reviewSchema({ claimIds: [], selections: [target] }, request);
  const review = schema.parse({ constraintQuotes: { "case/artifact/version": [spans[0].spanId] }, claimVerdicts: {} });
  assert.ok("constraintReviews" in review);
  assert.deepEqual(review.constraintReviews[0].requestQuotes, spans.map((span) => span.text));

  const ref = { ...target, passageId: "passage" };
  const draft: BriefDraft = {
    reuse: [], verify: [], adapt: [{ ...target, disposition: "adapt", dispositionClaimId: "decision", claimIds: ["decision"] }],
    claims: [{ claimId: "decision", kind: "recommendation", text: `${spans[0].text} Check this before adapting.`, sourceRefs: [ref], requestQuotes: [spans[0].text], dependsOnClaimIds: [] }],
  };
  const requirements = { request, constraintReviews: review.constraintReviews };
  assert.deepEqual(buildCheckedBrief(draft, new Map([["decision", "supported"]]), new Set(), requirements).adapt, []);
  // A stored first-fragment inventory is no more authoritative than fresh wire output.
  const stored = { ...draft, constraintReviews: [{ ...target, requestQuotes: [spans[0].text] }], withheldClaimCount: 0 };
  const corpus = { passages: new Map([["passage", ref]]), manifest: { cases: [] } } as unknown as CorpusSnapshot;
  assert.deepEqual(revalidateBrief(stored, request, corpus).adapt, []);
});
