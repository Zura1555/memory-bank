import * as z from "zod";
import type { ComparisonRow, Selection } from "../shared/protocol.ts";
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
function artifactWorkFor(sourceRefs: z.ZodType<string[], string[]>) {
  const localClaim = artifactClaim.extend({ sourceRefs });
  const fields = {
    usefulForLead: z.boolean(),
    recommendation: assessmentClaim.omit({ claimId: true, kind: true }).extend({ sourceRefs }),
    supportingClaims: z.array(localClaim).max(32),
    blockerClaims: z.array(localClaim).max(16),
    verificationClaims: z.array(localClaim.extend({ kind: z.literal("recommendation") })).max(16),
  };
  return z.union([
    z.strictObject({ disposition: z.literal("reuse"), ...fields, blockerClaims: z.array(localClaim).max(0), verificationClaims: z.array(localClaim).max(0) }),
    z.strictObject({ disposition: z.literal("adapt"), ...fields }),
    z.strictObject({ disposition: z.literal("verify"), ...fields, usefulForLead: z.literal(false), verificationClaims: z.array(localClaim.extend({ kind: z.literal("recommendation") })).min(1).max(16) }),
    z.strictObject({ disposition: z.null(), ...fields, usefulForLead: z.literal(false), recommendation: fields.recommendation.extend({ dependsOnClaimIds: z.array(id).max(0) }), supportingClaims: z.array(localClaim).max(0), blockerClaims: z.array(localClaim).max(0), verificationClaims: z.array(localClaim).max(0) }),
  ]);
}
const artifactWork = z.union(artifactWorkFor(assessmentClaim.shape.sourceRefs).options.map((option) => option.extend({ artifactId: id })));
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
  leads: z.array(lead.omit({ usefulArtifactIds: true }).extend({ comparisons: z.array(comparison).max(24) })).max(3),
  contrasts: z.array(lead.extend({ comparisons: z.array(comparison).max(24) })).max(8),
  clarifyingClaimIds: z.array(id).max(8),
  claims: z.array(z.union([
    assessmentClaim.extend({ caseId: id, outcomeEvidence: z.literal(false) }),
    assessmentClaim.extend({ caseId: id, outcomeEvidence: z.literal(true), kind: z.literal("source_fact") }),
  ])).max(400),
});

function requestInventoryFor(request: string) {
  const sentences = [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(request)];
  // 250 Unicode code points always fit the existing 500 UTF-16-unit quotation bound.
  const excerpts = [...new Set([
    ...(request.length <= 500 ? [request] : []),
    ...sentences.flatMap(({ segment }) => segment.trim().match(/[\s\S]{1,250}/gu) ?? []).map((text) => text.trim()).filter(Boolean),
  ])];
  const quotes = z.array(z.enum(excerpts)).max(8);
  return z.strictObject({ product_version: quotes, environment: quotes, scale: quotes, identity_access: quotes, recovery_operations: quotes });
}

