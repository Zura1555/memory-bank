import * as z from "zod";
import type { ComparisonRow } from "../shared/protocol.ts";
import { assessmentPassageIds, type CorpusSnapshot } from "./corpus.ts";

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const sourceRef = z.strictObject({
  caseId: id,
  artifactId: id,
  versionId: id,
  passageId: id,
});
const claim = z.strictObject({
  claimId: id,
  text: z.string().min(1).max(4_000),
  kind: z.enum(["source_fact", "interpretation", "recommendation"]),
  sourceRefs: z.array(sourceRef).min(1).max(16),
  requestQuotes: z.array(z.string().min(1).max(500)).max(8),
  dependsOnClaimIds: z.array(id).max(32),
});
const assessmentClaim = claim.extend({ sourceRefs: z.array(id).min(1).max(16) });
const artifactClaim = assessmentClaim.omit({ claimId: true });
const artifactWorkFields = {
  artifactId: id,
  usefulForLead: z.boolean(),
  recommendation: assessmentClaim.omit({ claimId: true, kind: true }),
  supportingClaims: z.array(artifactClaim).max(32),
  blockerClaims: z.array(artifactClaim).max(16),
  verificationClaims: z.array(artifactClaim.extend({ kind: z.literal("recommendation") })).max(16),
};
// OpenAI accepts anyOf; Zod's discriminatedUnion emits unsupported oneOf.
const artifactWork = z.union([
  z.strictObject({ ...artifactWorkFields, disposition: z.literal("reuse"), blockerClaims: z.array(artifactClaim).max(0), verificationClaims: z.array(artifactClaim).max(0) }),
  z.strictObject({ ...artifactWorkFields, disposition: z.literal("adapt") }),
  z.strictObject({ ...artifactWorkFields, disposition: z.literal("verify"), usefulForLead: z.literal(false), verificationClaims: z.array(artifactClaim.extend({ kind: z.literal("recommendation") })).min(1).max(16) }),
]);
const caseDraft = z.strictObject({
  caseId: id,
  outcome: z.enum(["observed_success", "partial", "failed", "unknown"]),
  artifactWork: z.array(artifactWork).max(32),
});
const lead = z.strictObject({
  caseId: id,
  state: z.enum(["useful", "conditional", "partial"]),
  usefulArtifactIds: z.array(id).max(32),
  reasonClaimIds: z.array(id).min(1).max(16),
});
const briefItem = z.strictObject({
  artifactId: id,
  caseId: id,
  versionId: id,
  disposition: z.enum(["reuse", "adapt", "verify"]),
  dispositionClaimId: id,
  claimIds: z.array(id).min(1).max(32),
});

export const requestSchema = z.strictObject({
  request: z.string().trim().min(1).max(16 * 1024),
});
export const selectionSchema = z.strictObject({
  caseId: id,
  artifactId: id,
  versionId: id,
  passageIds: z.array(id).min(1).max(32),
});
export const startBriefSchema = z.strictObject({
  selections: z.array(selectionSchema).min(1).max(32),
});

export const requestConstraintsSchema = z.strictObject({
  product_version: claim.shape.requestQuotes,
  environment: claim.shape.requestQuotes,
  scale: claim.shape.requestQuotes,
  identity_access: claim.shape.requestQuotes,
  recovery_operations: claim.shape.requestQuotes,
});
const comparisonFields = {
  caseId: id,
  dimension: z.enum(["product_version", "environment", "scale", "identity_access", "recovery_operations"]),
  evidence: assessmentClaim.omit({ claimId: true, kind: true, dependsOnClaimIds: true }),
  assessment: assessmentClaim.omit({ claimId: true, kind: true, dependsOnClaimIds: true }),
  implication: assessmentClaim.omit({ claimId: true, kind: true, dependsOnClaimIds: true }),
};
const comparison = z.union([
  z.strictObject({ ...comparisonFields, requirementQuote: z.string().min(1).max(500), relation: z.enum(["match", "mismatch", "unknown"]) }),
  z.strictObject({ ...comparisonFields, requirementQuote: z.null(), relation: z.literal("unknown") }),
]);

