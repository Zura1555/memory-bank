import assert from "node:assert/strict";
import test from "node:test";
import { reviewSchema, type ReviewTargets } from "./schemas.ts";
import { requestSpans } from "./request-constraints.ts";

// Synthetic claims and evidence only; no captured artifact content is reproduced here.
const request = "Require escalation for two business days after signed acceptance. Verify the witnessed checkpoint before handover.";
const caseId = "synthetic-case";
const artifactId = "synthetic-artifact";
const evidence = { caseId, artifactId, versionId: "synthetic-version", passageId: "synthetic-passage" };
const sourceRefs = { evidence };
const historyClaimId = "synthetic-history-claim";
const timingClaimId = "synthetic-timing-claim";
const checkpointClaimId = "synthetic-checkpoint-claim";
const obligationClaimId = "synthetic-obligation-claim";

function targets(overrides: Partial<ReviewTargets> = {}): ReviewTargets {
  return {
    claimIds: [historyClaimId, timingClaimId, checkpointClaimId, obligationClaimId],
    artifacts: [{
      caseId,
      artifactId,
      disposition: "adapt",
      operation: "recovery_handover",
      claimIds: {
        history: [historyClaimId],
        adaptation: [timingClaimId],
        check: [checkpointClaimId],
        obligation: [obligationClaimId],
      },
    }],
    sourceRefs,
    ...overrides,
  };
}

function wire(options: {
  judgments?: Record<string, unknown>;
  disposition?: "reuse" | "adapt" | "verify" | null;
  verdict?: "supported" | "unsupported" | "uncertain";
  reasons?: Record<string, unknown>[];
} = {}) {
  const judgments = Object.fromEntries(targets().claimIds.map((claimId) => [claimId, { verdict: "supported", reason: null }]));
  return {
    requestConstraints: {
      product_version: [], environment: [], scale: [], identity_access: [], recovery_operations: [],
    },
    missingEvidenceReview: { verdict: "supported", reason: null },
    claimJudgments: { ...judgments, ...options.judgments },
    decisions: {
      [`${caseId}/${artifactId}`]: {
        disposition: options.disposition === undefined ? "adapt" : options.disposition,
        role: "starting_point",
        verdict: options.verdict ?? "supported",
        reasons: options.reasons ?? [],
      },
    },
  };
}

function negativeFinding(quote?: string, verdict: "unsupported" | "uncertain" = "unsupported") {
  return {
    verdict,
    reason: {
      explanation: "Synthetic evidence does not establish this owned claim.",
      sourceRefs: ["evidence"],
      requestQuotes: quote ? [requestSpans(request).find((span) => span.text === quote)!.spanId] : [],
    },
  };
}

test("claim findings own claim defects; model decision reasons cannot duplicate them", () => {
  const schema = reviewSchema(targets(), request);
  const checkpoint = requestSpans(request).find((span) => span.text.includes("witnessed checkpoint"))!.text;
  const parsed = schema.parse(wire({
    judgments: { [checkpointClaimId]: negativeFinding(checkpoint) },
  }));
  assert.equal("artifactReviews" in parsed, true);
  if (!("artifactReviews" in parsed)) throw new Error("Expected assessment review.");
  const review = parsed.artifactReviews[0];
  assert.deepEqual(review.claimFindings.find((finding) => finding.claimId === checkpointClaimId), {
    claimId: checkpointClaimId,
    verdict: "unsupported",
    reason: {
      explanation: "Synthetic evidence does not establish this owned claim.",
      sourceRefs: [evidence],
      requestQuotes: [checkpoint],
    },
  });
  assert.deepEqual(review.reasons, [{
    target: "check",
    claimId: checkpointClaimId,
    explanation: "Synthetic evidence does not establish this owned claim.",
    sourceRefs: [evidence],
    requestQuotes: [checkpoint],
  }], "The parser derives one canonical claim-subject reason from its finding.");

  const firstRequestSpan = requestSpans(request)[0].text;
  for (const duplicate of [
    { target: "history", claimId: historyClaimId, quote: undefined },
    { target: "adaptation", claimId: timingClaimId, quote: firstRequestSpan },
    { target: "check", claimId: checkpointClaimId, quote: checkpoint },
  ]) {
    assert.equal(schema.safeParse(wire({
      judgments: { [duplicate.claimId]: negativeFinding(duplicate.quote) },
      verdict: "unsupported",
      reasons: [{
        target: duplicate.target,
        claimId: duplicate.claimId,
        explanation: "Model-authored duplicate claim rejection.",
        sourceRefs: ["evidence"],
        requestQuotes: duplicate.quote ? [requestSpans(request).find((span) => span.text === duplicate.quote)!.spanId] : [],
      }],
    })).success, false, `Model decision reasons cannot duplicate a ${duplicate.target} claim defect.`);
  }
  assert.equal(schema.safeParse(wire({
    judgments: {
      [checkpointClaimId]: {
        verdict: "supported",
        reason: {
          explanation: "A supported claim has no rejection reason.",
          sourceRefs: ["evidence"],
          requestQuotes: [],
        },
      },
    },
  })).success, false, "A canonical supported finding must have a null reason.");
});