export function assessmentDraftSchemaFor(request: string, sources: { caseId: string; artifacts: { artifactId: string; passageIds: string[] }[]; passageIds: string[] }[]) {
  const scopedClaims = sources.filter((item) => item.passageIds.length > 0).flatMap((item) => {
    const scope = { caseId: z.literal(item.caseId), sourceRefs: z.array(z.enum(item.passageIds)).min(1).max(16) };
    return [
      assessmentClaim.extend({ ...scope, outcomeEvidence: z.literal(false) }),
      assessmentClaim.extend({ ...scope, outcomeEvidence: z.literal(true), kind: z.literal("source_fact") }),
    ];
  });
  const rankedCaseFor = (source: typeof sources[number]) => {
    const sourceRefs = z.array(source.passageIds.length ? z.enum(source.passageIds) : id).min(1).max(16);
    const ownComparison = z.union(comparison.options.map((option) => option.extend({
      evidence: comparisonFields.evidence.extend({ sourceRefs }),
      assessment: comparisonFields.assessment.extend({ sourceRefs }),
      implication: comparisonFields.implication.extend({ sourceRefs }),
    })));
    const comparisons = z.array(ownComparison).max(source.passageIds.length ? 24 : 0);
    const reasons = z.array(artifactClaim.extend({ sourceRefs })).min(1).max(16);
    const caseFields = {
      outcome: caseDraft.shape.outcome,
      artifactWork: z.strictObject(Object.fromEntries(source.artifacts.map((artifact) => [
        artifact.artifactId, artifactWorkFor(z.array(z.enum(artifact.passageIds)).min(1).max(16)),
      ]))),
    };
    return z.union([
      z.strictObject({ ...caseFields, tier: z.literal("lead"), state: lead.shape.state, reasons, comparisons }),
      z.strictObject({ ...caseFields, tier: z.literal("contrast"), state: lead.shape.state, reasons, comparisons }),
      z.strictObject({ ...caseFields, tier: z.literal("context") }),
    ]);
  };
  const cases = z.strictObject(Object.fromEntries(sources.map((item) => [item.caseId, rankedCaseFor(item)])));
  return assessmentDraftSchema.omit({ leads: true, contrasts: true }).extend({
    requestConstraints: requestInventoryFor(request),
    cases,
    claims: scopedClaims.length ? z.array(z.union(scopedClaims)).max(400) : assessmentDraftSchema.shape.claims.max(0),
  }).transform(({ cases, ...output }) => {
    const normalizedCases = sources.map(({ caseId, artifacts }) => {
      const item = cases[caseId];
      return {
        caseId,
        outcome: item.outcome,
        artifactWork: artifacts.map(({ artifactId }) => ({ artifactId, ...item.artifactWork[artifactId] })),
      };
    });
    return {
      ...output,
      claims: [...output.claims, ...sources.flatMap(({ caseId }, caseIndex) => {
        const item = cases[caseId];
        return item.tier === "context" ? [] : item.reasons.map((reason, index) => ({
          ...reason, caseId, claimId: `reason-${caseIndex}-${index}`, outcomeEvidence: false,
        }));
      })],
      cases: normalizedCases,
      leads: sources.flatMap(({ caseId }, caseIndex) => {
        const item = cases[caseId];
        return item.tier === "lead" ? [{
          caseId, state: item.state, reasonClaimIds: item.reasons.map((_, index) => `reason-${caseIndex}-${index}`), comparisons: item.comparisons,
        }] : [];
      }),
      contrasts: sources.flatMap(({ caseId, artifacts }, caseIndex) => {
        const item = cases[caseId];
        return item.tier === "contrast" ? [{
          caseId, state: item.state, reasonClaimIds: item.reasons.map((_, index) => `reason-${caseIndex}-${index}`),
          usefulArtifactIds: artifacts.filter(({ artifactId }) => item.artifactWork[artifactId].usefulForLead).map(({ artifactId }) => artifactId),
          comparisons: item.comparisons,
        }] : [];
      }),
    };
  }).pipe(assessmentDraftSchema);
}
export const briefDraftSchema = z.strictObject({
  reuse: z.array(briefItem).max(32),
  adapt: z.array(briefItem).max(32),
  verify: z.array(briefItem).max(32),
  claims: z.array(claim).max(400),
});

export function briefDraftSchemaFor(selected: Selection[], corpus: CorpusSnapshot) {
  if (selected.length === 0) throw new Error("BRIEF_SELECTION_REQUIRED");
  const inventory = selected.map((item) => ({ key: `${item.caseId}/${item.artifactId}/${item.versionId}`, item }));
  const selectedVersions = new Set(inventory.map(({ key }) => key));
  const labels = assessmentPassageIds(corpus);
  const refs = new Map([...corpus.passages.values()].filter((passage) =>
    selectedVersions.has(`${passage.caseId}/${passage.artifactId}/${passage.versionId}`),
  ).map((passage) => [labels.get(passage.passageId)!, {
    caseId: passage.caseId, artifactId: passage.artifactId, versionId: passage.versionId, passageId: passage.passageId,
  }]));
  if (refs.size === 0) throw new Error("BRIEF_SELECTED_EVIDENCE_UNAVAILABLE");
  const decision = briefItem.omit({ caseId: true, artifactId: true, versionId: true });
  return z.strictObject({
    items: z.strictObject(Object.fromEntries(inventory.map(({ key }) => [key, decision]))),
    claims: z.array(claim.extend({ sourceRefs: z.array(z.enum([...refs.keys()])).min(1).max(16) })).max(400),
  }).transform(({ items, claims }) => {
    const entries = inventory.map(({ key, item }) => ({
      caseId: item.caseId, artifactId: item.artifactId, versionId: item.versionId, ...items[key],
    }));
    return {
      reuse: entries.filter((item) => item.disposition === "reuse"),
      adapt: entries.filter((item) => item.disposition === "adapt"),
      verify: entries.filter((item) => item.disposition === "verify"),
      claims: claims.map((claim) => ({ ...claim, sourceRefs: claim.sourceRefs.map((label) => refs.get(label)!) })),
    };
  }).pipe(briefDraftSchema);
}
export const supportReviewSchema = z.strictObject({
  claimReviews: z.array(z.strictObject({
    claimId: id,
    verdict: z.enum(["supported", "unsupported", "uncertain"]),
  })).max(400),
});
export const briefSupportReviewSchema = supportReviewSchema.extend({
  constraintReviews: z.array(z.strictObject({
    caseId: id,
    artifactId: id,
    versionId: id,
    requestQuotes: claim.shape.requestQuotes,
  })).max(32),
});
export const artifactReviewsSchema = z.array(z.strictObject({
  caseId: id,
  artifactId: id,
  role: z.enum(["starting_point", "context_only", "not_relevant", "unresolved"]),
})).max(256);
export const assessmentReviewSchema = z.strictObject({
  requestConstraints: requestConstraintsSchema,
  artifactReviews: artifactReviewsSchema,
  claimReviews: supportReviewSchema.shape.claimReviews,
});