export const assessmentDraftSchema = z.strictObject({
  requestConstraints: requestConstraintsSchema,
  cases: z.array(caseDraft).length(8),
  leads: z.array(lead.omit({ usefulArtifactIds: true })).max(3),
  contrasts: z.array(lead).max(8),
  clarifyingClaimIds: z.array(id).max(8),
  comparisons: z.array(comparison).max(24),
  claims: z.array(z.union([
    assessmentClaim.extend({ caseId: id, outcomeEvidence: z.literal(false) }),
    assessmentClaim.extend({ caseId: id, outcomeEvidence: z.literal(true), kind: z.literal("source_fact") }),
  ])).max(400),
});
export const briefDraftSchema = z.strictObject({
  reuse: z.array(briefItem).max(32),
  adapt: z.array(briefItem).max(32),
  verify: z.array(briefItem).max(32),
  claims: z.array(claim).max(400),
});
export const supportReviewSchema = z.strictObject({
  claimReviews: z.array(z.strictObject({
    claimId: id,
    verdict: z.enum(["supported", "unsupported", "uncertain"]),
  })).max(400),
});
export const assessmentReviewSchema = supportReviewSchema.extend({
  requestConstraints: requestConstraintsSchema,
  conclusion: z.enum(["precedent_found", "no_useful_precedent", "cannot_be_established"]),
  leadReviews: z.array(z.strictObject({
    caseId: id,
    artifactId: id,
    verdict: z.enum(["supported", "unsupported", "uncertain"]),
  })).max(96),
});

export interface ReviewTargets {
  claimIds: string[];
  leadArtifacts?: { caseId: string; artifactId: string }[];
}

export function reviewSchema(targets: ReviewTargets) {
  const claimReviews = z.array(z.strictObject({
    claimId: targets.claimIds.length ? z.enum(targets.claimIds) : id,
    verdict: z.enum(["supported", "unsupported", "uncertain"]),
  })).length(targets.claimIds.length);
  if (!targets.leadArtifacts) return supportReviewSchema.extend({ claimReviews });
  return assessmentReviewSchema.extend({
    claimReviews,
    conclusion: targets.leadArtifacts.length === 0
      ? z.enum(["no_useful_precedent", "cannot_be_established"])
      : assessmentReviewSchema.shape.conclusion,
    leadReviews: assessmentReviewSchema.shape.leadReviews.length(targets.leadArtifacts.length),
  });
}

export type AssessmentOutput = z.infer<typeof assessmentDraftSchema>;
type ArtifactWork = {
  artifactId: string;
  disposition: "reuse" | "adapt" | "verify";
  dispositionClaimId: string;
  claimIds: string[];
  blockerClaimIds: string[];
  verificationClaimIds: string[];
};
export type AssessmentDraft = Omit<AssessmentOutput, "cases" | "leads" | "comparisons" | "claims"> & {
  cases: (Omit<AssessmentOutput["cases"][number], "artifactWork"> & { claimIds: string[]; outcomeClaimIds: string[]; artifactWork: ArtifactWork[] })[];
  claims: z.infer<typeof claim>[];
  leads: z.infer<typeof lead>[];
  comparisons: ComparisonRow[];
};
export type BriefDraft = z.infer<typeof briefDraftSchema>;
export type SupportReview = z.infer<typeof supportReviewSchema>;
export type AssessmentReview = z.infer<typeof assessmentReviewSchema>;
export type Reference = z.infer<typeof sourceRef>;
export type ModelClaim = z.infer<typeof claim>;