test("supported history remains true counterevidence to an unsupported disposition", () => {
  const dispositionReason = {
    target: "disposition",
    explanation: "This recorded procedure does not establish current-client readiness.",
    sourceRefs: ["evidence"],
    requestQuotes: [],
  };
  const parsed = reviewSchema(targets(), request).parse(wire({
    verdict: "unsupported",
    reasons: [dispositionReason],
  }));
  assert.equal("artifactReviews" in parsed, true);
  if (!("artifactReviews" in parsed)) throw new Error("Expected assessment review.");
  const review = parsed.artifactReviews[0];
  assert.equal(review.verdict, "unsupported");
  assert.deepEqual(review.claimFindings.find((finding) => finding.claimId === historyClaimId), {
    claimId: historyClaimId, verdict: "supported", reason: null,
  });
  assert.deepEqual(review.reasons.map(({ target, claimId }) => ({ target, claimId })), [{ target: "disposition", claimId: undefined }]);
});

test("a supported numeric cap does not cover a separate nonnumeric item-identity requirement", () => {
  const combinedRequest = "Cap each batch at 20 records. Preserve the source identity for every item.";
  const requirement = "Preserve the source identity for every item.";
  const requirementSpan = requestSpans(combinedRequest).find((span) => span.text === requirement)!;
  const schema = reviewSchema(targets(), combinedRequest);
  const parsed = schema.parse({
    requestConstraints: {
      product_version: [], environment: [], scale: [requestSpans(combinedRequest)[0].spanId],
      identity_access: [requestSpans(combinedRequest)[1].spanId], recovery_operations: [],
    },
    missingEvidenceReview: { verdict: "supported", reason: null },
    claimJudgments: {
      [historyClaimId]: { verdict: "supported", reason: null },
      [timingClaimId]: { verdict: "supported", reason: null },
      [checkpointClaimId]: { verdict: "supported", reason: null },
      [obligationClaimId]: { verdict: "supported", reason: null },
    },
    decisions: {
      [`${caseId}/${artifactId}`]: {
        disposition: "adapt",
        role: "starting_point",
        verdict: "unsupported",
        reasons: [{
          target: "request_constraint",
          requirement,
          explanation: "The record does not establish preservation of each item's source identity.",
          sourceRefs: ["evidence"],
          requestQuotes: [requirementSpan.spanId],
        }],
      },
    },
  });
  assert.equal("artifactReviews" in parsed, true);
  if (!("artifactReviews" in parsed)) throw new Error("Expected assessment review.");
  assert.equal(parsed.artifactReviews[0].claimFindings.find((finding) => finding.claimId === timingClaimId)?.verdict, "supported");
  assert.deepEqual(parsed.artifactReviews[0].reasons[0], {
    target: "request_constraint",
    requirement,
    explanation: "The record does not establish preservation of each item's source identity.",
    sourceRefs: [evidence],
    requestQuotes: [requirement],
  });
});
