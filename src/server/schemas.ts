import * as z from "zod";
import type { BriefDisposition, ComparisonRow, Selection } from "../shared/protocol.ts";
import { assessmentPassageIds, type CorpusSnapshot } from "./corpus.ts";
import { completeRequestQuotes, requestSpans } from "./request-constraints.ts";
import { applySourceHistoryQualifications } from "./source-history.ts";

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
const globalAssessmentClaim = z.union([
  assessmentClaim.omit({ text: true }).extend({ caseId: id, outcomeEvidence: z.literal(false), kind: z.literal("interpretation") }),
  assessmentClaim.omit({ text: true }).extend({ caseId: id, outcomeEvidence: z.boolean(), kind: z.literal("source_fact"), sourceRefs: z.array(id).length(1), requestQuotes: z.array(claim.shape.requestQuotes.element).max(0) }),
]);
const artifactFact = assessmentClaim.omit({ claimId: true, text: true }).extend({
  kind: z.literal("source_fact"), sourceRefs: z.array(id).length(1), requestQuotes: z.array(claim.shape.requestQuotes.element).max(0),
});
const artifactAuthoredClaim = assessmentClaim.omit({ claimId: true }).extend({ kind: z.enum(["interpretation", "recommendation"]) });
const artifactClaim = z.union([artifactFact, artifactAuthoredClaim]);
function artifactWorkFor(sourceRefs: z.ZodType<string[], string[]>, requestQuotes: z.ZodType<string[], string[]> = assessmentClaim.shape.requestQuotes) {
  const authored = artifactAuthoredClaim.extend({ sourceRefs, requestQuotes });
  const localClaim = z.union([artifactFact.extend({ sourceRefs: sourceRefs.refine((refs) => refs.length === 1) }), authored]);
  const fields = {
    usefulForLead: z.boolean(),
    recommendation: assessmentClaim.omit({ claimId: true, kind: true }).extend({ sourceRefs, requestQuotes }),
    supportingClaims: z.array(localClaim).max(32),
    blockerClaims: z.array(localClaim).max(16),
    verificationClaims: z.array(authored.extend({ kind: z.literal("recommendation") })).max(16),
  };
  return z.union([
    z.strictObject({ disposition: z.literal("reuse"), ...fields, blockerClaims: z.array(localClaim).max(0), verificationClaims: z.array(localClaim).max(0) }),
    z.strictObject({ disposition: z.literal("adapt"), ...fields }),
    z.strictObject({ disposition: z.literal("verify"), ...fields, usefulForLead: z.literal(false), verificationClaims: z.array(authored.extend({ kind: z.literal("recommendation") })).min(1).max(16) }),
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
}).superRefine(({ request }, ctx) => {
  try { requestSpans(request); } catch {
    ctx.addIssue({ code: "custom", path: ["request"], message: "A request must have quotation spans no longer than 500 UTF-16 units without splitting a word." });
  }
});
export const passageSearchSchema = z.strictObject({
  query: z.string().trim().min(1).max(1024),
  caseId: id.optional(),
  mimeType: z.string().trim().min(1).max(128).optional(),
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
  product_version: claim.shape.requestQuotes.max(64),
  environment: claim.shape.requestQuotes.max(64),
  scale: claim.shape.requestQuotes.max(64),
  identity_access: claim.shape.requestQuotes.max(64),
  recovery_operations: claim.shape.requestQuotes.max(64),
});
const comparisonFields = {
  dimension: z.enum(["product_version", "environment", "scale", "identity_access", "recovery_operations"]),
  evidence: assessmentClaim.omit({ claimId: true, kind: true, text: true, dependsOnClaimIds: true }).extend({ sourceRefs: z.array(id).length(1) }),
  assessment: assessmentClaim.omit({ claimId: true, kind: true, text: true }),
  implication: z.strictObject({
    artifactId: id,
    effect: z.enum(["checked_decision", "context_only", "missing_evidence"]),
  }),
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
  claims: z.array(globalAssessmentClaim).max(400),
});

function requestQuoteIdentity(request: string) {
  const spans = requestSpans(request);
  return z.enum(spans.map((span) => span.spanId)).transform((spanId) => spans.find((span) => span.spanId === spanId)!.text);
}

function requestInventoryFor(request: string) {
  const quotes = z.array(requestQuoteIdentity(request)).max(64).transform((quotes) => completeRequestQuotes(request, quotes));
  return z.strictObject({ product_version: quotes, environment: quotes, scale: quotes, identity_access: quotes, recovery_operations: quotes });
}