export function parseAssessmentDraft(value: unknown, corpus: CorpusSnapshot): AssessmentDraft {
  const output = assessmentDraftSchema.parse(value);
  const canonicalIds = new Map([...assessmentPassageIds(corpus)].map(([canonical, wire]) => [wire, canonical]));
  const resolveRefs = (ids: string[]): Reference[] => ids.map((wireId) => {
    const canonicalId = canonicalIds.get(wireId);
    const passage = canonicalId === undefined ? undefined : corpus.passages.get(canonicalId);
    if (!passage) throw new z.ZodError([{ code: "custom", path: ["sourceRefs"], message: "Unknown or unavailable supplied passage identity." }]);
    return { caseId: passage.caseId, artifactId: passage.artifactId, versionId: passage.versionId, passageId: passage.passageId };
  });
  const claims: z.infer<typeof claim>[] = output.claims.map(({ caseId: _, outcomeEvidence: __, ...item }) => ({ ...item, sourceRefs: resolveRefs(item.sourceRefs) }));
  const comparisons: ComparisonRow[] = output.comparisons.map(({ requirementQuote, evidence, assessment, implication, ...row }, index) => {
    const evidenceClaimId = `comparison-${index}-evidence`;
    claims.push({ ...evidence, sourceRefs: resolveRefs(evidence.sourceRefs), claimId: evidenceClaimId, kind: "source_fact", dependsOnClaimIds: [] });
    const assessmentRefs = resolveRefs(assessment.sourceRefs);
    const requirementClaimId = requirementQuote === null ? null : `comparison-${index}-requirement`;
    if (requirementClaimId !== null && requirementQuote !== null) claims.push({
      claimId: requirementClaimId, text: `The current request states: ${JSON.stringify(requirementQuote)}.`, kind: "interpretation",
      sourceRefs: assessmentRefs, requestQuotes: [requirementQuote], dependsOnClaimIds: [],
    });
    const assessmentClaimId = `comparison-${index}-assessment`;
    const implicationClaimId = `comparison-${index}-implication`;
    claims.push(
      { ...assessment, sourceRefs: assessmentRefs, claimId: assessmentClaimId, kind: "interpretation", dependsOnClaimIds: [evidenceClaimId, ...(requirementClaimId === null ? [] : [requirementClaimId])] },
      { ...implication, sourceRefs: resolveRefs(implication.sourceRefs), claimId: implicationClaimId, kind: "recommendation", dependsOnClaimIds: [assessmentClaimId] },
    );
    return { ...row, evidenceClaimId, requirementClaimId, assessmentClaimId, implicationClaimId };
  });
  // Outcome facts and the classification are separate review targets.
  const outcomeClaimIdsByCase = new Map<string, string[]>();
  for (const [caseIndex, item] of output.cases.entries()) {
    const evidence = output.claims.filter((claim) => claim.caseId === item.caseId && claim.outcomeEvidence);
    const evidenceIds = evidence.map((claim) => claim.claimId);
    const classificationId = `outcome-${caseIndex}`;
    if (item.outcome !== "unknown" && evidence.length > 0) {
      claims.push({
        claimId: classificationId,
        text: `Observed case outcome: ${item.outcome}.`,
        kind: "interpretation",
        sourceRefs: resolveRefs([...new Set(evidence.flatMap((claim) => claim.sourceRefs))]),
        requestQuotes: [],
        dependsOnClaimIds: evidenceIds,
      });
      outcomeClaimIdsByCase.set(item.caseId, [...evidenceIds, classificationId]);
    } else {
      outcomeClaimIdsByCase.set(item.caseId, []);
    }
  }
  const cases = output.cases.map((item, caseIndex) => ({
    ...item,
    claimIds: output.claims.filter((claim) => claim.caseId === item.caseId).map((claim) => claim.claimId),
    outcomeClaimIds: outcomeClaimIdsByCase.get(item.caseId)!,
    artifactWork: item.artifactWork.map((work, workIndex) => {
      const dispositionClaimId = `disposition-${caseIndex}-${workIndex}`;
      claims.push({ ...work.recommendation, sourceRefs: resolveRefs(work.recommendation.sourceRefs), claimId: dispositionClaimId, kind: "recommendation" });
      const addClaims = (role: string, items: z.infer<typeof artifactClaim>[]): string[] => items.map((claim, index) => {
        const claimId = `artifact-${caseIndex}-${workIndex}-${role}-${index}`;
        claims.push({ ...claim, sourceRefs: resolveRefs(claim.sourceRefs), claimId });
        return claimId;
      });
      const supportingClaimIds = addClaims("support", work.supportingClaims);
      const blockerClaimIds = addClaims("blocker", work.blockerClaims);
      const verificationClaimIds = addClaims("verify", work.verificationClaims);
      const classificationId = `classification-${dispositionClaimId}`;
      const claimIds = [dispositionClaimId, ...supportingClaimIds, ...blockerClaimIds, ...verificationClaimIds];
      claims.push({
        claimId: classificationId,
        text: `Artifact disposition: ${work.disposition}.`,
        kind: "interpretation",
        sourceRefs: resolveRefs(work.recommendation.sourceRefs),
        requestQuotes: work.recommendation.requestQuotes,
        dependsOnClaimIds: claimIds,
      });
      return {
        artifactId: work.artifactId,
        disposition: work.disposition,
        dispositionClaimId,
        claimIds: [...claimIds, classificationId],
        blockerClaimIds,
        verificationClaimIds,
      };
    }),
  }));
  const leads = output.leads.map((lead) => ({
    ...lead,
    usefulArtifactIds: output.cases.find((item) => item.caseId === lead.caseId)?.artifactWork
      .filter((work) => work.usefulForLead).map((work) => work.artifactId) ?? [],
  }));
  return { ...output, cases, leads, comparisons, claims };
}

export function openRouterSchema(name: string, schema: z.ZodType): {
  type: "json_schema";
  json_schema: { name: string; strict: true; schema: Record<string, unknown> };
} {
  const generated = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  delete generated.$schema;
  return { type: "json_schema", json_schema: { name, strict: true, schema: generated } };
}