export interface ReviewTargets {
  claimIds: string[];
  artifacts?: { caseId: string; artifactId: string }[];
  selections?: Pick<Selection, "caseId" | "artifactId" | "versionId">[];
}

export function reviewSchema(targets: ReviewTargets, request: string) {
  const claimVerdicts = z.strictObject(Object.fromEntries(targets.claimIds.map((claimId) => [claimId, z.enum(["supported", "unsupported", "uncertain"])])));
  const normalizeClaims = (verdicts: z.infer<typeof claimVerdicts>) => targets.claimIds.map((claimId) => ({ claimId, verdict: verdicts[claimId] }));
  if (targets.selections) {
    const entries = targets.selections.map((item) => ({ item, key: `${item.caseId}/${item.artifactId}/${item.versionId}` }));
    return z.strictObject({
      constraintQuotes: z.strictObject(Object.fromEntries(entries.map(({ key }) => [key, claim.shape.requestQuotes]))),
      claimVerdicts,
    }).transform(({ constraintQuotes, claimVerdicts }) => ({
      constraintReviews: entries.map(({ item, key }) => ({
        caseId: item.caseId, artifactId: item.artifactId, versionId: item.versionId, requestQuotes: constraintQuotes[key],
      })),
      claimReviews: normalizeClaims(claimVerdicts),
    })).pipe(briefSupportReviewSchema);
  }
  if (!targets.artifacts) throw new Error("REVIEW_TARGETS_REQUIRED");
  return z.strictObject({
    requestConstraints: requestInventoryFor(request),
    artifactReviews: artifactReviewsSchema.length(targets.artifacts.length),
    claimVerdicts,
  }).transform(({ claimVerdicts, ...review }) => ({ ...review, claimReviews: normalizeClaims(claimVerdicts) })).pipe(assessmentReviewSchema);
}

export type AssessmentOutput = z.infer<typeof assessmentDraftSchema>;
type ArtifactWork = {
  artifactId: string;
  disposition: "reuse" | "adapt" | "verify" | null;
  dispositionClaimId: string;
  claimIds: string[];
  blockerClaimIds: string[];
  verificationClaimIds: string[];
};
export type AssessmentDraft = Omit<AssessmentOutput, "cases" | "leads" | "contrasts" | "claims"> & {
  cases: (Omit<AssessmentOutput["cases"][number], "artifactWork"> & { claimIds: string[]; outcomeClaimIds: string[]; artifactWork: ArtifactWork[] })[];
  claims: z.infer<typeof claim>[];
  leads: z.infer<typeof lead>[];
  contrasts: z.infer<typeof lead>[];
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
  const ownedComparisons = [...output.leads, ...output.contrasts].flatMap(({ caseId, comparisons }) => comparisons.map((row) => ({ ...row, caseId })));
  if (ownedComparisons.length > 24) throw new z.ZodError([{ code: "custom", path: ["comparisons"], message: "At most 24 decisive comparisons are allowed across all leads and contrasts." }]);
  const comparisons: ComparisonRow[] = ownedComparisons.map(({ requirementQuote, evidence, assessment, implication, ...row }, index) => {
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
    claimIds: [
      ...output.claims.filter((claim) => claim.caseId === item.caseId).map((claim) => claim.claimId),
      ...item.artifactWork.flatMap((work, workIndex) => work.disposition === null ? [`disposition-${caseIndex}-${workIndex}`] : []),
    ],
    outcomeClaimIds: outcomeClaimIdsByCase.get(item.caseId)!,
    artifactWork: item.artifactWork.map((work, workIndex) => {
      const dispositionClaimId = `disposition-${caseIndex}-${workIndex}`;
      claims.push({ ...work.recommendation, sourceRefs: resolveRefs(work.recommendation.sourceRefs), claimId: dispositionClaimId, kind: work.disposition === null ? "interpretation" : "recommendation" });
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
        text: `Artifact disposition: ${work.disposition === null ? "excluded" : work.disposition}.`,
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
  const leads = output.leads.map(({ comparisons: _, ...lead }) => ({
    ...lead,
    usefulArtifactIds: output.cases.find((item) => item.caseId === lead.caseId)?.artifactWork
      .filter((work) => work.usefulForLead).map((work) => work.artifactId) ?? [],
  }));
  const contrasts = output.contrasts.map(({ comparisons: _, ...contrast }) => contrast);
  return { ...output, cases, leads, contrasts, comparisons, claims };
}

export function openRouterSchema(name: string, schema: z.ZodType): {
  type: "json_schema";
  json_schema: { name: string; strict: true; schema: Record<string, unknown> };
} {
  const generated = z.toJSONSchema(schema, { target: "draft-7", io: "input", reused: "ref" }) as Record<string, unknown>;
  delete generated.$schema;
  return { type: "json_schema", json_schema: { name, strict: true, schema: generated } };
}
