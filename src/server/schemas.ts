import * as z from "zod";

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
const artifactClaim = claim.omit({ claimId: true });
const artifactWorkFields = {
  artifactId: id,
  usefulForLead: z.boolean(),
  recommendation: claim.omit({ claimId: true, kind: true }),
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
  outcomeClaimIds: z.array(id).max(16),
  claimIds: z.array(id).max(64),
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

export const assessmentDraftSchema = z.strictObject({
  cases: z.array(caseDraft).length(8),
  leads: z.array(lead.omit({ usefulArtifactIds: true })).max(3),
  contrasts: z.array(lead).max(8),
  clarifyingClaimIds: z.array(id).max(8),
  claims: z.array(claim).max(400),
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
export type AssessmentDraft = Omit<AssessmentOutput, "cases" | "leads"> & {
  cases: (Omit<AssessmentOutput["cases"][number], "artifactWork"> & { artifactWork: ArtifactWork[] })[];
  leads: z.infer<typeof lead>[];
};
export type BriefDraft = z.infer<typeof briefDraftSchema>;
export type SupportReview = z.infer<typeof supportReviewSchema>;
export type AssessmentReview = z.infer<typeof assessmentReviewSchema>;
export type Reference = z.infer<typeof sourceRef>;
export type ModelClaim = z.infer<typeof claim>;

export function parseAssessmentDraft(value: unknown): AssessmentDraft {
  const output = assessmentDraftSchema.parse(value);
  const claims = [...output.claims];
  const cases = output.cases.map((item, caseIndex) => ({
    ...item,
    artifactWork: item.artifactWork.map((work, workIndex) => {
      const dispositionClaimId = `disposition-${caseIndex}-${workIndex}`;
      claims.push({ ...work.recommendation, claimId: dispositionClaimId, kind: "recommendation" });
      const addClaims = (role: string, items: z.infer<typeof artifactClaim>[]): string[] => items.map((claim, index) => {
        const claimId = `artifact-${caseIndex}-${workIndex}-${role}-${index}`;
        claims.push({ ...claim, claimId });
        return claimId;
      });
      const supportingClaimIds = addClaims("support", work.supportingClaims);
      const blockerClaimIds = addClaims("blocker", work.blockerClaims);
      const verificationClaimIds = addClaims("verify", work.verificationClaims);
      return {
        artifactId: work.artifactId,
        disposition: work.disposition,
        dispositionClaimId,
        claimIds: [dispositionClaimId, ...supportingClaimIds, ...blockerClaimIds, ...verificationClaimIds],
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
  return { ...output, cases, leads, claims };
}

export function openRouterSchema(name: string, schema: z.ZodType): {
  type: "json_schema";
  json_schema: { name: string; strict: true; schema: Record<string, unknown> };
} {
  const generated = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  delete generated.$schema;
  return { type: "json_schema", json_schema: { name, strict: true, schema: generated } };
}