export function assessmentDraftSchemaFor(request: string, sources: { caseId: string; artifacts: { artifactId: string; passageIds: string[] }[]; passageIds: string[] }[]) {
  const requestConstraints = requestInventoryFor(request);
  const requestQuotes = z.array(requestQuoteIdentity(request)).max(8);
  const scopedClaims = sources.filter((item) => item.passageIds.length > 0).flatMap((item) => {
    const scope = { caseId: z.literal(item.caseId), sourceRefs: z.array(z.enum(item.passageIds)).min(1).max(16) };
    return [
      globalAssessmentClaim.options[0].extend({ ...scope, requestQuotes }),
      globalAssessmentClaim.options[1].extend({ ...scope, sourceRefs: scope.sourceRefs.length(1) }),
    ];
  });
  const rankedCaseFor = (source: typeof sources[number]) => {
    const sourceRefs = z.array(source.passageIds.length ? z.enum(source.passageIds) : id).min(1).max(16);
    const ownComparison = z.union(comparison.options.map((option) => option.extend({
      requirementQuote: option.shape.requirementQuote instanceof z.ZodNull ? option.shape.requirementQuote : requestQuotes.element,
      evidence: comparisonFields.evidence.extend({ sourceRefs: sourceRefs.length(1), requestQuotes: z.array(requestQuotes.element).max(0) }),
      assessment: comparisonFields.assessment.extend({ sourceRefs, requestQuotes }),
      implication: comparisonFields.implication.extend({ artifactId: source.artifacts.length ? z.enum(source.artifacts.map((artifact) => artifact.artifactId)) : id }),
    })));
    const comparisons = z.array(ownComparison).max(source.passageIds.length ? 24 : 0);
    const reasons = z.array(artifactFact.extend({
      sourceRefs: sourceRefs.length(1), kind: z.literal("source_fact"), requestQuotes: z.array(requestQuotes.element).max(0),
    })).min(1).max(16);
    const caseFields = {
      outcome: caseDraft.shape.outcome,
      artifactWork: z.strictObject(Object.fromEntries(source.artifacts.map((artifact) => [
        artifact.artifactId, artifactWorkFor(z.array(z.enum(artifact.passageIds)).min(1).max(16), requestQuotes),
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
    requestConstraints,
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

export function briefDraftSchemaFor(request: string, selected: Selection[], corpus: CorpusSnapshot, assessment: {
  cases: { caseId: string; artifactWork: { artifactId: string; disposition: BriefDisposition | null }[] }[];
}) {
  if (selected.length === 0) throw new Error("BRIEF_SELECTION_REQUIRED");
  const labels = assessmentPassageIds(corpus);
  const spans = requestSpans(request);
  const inventory = selected.map((item, itemIndex) => {
    const work = assessment.cases.find((candidate) => candidate.caseId === item.caseId)?.artifactWork.find((candidate) => candidate.artifactId === item.artifactId);
    if (!work?.disposition) throw new Error("BRIEF_CHECKED_DECISION_REQUIRED");
    const refs = new Map([...corpus.passages.values()].filter((passage) =>
      passage.caseId === item.caseId && passage.artifactId === item.artifactId && passage.versionId === item.versionId,
    ).map((passage) => [labels.get(passage.passageId)!, {
      caseId: passage.caseId, artifactId: passage.artifactId, versionId: passage.versionId, passageId: passage.passageId,
    }]));
    if (!refs.size) throw new Error("BRIEF_SELECTED_EVIDENCE_UNAVAILABLE");
    const authored = artifactAuthoredClaim.extend({
      sourceRefs: z.array(z.enum([...refs.keys()])).min(1).max(16),
      requestQuotes: z.array(requestQuoteIdentity(request)).max(1),
      text: z.string().min(1).max(3_499),
    });
    const local = z.union([artifactFact.extend({ sourceRefs: authored.shape.sourceRefs.length(1) }), authored]);
    const schema = z.strictObject({
      disposition: z.literal(work.disposition),
      recommendation: authored.omit({ kind: true }),
      claims: z.array(local).max(31),
    });
    return { key: `${item.caseId}/${item.artifactId}/${item.versionId}`, item, itemIndex, refs, schema };
  });
  return z.strictObject({
    items: z.strictObject(Object.fromEntries(inventory.map(({ key, schema }) => [key, schema]))),
  }).transform(({ items }, ctx) => {
    const claims: z.infer<typeof claim>[] = [];
    const entries = inventory.map(({ key, item, itemIndex, refs }) => {
      const decision = items[key];
      const dispositionClaimId = `brief-${itemIndex}-disposition`;
      const inline = [{ ...decision.recommendation, kind: "recommendation" as const }, ...decision.claims];
      const claimIds = inline.map((value, index) => {
        const claimId = index === 0 ? dispositionClaimId : `brief-${itemIndex}-claim-${index - 1}`;
        const sourceRefs = value.sourceRefs.map((label) => refs.get(label)!);
        const text = value.kind === "source_fact"
          ? sourceRefs.map((ref) => corpus.passages.get(ref.passageId)!.excerpt).join("\n")
          : value.requestQuotes.length === 1 && !value.text.includes(value.requestQuotes[0])
            ? `${value.requestQuotes[0]} ${value.text}` : value.text;
        if (spans.some((span) => text.includes(span.text) && !value.requestQuotes.includes(span.text)) && value.kind !== "source_fact") {
          ctx.addIssue({ code: "custom", path: ["items", key, index === 0 ? "recommendation" : "claims", ...(index === 0 ? [] : [index - 1]), "text"], message: "UNDECLARED_REQUEST_QUOTATION" });
        }
        claims.push({
          ...value, claimId, text, sourceRefs,
          dependsOnClaimIds: [...new Set([...value.dependsOnClaimIds, ...(index > 0 && value.kind !== "source_fact" ? [dispositionClaimId] : [])])],
        });
        return claimId;
      });
      return { caseId: item.caseId, artifactId: item.artifactId, versionId: item.versionId, disposition: decision.disposition, dispositionClaimId, claimIds };
    });
    const qualified = applySourceHistoryQualifications(corpus, claims);
    const originalIds = new Set(claims.map((claim) => claim.claimId));
    const qualifications = qualified.filter((claim) => !originalIds.has(claim.claimId));
    for (const item of entries) {
      const owned = qualified.filter((claim) => item.claimIds.includes(claim.claimId));
      item.claimIds.push(...qualifications.filter((qualification) => owned.some((claim) => claim.dependsOnClaimIds.includes(qualification.claimId))).map((claim) => claim.claimId));
    }
    return {
      reuse: entries.filter((item) => item.disposition === "reuse"),
      adapt: entries.filter((item) => item.disposition === "adapt"),
      verify: entries.filter((item) => item.disposition === "verify"),
      claims: qualified,
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
    // Wider than the model inventory: checked assessment quotations are added before storage.
    requestQuotes: z.array(z.string().min(1).max(500)).max(64),
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
      constraintQuotes: z.strictObject(Object.fromEntries(entries.map(({ key }) => [key, z.array(requestQuoteIdentity(request)).max(64).transform((quotes) => completeRequestQuotes(request, quotes))]))),
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
  const sourceText = (refs: Reference[]) => refs.map((ref) => corpus.passages.get(ref.passageId)!.excerpt).join("\n");
  const claims: z.infer<typeof claim>[] = output.claims.map(({ caseId: _, outcomeEvidence: __, ...item }) => {
    const sourceRefs = resolveRefs(item.sourceRefs);
    return {
      ...item, sourceRefs,
      text: item.kind === "source_fact" ? sourceText(sourceRefs) : `The current request states: ${item.requestQuotes.map((quote) => JSON.stringify(quote)).join(" ")}`,
    };
  });
  const ownedComparisons = [...output.leads, ...output.contrasts].flatMap(({ caseId, comparisons }) => comparisons.map((row) => ({ ...row, caseId })));
  if (ownedComparisons.length > 24) throw new z.ZodError([{ code: "custom", path: ["comparisons"], message: "At most 24 decisive comparisons are allowed across all leads and contrasts." }]);
  const comparisons: ComparisonRow[] = ownedComparisons.map(({ requirementQuote, evidence, assessment, implication, ...row }, index) => {
    const evidenceClaimId = `comparison-${index}-evidence`;
    const evidenceRefs = resolveRefs(evidence.sourceRefs);
    claims.push({ ...evidence, text: sourceText(evidenceRefs), sourceRefs: evidenceRefs, claimId: evidenceClaimId, kind: "source_fact", dependsOnClaimIds: [] });
    const assessmentRefs = resolveRefs(assessment.sourceRefs);
    const requirementClaimId = requirementQuote === null ? null : `comparison-${index}-requirement`;
    if (requirementClaimId !== null && requirementQuote !== null) claims.push({
      claimId: requirementClaimId, text: `The current request states: ${JSON.stringify(requirementQuote)}.`, kind: "interpretation",
      sourceRefs: assessmentRefs, requestQuotes: [requirementQuote], dependsOnClaimIds: [],
    });
    const assessmentClaimId = `comparison-${index}-assessment`;
    const implicationClaimId = `comparison-${index}-implication`;
    const caseIndex = output.cases.findIndex((item) => item.caseId === row.caseId);
    const workIndex = output.cases[caseIndex]?.artifactWork.findIndex((work) => work.artifactId === implication.artifactId) ?? -1;
    if (workIndex < 0) throw new Error("UNKNOWN_IMPLICATION_ARTIFACT");
    const work = output.cases[caseIndex].artifactWork[workIndex];
    const dispositionId = `disposition-${caseIndex}-${workIndex}`;
    const decisionDependencies = implication.effect === "checked_decision" ? [dispositionId, `classification-${dispositionId}`] : [];
    const implicationText = implication.effect === "checked_decision"
      ? `Checked artifact decision: ${work.recommendation.text}`
      : implication.effect === "context_only" ? "Context only; no implementation starting work is offered."
        : "Missing evidence must be obtained before a starting-work decision; no implementation starting work is offered.";
    claims.push(
      { ...assessment, text: `Recorded evidence has relation ${row.relation} to the current ${row.dimension} requirement; unestablished applicability remains unknown.`, sourceRefs: assessmentRefs, claimId: assessmentClaimId, kind: "interpretation", dependsOnClaimIds: [...new Set([...assessment.dependsOnClaimIds, evidenceClaimId, ...(requirementClaimId === null ? [] : [requirementClaimId])])] },
      { text: implicationText, sourceRefs: resolveRefs(work.recommendation.sourceRefs), requestQuotes: work.recommendation.requestQuotes, claimId: implicationClaimId, kind: implication.effect === "checked_decision" ? "recommendation" : "interpretation", dependsOnClaimIds: [assessmentClaimId, ...decisionDependencies] },
    );
    return { ...row, artifactId: implication.artifactId, implicationEffect: implication.effect, evidenceClaimId, requirementClaimId, assessmentClaimId, implicationClaimId };
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
      claims.push({ ...work.recommendation, text: work.disposition === null ? "This artifact is excluded; no implementation starting work is offered." : work.recommendation.text, sourceRefs: resolveRefs(work.recommendation.sourceRefs), claimId: dispositionClaimId, kind: work.disposition === null ? "interpretation" : "recommendation" });
      const addClaims = (role: string, items: z.infer<typeof artifactClaim>[]): string[] => items.map((claim, index) => {
        const claimId = `artifact-${caseIndex}-${workIndex}-${role}-${index}`;
        const sourceRefs = resolveRefs(claim.sourceRefs);
        claims.push({
          ...claim, sourceRefs, claimId, text: claim.kind === "source_fact" ? sourceText(sourceRefs) : claim.text,
          dependsOnClaimIds: [...new Set([...claim.dependsOnClaimIds, ...(claim.kind === "source_fact" ? [] : [dispositionClaimId])])],
        });
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
        // The classification is a server-generated label of the disposition
        // recommendation alone. Depending on every supporting/blocker/
        // verification claim made one peripheral withheld claim erase the
        // independently reviewed disposition through dependency closure;
        // those claims are reviewed and filtered individually instead.
        dependsOnClaimIds: [dispositionClaimId],
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
  const qualified = applySourceHistoryQualifications(corpus, claims);
  const originalIds = new Set(claims.map((claim) => claim.claimId));
  for (const item of cases) item.claimIds.push(...qualified.filter((claim) => !originalIds.has(claim.claimId)
    && claim.sourceRefs.some((ref) => ref.caseId === item.caseId)).map((claim) => claim.claimId));
  return { ...output, cases, leads, contrasts, comparisons, claims: qualified };
}

export function openRouterSchema(name: string, schema: z.ZodType): {
  type: "json_schema";
  json_schema: { name: string; strict: true; schema: Record<string, unknown> };
} {
  const generated = z.toJSONSchema(schema, { target: "draft-7", io: "input", reused: "ref" }) as Record<string, unknown>;
  delete generated.$schema;
  return { type: "json_schema", json_schema: { name, strict: true, schema: generated } };
}
