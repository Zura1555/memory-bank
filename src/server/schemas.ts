import * as z from "zod";
import type { ArtifactDecision, AssessmentResult, BriefDisposition, ComparisonRow, Selection } from "../shared/protocol.ts";
import { OPERATION_CHECKS, REQUIRED_OPERATION_CHECKS, renderOperationCheck, type OperationKind } from "../shared/operations.ts";
import { assessmentPassageIds, type CorpusSnapshot } from "./corpus.ts";
import { boundAssessmentQuotes, completeRequestQuotes, requestSpans } from "./request-constraints.ts";
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
type OperationCheckKindTuple<Operation extends OperationKind> = [
  keyof typeof OPERATION_CHECKS[Operation] & string,
  ...(keyof typeof OPERATION_CHECKS[Operation] & string)[],
];
function operationSchemaFor<Operation extends OperationKind>(operation: Operation) {
  const kinds = Object.keys(OPERATION_CHECKS[operation]) as OperationCheckKindTuple<Operation>;
  return { identity: z.literal(operation), checkKind: z.enum(kinds) };
}
const operationSchemas = {
  api_adapter: operationSchemaFor("api_adapter"),
  recovery_handover: operationSchemaFor("recovery_handover"),
  data_mapping: operationSchemaFor("data_mapping"),
  access_provisioning: operationSchemaFor("access_provisioning"),
};
const unboundApiCheckKind = operationSchemas.api_adapter.checkKind.exclude(["client_operation_limits"]);
const operationLimitCheckKind = z.literal("client_operation_limits");
const unboundMappingCheckKind = operationSchemas.data_mapping.checkKind.exclude(["completion_feasibility"]);
const completionFeasibilityCheckKind = z.literal("completion_feasibility");
const conditionIndex = z.enum(["0", "1", "2", "3", "4", "5", "6", "7"]);
const noConditionIndexes = z.array(conditionIndex).max(0);
const unchangedObligationFields = { requiresAdaptation: z.literal(false), adaptationIndexes: noConditionIndexes };
function operationObligationFor<Operation extends OperationKind>(operation: Operation, requestQuote: z.ZodType<string, string>) {
  return z.strictObject({
    requestQuote,
    requirement: z.string().min(1).max(500),
    requiresAdaptation: z.boolean(),
    checkKind: operationSchemas[operation].checkKind.nullable(),
    adaptationIndexes: z.array(conditionIndex).max(8),
    checkIndexes: z.array(conditionIndex).max(8),
  });
}
function operationObligationsFor(requestQuote: z.ZodType<string, string>) {
  return {
    api_adapter: z.array(operationObligationFor("api_adapter", requestQuote)).max(16),
    recovery_handover: z.array(operationObligationFor("recovery_handover", requestQuote)).max(16),
    data_mapping: z.array(operationObligationFor("data_mapping", requestQuote)).max(16),
    access_provisioning: z.array(operationObligationFor("access_provisioning", requestQuote)).max(16),
  };
}
function operationCheckFor<Operation extends OperationKind>(operation: Operation, sourceRefs: z.ZodArray<z.ZodType<string, string>>, requestQuotes: z.ZodArray<z.ZodType<string, string>>) {
  const check = z.strictObject({ kind: operationSchemas[operation].checkKind, sourceRefs, requestQuotes });
  return operation === "api_adapter" ? z.union([
    check.extend({ kind: unboundApiCheckKind }),
    check.extend({ kind: operationLimitCheckKind, requestQuotes: z.array(requestQuotes.element).length(1) }),
  ]) : operation === "data_mapping" ? z.union([
    check.extend({ kind: unboundMappingCheckKind }),
    check.extend({ kind: completionFeasibilityCheckKind, requestQuotes: z.array(requestQuotes.element).length(1) }),
  ]) : check;
}
function artifactWorkFor(
  sourceRefs: z.ZodArray<z.ZodType<string, string>>,
  requestQuotes: z.ZodArray<z.ZodType<string, string>> = assessmentClaim.shape.requestQuotes,
  obligations = operationObligationsFor(requestQuotes.element),
) {
  const oneQuote = <Element extends z.ZodType<string, string>>(quotes: z.ZodArray<Element>) => z.array(quotes.element).max(1);
  const conditionFor = <Element extends z.ZodType<string, string>>(quotes: z.ZodArray<Element>) => z.strictObject({
    text: z.string().min(1).max(600),
    sourceRefs,
    requestQuotes: quotes,
  });
  const workFor = <Operation extends OperationKind>(operation: Operation) => {
    const condition = conditionFor(requestQuotes);
    const check = operationCheckFor(operation, sourceRefs, oneQuote(requestQuotes));
    const fields = {
      operation: operationSchemas[operation].identity, historicalEvidence: sourceRefs, requestQuotes,
      obligations: obligations[operation],
    };
    const unchangedObligation = obligations[operation].element.extend(unchangedObligationFields);
    return [
      z.strictObject({ disposition: z.literal("reuse"), ...fields, obligations: z.array(unchangedObligation.extend({ checkKind: z.null(), checkIndexes: noConditionIndexes })).max(16), adaptations: z.array(condition).max(0), checks: z.array(check).max(0) }),
      z.strictObject({ disposition: z.literal("adapt"), ...fields, adaptations: z.array(condition).min(1).max(8), checks: z.array(check).min(1).max(8) }),
      z.strictObject({ disposition: z.literal("verify"), ...fields, obligations: z.array(unchangedObligation).max(16), adaptations: z.array(condition).max(0), checks: z.array(check).min(1).max(8) }),
    ] as const;
  };
  const noChecks = z.array(operationCheckFor("api_adapter", sourceRefs, z.array(requestQuotes.element).max(1))).max(0);
  return z.union([
    ...workFor("api_adapter"),
    ...workFor("recovery_handover"),
    ...workFor("data_mapping"),
    ...workFor("access_provisioning"),
    z.strictObject({
      disposition: z.null(), operation: z.null(), historicalEvidence: sourceRefs, requestQuotes,
      adaptations: z.array(conditionFor(requestQuotes)).max(0), checks: noChecks,
      obligations: z.array(obligations.api_adapter.element).max(0),
    }),
  ]);
}
const artifactWork = z.union(artifactWorkFor(z.array(id).min(1).max(16)).options.map((option) => option.extend({ artifactId: id })));
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
  attachmentIds: z.array(z.uuid()).max(5).optional(),
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
export const uploadUrlSchema = z.strictObject({ url: z.string().trim().min(1).max(4096) });
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

const missingEvidenceRequest = z.strictObject({
  caseId: id,
  artifactId: id,
  text: z.string().min(1).max(600),
  sourceRefs: z.array(id).min(1).max(16),
  requestQuotes: claim.shape.requestQuotes.min(1),
});
export const missingEvidenceRequestsSchema = z.array(missingEvidenceRequest.omit({ text: true, sourceRefs: true, requestQuotes: true }).extend({ claimId: id })).max(16);
export const assessmentDraftSchema = z.strictObject({
  requestConstraints: requestConstraintsSchema,
  cases: z.array(caseDraft).length(8),
  leads: z.array(lead.omit({ usefulArtifactIds: true }).extend({ comparisons: z.array(comparison).max(24) })).max(3),
  contrasts: z.array(lead.extend({ comparisons: z.array(comparison).max(24) })).max(8),
  clarifyingClaimIds: z.array(id).max(8),
  missingEvidenceRequests: z.array(missingEvidenceRequest).max(16),
  claims: z.array(globalAssessmentClaim).max(400),
});

function requestQuoteIdentity(request: string) {
  const spans = requestSpans(request);
  return z.enum(spans.map((span) => span.spanId) as [string, ...string[]])
    .transform((spanId) => spans.find((span) => span.spanId === spanId)!.text);
}

function requestQuoteList(request: string, max: number) {
  return z.array(requestQuoteIdentity(request)).max(max);
}

function requestInventoryFor(request: string) {
  const quotes = requestQuoteList(request, 64).transform((quotes) => completeRequestQuotes(request, quotes));
  return z.strictObject({ product_version: quotes, environment: quotes, scale: quotes, identity_access: quotes, recovery_operations: quotes });
}

function ownedArtifactWorkFor(
  sourceRefs: z.ZodArray<z.ZodType<string, string>>,
  requestQuote: z.ZodType<string, string>,
) {
  const requirement = { requestQuote, requirement: z.string().min(1).max(500) };
  const unchanged = z.strictObject({ ...requirement, checkKind: z.null() });
  const workFor = <Operation extends OperationKind>(operation: Operation) => {
    const obligation = z.union([
      unchanged,
      z.strictObject({ ...requirement, checkKind: operationSchemas[operation].checkKind }),
    ]).superRefine((item, context) => {
      if (!item.requestQuote.includes(item.requirement)) {
        context.addIssue({ code: "custom", path: ["requirement"], message: "An obligation must quote an exact part of its request span." });
      }
    });
    const adaptation = z.strictObject({ text: z.string().min(1).max(600), sourceRefs });
    const group = z.strictObject({
      adaptation: adaptation.nullable(), requirements: z.array(obligation).min(1).max(16),
    });
    const unchangedGroup = group.extend({ adaptation: z.null() });
    const coreKinds: readonly string[] = REQUIRED_OPERATION_CHECKS[operation];
    const checks = z.strictObject(Object.fromEntries(Object.keys(OPERATION_CHECKS[operation]).map((kind) => [
      kind, coreKinds.includes(kind) ? sourceRefs : sourceRefs.nullable(),
    ])));
    const fields = { operation: operationSchemas[operation].identity, historicalEvidence: sourceRefs };
    return [
      z.strictObject({ disposition: z.literal("reuse"), ...fields, obligations: z.array(unchangedGroup.extend({ requirements: z.array(unchanged).min(1).max(16) })).max(16), checks: z.strictObject({}) }),
      z.strictObject({ disposition: z.literal("adapt"), ...fields, obligations: z.array(group).min(1).max(16), checks }),
      z.strictObject({ disposition: z.literal("verify"), ...fields, obligations: z.array(unchangedGroup).max(16), checks }),
    ] as const;
  };
  return z.union([
    ...workFor("api_adapter"),
    ...workFor("recovery_handover"),
    ...workFor("data_mapping"),
    ...workFor("access_provisioning"),
    z.strictObject({
      disposition: z.null(), operation: z.null(), historicalEvidence: sourceRefs,
      obligations: z.array(z.strictObject({ adaptation: z.null(), requirements: z.array(unchanged) })).max(0),
      checks: z.strictObject({}),
    }),
  ]).transform((work, context): unknown => {
    // Keep strict-input failures from being lost by the following union parser.
    if (context.issues.length > 0) {
      context.addIssue({ code: "custom", message: "Invalid owned operation declaration." });
      return z.NEVER;
    }
    const checkSources = work.checks as Record<string, string[] | null>;
    const boundKinds = new Set<string | null>(work.obligations.flatMap((group) => group.requirements.map((item) => item.checkKind)));
    const checks: { kind: string; sourceRefs: string[]; requestQuotes: string[] }[] = [];
    for (const [kind, refs] of Object.entries(checkSources)) {
      if (refs === null || boundKinds.has(kind)) continue;
      if (kind === "client_operation_limits" || kind === "completion_feasibility") {
        context.addIssue({ code: "custom", path: ["checks", kind], message: "A request-driven check must be bound to an owned requirement." });
      } else {
        checks.push({ kind, sourceRefs: refs, requestQuotes: [] });
      }
    }
    const obligations: {
      requestQuote: string; requirement: string; requiresAdaptation: boolean;
      checkKind: string | null; adaptationIndexes: string[]; checkIndexes: string[];
    }[] = [];
    const obligationKeys = new Set<string>();
    const ownObligation = (item: { requestQuote: string; requirement: string; checkKind: string | null }, adaptationIndex: number | null) => {
      const key = JSON.stringify([item.requestQuote, item.requirement, item.checkKind]);
      if (obligationKeys.has(key) || !item.requestQuote.includes(item.requirement)) {
        context.addIssue({ code: "custom", path: ["obligations"], message: "Each exact atomic requirement and check kind must have one owner." });
        return;
      }
      obligationKeys.add(key);
      let checkIndex: number | null = null;
      if (item.checkKind !== null) {
        const refs = checkSources[item.checkKind];
        if (!refs) {
          context.addIssue({ code: "custom", path: ["checks", item.checkKind], message: "An owned prerequisite needs its declared check evidence." });
          return;
        }
        checkIndex = checks.findIndex((check) => check.kind === item.checkKind
          && check.requestQuotes[0] === item.requestQuote
          && check.sourceRefs.length === refs.length
          && check.sourceRefs.every((ref, index) => ref === refs[index]));
        if (checkIndex < 0) {
          checkIndex = checks.length;
          checks.push({ kind: item.checkKind, sourceRefs: refs, requestQuotes: [item.requestQuote] });
        }
      }
      obligations.push({
        requestQuote: item.requestQuote, requirement: item.requirement,
        requiresAdaptation: adaptationIndex !== null, checkKind: item.checkKind,
        adaptationIndexes: adaptationIndex === null ? [] : [String(adaptationIndex)],
        checkIndexes: checkIndex === null ? [] : [String(checkIndex)],
      });
    };
    const adaptations: { text: string; sourceRefs: string[]; requestQuotes: string[] }[] = [];
    for (const group of work.obligations) {
      const adaptationIndex = group.adaptation === null ? null : adaptations.length;
      if (group.adaptation !== null) adaptations.push({
        ...group.adaptation, requestQuotes: [...new Set(group.requirements.map((item) => item.requestQuote))],
      });
      for (const item of group.requirements) ownObligation(item, adaptationIndex);
    }
    if (context.issues.length > 0) return z.NEVER;
    return {
      disposition: work.disposition, operation: work.operation, historicalEvidence: work.historicalEvidence,
      requestQuotes: [...new Set(obligations.map((item) => item.requestQuote))],
      obligations, adaptations, checks,
    };
  }).pipe(artifactWorkFor(sourceRefs));
}

export function assessmentDraftSchemaFor(request: string, sources: { caseId: string; artifacts: { artifactId: string; passageIds: string[] }[]; passageIds: string[] }[]) {
  const requestConstraints = requestInventoryFor(request);
  const requestQuotes = requestQuoteList(request, 8);
  const requestQuote = requestQuotes.element;
  const artifactSourceRefs = Object.fromEntries(sources.flatMap((item) => item.artifacts.map((artifact) => [
    `${item.caseId}/${artifact.artifactId}`, z.array(z.enum(artifact.passageIds)).min(1).max(16),
  ])));
  const scopedClaims = sources.filter((item) => item.passageIds.length > 0).flatMap((item) => {
    const scope = { caseId: z.literal(item.caseId), sourceRefs: z.array(z.enum(item.passageIds)).min(1).max(16) };
    return [
      globalAssessmentClaim.options[0].extend({ ...scope, requestQuotes }),
      globalAssessmentClaim.options[1].extend({ ...scope, sourceRefs: z.array(scope.sourceRefs.element).length(1) }),
    ];
  });
  const scopedEvidenceRequests = sources.flatMap((item) => item.artifacts.filter((artifact) => artifact.passageIds.length > 0).map((artifact) =>
    missingEvidenceRequest.extend({
      caseId: z.literal(item.caseId), artifactId: z.literal(artifact.artifactId),
      sourceRefs: artifactSourceRefs[`${item.caseId}/${artifact.artifactId}`],
      requestQuotes: z.array(requestQuotes.element).min(1).max(8),
    }),
  ));
  const rankedCaseFor = (source: typeof sources[number]) => {
    const sourceRefs = z.array(source.passageIds.length ? z.enum(source.passageIds) : id).min(1).max(16);
    const ownComparison = z.union(comparison.options.map((option) => option.extend({
      requirementQuote: option.shape.requirementQuote instanceof z.ZodNull ? option.shape.requirementQuote : requestQuotes.element,
      evidence: comparisonFields.evidence.extend({ sourceRefs: z.array(sourceRefs.element).length(1), requestQuotes: z.array(requestQuotes.element).max(0) }),
      assessment: comparisonFields.assessment.extend({ sourceRefs, requestQuotes }),
      implication: comparisonFields.implication.extend({ artifactId: source.artifacts.length ? z.enum(source.artifacts.map((artifact) => artifact.artifactId)) : id }),
    })));
    const comparisons = z.array(ownComparison).max(source.passageIds.length ? 24 : 0);
    const reasons = z.array(artifactFact.extend({
      sourceRefs: z.array(sourceRefs.element).length(1), kind: z.literal("source_fact"), requestQuotes: z.array(requestQuotes.element).max(0),
    })).min(1).max(16);
    const caseFields = {
      outcome: caseDraft.shape.outcome,
      artifactWork: z.strictObject(Object.fromEntries(source.artifacts.map((artifact) => [
        artifact.artifactId, ownedArtifactWorkFor(artifactSourceRefs[`${source.caseId}/${artifact.artifactId}`], requestQuote),
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
    missingEvidenceRequests: scopedEvidenceRequests.length ? z.array(z.union(scopedEvidenceRequests)).max(16) : assessmentDraftSchema.shape.missingEvidenceRequests.max(0),
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
          usefulArtifactIds: artifacts.filter(({ artifactId }) => ["reuse", "adapt"].includes(item.artifactWork[artifactId].disposition ?? "")).map(({ artifactId }) => artifactId),
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

export function briefDraftSchemaFor(request: string, selected: Selection[], corpus: CorpusSnapshot, assessment: AssessmentResult) {
  if (selected.length === 0) throw new Error("BRIEF_SELECTION_REQUIRED");
  const labels = assessmentPassageIds(corpus);
  const spans = requestSpans(request);
  const inventory = selected.map((item, itemIndex) => {
    const work = assessment.cases.find((candidate) => candidate.caseId === item.caseId)?.artifactWork.find((candidate) => candidate.artifactId === item.artifactId);
    const review = assessment.artifactReviews.find((candidate) => candidate.caseId === item.caseId && candidate.artifactId === item.artifactId);
    if (!work?.disposition || review?.verdict !== "supported" || review.role !== "starting_point" || review.decision.disposition !== work.disposition) throw new Error("BRIEF_CHECKED_DECISION_REQUIRED");
    const refs = new Map([...corpus.passages.values()].filter((passage) =>
      passage.caseId === item.caseId && passage.artifactId === item.artifactId && passage.versionId === item.versionId,
    ).map((passage) => [labels.get(passage.passageId)!, {
      caseId: passage.caseId, artifactId: passage.artifactId, versionId: passage.versionId, passageId: passage.passageId,
    }]));
    if (!refs.size) throw new Error("BRIEF_SELECTED_EVIDENCE_UNAVAILABLE");
    const authored = z.strictObject({
      sourceRefs: z.array(z.enum([...refs.keys()])).min(1).max(16),
      text: z.string().min(1).max(3_499),
    });
    const optionalRecommendation = authored.nullable();
    const requiredQuotes = new Set(completeRequestQuotes(request, boundAssessmentQuotes(assessment, item)));
    const schema = z.strictObject({
      disposition: z.literal(work.disposition),
      recommendation: authored,
      requestRecommendations: z.strictObject(Object.fromEntries(spans.map((span) => [
        span.spanId, requiredQuotes.has(span.text) ? authored : optionalRecommendation,
      ]))),
      claims: z.array(authored).max(31),
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
      const inline = [
        { ...decision.recommendation, kind: "recommendation" as const, requestQuotes: [] as string[] },
        ...spans.flatMap((span) => {
          const recommendation = decision.requestRecommendations[span.spanId];
          return recommendation === null ? [] : [{ ...recommendation, kind: "recommendation" as const, requestQuotes: [span.text] }];
        }),
        ...decision.claims.map((value) => ({ ...value, kind: "interpretation" as const, requestQuotes: [] as string[] })),
      ];
      const evidence = new Map([...new Set(inline.flatMap((value) => value.sourceRefs))]
        .map((label, index) => [label, `brief-${itemIndex}-fact-${index}`]));
      const claimIds = inline.map((value, index) => {
        const claimId = index === 0 ? dispositionClaimId : `brief-${itemIndex}-claim-${index - 1}`;
        const dependsOnClaimIds = new Set([
          ...(index > 0 ? [dispositionClaimId] : []),
          ...value.sourceRefs.map((label) => evidence.get(label)!),
        ]);
        const sourceRefs = value.sourceRefs.map((label) => refs.get(label)!);
        const text = value.requestQuotes.length === 1 && !value.text.includes(value.requestQuotes[0])
          ? `${value.requestQuotes[0]} ${value.text}` : value.text;
        if (spans.some((span) => text.includes(span.text) && !value.requestQuotes.includes(span.text))) {
          ctx.addIssue({ code: "custom", path: ["items", key], message: "UNDECLARED_REQUEST_QUOTATION" });
        }
        claims.push({
          ...value, claimId, text, sourceRefs,
          dependsOnClaimIds: [...dependsOnClaimIds],
        });
        return claimId;
      });
      for (const [label, claimId] of evidence) {
        const ref = refs.get(label)!;
        claims.push({
          claimId, kind: "source_fact", text: corpus.passages.get(ref.passageId)!.excerpt,
          sourceRefs: [ref], requestQuotes: [], dependsOnClaimIds: [],
        });
        claimIds.push(claimId);
      }
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
const decisionCondition = z.strictObject({
  text: z.string().min(1).max(600), sourceRefs: z.array(sourceRef).min(1).max(16), requestQuotes: claim.shape.requestQuotes,
});
function canonicalOperationCheckFor<Operation extends OperationKind>(operation: Operation) {
  const base = z.strictObject({
    kind: operationSchemas[operation].checkKind,
    text: z.string().min(1).max(1_100),
    sourceRefs: z.array(sourceRef).min(1).max(16),
    requestQuotes: z.array(claim.shape.requestQuotes.element).max(1),
  });
  const schema = operation === "api_adapter" ? z.union([
    base.extend({ kind: unboundApiCheckKind }),
    base.extend({
      kind: operationLimitCheckKind, text: z.string().min(1).max(1_100),
      requestQuotes: z.array(claim.shape.requestQuotes.element).length(1),
    }),
  ]) : operation === "data_mapping" ? z.union([
    base.extend({ kind: unboundMappingCheckKind }),
    base.extend({
      kind: completionFeasibilityCheckKind, text: z.string().min(1).max(1_100),
      requestQuotes: z.array(claim.shape.requestQuotes.element).length(1),
    }),
  ]) : base;
  return schema.superRefine((check, context) => {
    if (renderOperationCheck(operation, check.kind, check.requestQuotes) !== check.text) {
      context.addIssue({ code: "custom", path: ["text"], message: "Rendered check text does not match its operation and kind." });
    }
  });
}
function canonicalObligationFor<Operation extends OperationKind>(operation: Operation) {
  return z.strictObject({
    claimId: id,
    requestQuote: claim.shape.requestQuotes.element,
    requirement: z.string().min(1).max(500),
    requiresAdaptation: z.boolean(),
    checkKind: operationSchemas[operation].checkKind.nullable(),
    adaptationClaimIds: z.array(id).max(8),
    checkClaimIds: z.array(id).max(8),
  }).superRefine((obligation, context) => {
    if (!obligation.requestQuote.includes(obligation.requirement)) {
      context.addIssue({ code: "custom", path: ["requirement"], message: "An obligation must quote an exact part of its request span." });
    }
  });
}

function canonicalDecisionFor<Operation extends OperationKind>(operation: Operation) {
  const check = canonicalOperationCheckFor(operation);
  const fields = {
    operation: operationSchemas[operation].identity,
    historicalEvidence: z.array(sourceRef).min(1).max(16),
    requestQuotes: z.array(z.string().min(1).max(500)).max(64),
    obligations: z.array(canonicalObligationFor(operation)).max(16),
  };
  const checks = z.array(check).max(8);
  return [
    z.strictObject({ disposition: z.literal("reuse"), ...fields, adaptations: z.array(decisionCondition).max(0), checks: checks.max(0) }),
    z.strictObject({ disposition: z.literal("adapt"), ...fields, adaptations: z.array(decisionCondition).min(1).max(8), checks: checks.min(1).max(8) }),
    z.strictObject({ disposition: z.literal("verify"), ...fields, adaptations: z.array(decisionCondition).max(0), checks: checks.min(1).max(8) }),
  ] as const;
}
const artifactDecision = z.union([
  ...canonicalDecisionFor("api_adapter"),
  ...canonicalDecisionFor("recovery_handover"),
  ...canonicalDecisionFor("data_mapping"),
  ...canonicalDecisionFor("access_provisioning"),
  z.strictObject({
    disposition: z.null(), operation: z.null(),
    historicalEvidence: z.array(sourceRef).min(1).max(16),
    requestQuotes: z.array(z.string().min(1).max(500)).max(64),
    adaptations: z.array(decisionCondition).max(0),
    checks: z.array(z.never()).max(0),
    obligations: z.array(canonicalObligationFor("api_adapter")).max(0),
  }),
]);
const decisionReason = z.strictObject({
  target: z.enum(["history", "request_constraint", "adaptation", "check", "disposition"]),
  explanation: z.string().min(1).max(600),
  sourceRefs: z.array(sourceRef).min(1).max(16),
  requestQuotes: claim.shape.requestQuotes,
  claimId: id.optional(),
  requirement: z.string().min(1).max(500).optional(),
});
const findingEvidence = z.strictObject({
  explanation: z.string().min(1).max(600),
  sourceRefs: z.array(sourceRef).min(1).max(16),
  requestQuotes: claim.shape.requestQuotes,
});
export const evidenceJudgmentSchema = z.union([
  z.strictObject({ verdict: z.literal("supported"), reason: z.null() }),
  z.strictObject({ verdict: z.enum(["unsupported", "uncertain"]), reason: findingEvidence }),
]);
export const missingEvidenceReviewSchema = z.union(evidenceJudgmentSchema.options.map((option) => option.extend({ claimIds: z.array(id).max(16) })));
const claimFinding = z.union(evidenceJudgmentSchema.options.map((option) => option.extend({ claimId: id })));
const reviewFields = {
  role: z.enum(["starting_point", "context_only", "not_relevant", "unresolved"]),
  verdict: z.enum(["supported", "unsupported", "uncertain"]),
  reasons: z.array(decisionReason).max(8),
  claimFindings: z.array(claimFinding).max(64),
};
export const artifactReviewsSchema = z.array(z.strictObject({
  caseId: id, artifactId: id, decision: artifactDecision, ...reviewFields,
})).max(256).superRefine((reviews, context) => {
  const key = (ref: z.infer<typeof sourceRef>) => `${ref.caseId}\u0000${ref.artifactId}\u0000${ref.versionId}\u0000${ref.passageId}`;
  for (const [index, review] of reviews.entries()) {
    const history = new Set(review.decision.historicalEvidence.map(key));
    const conditions = [...review.decision.adaptations, ...review.decision.checks];
    if (review.decision.historicalEvidence.some((ref) => ref.caseId !== review.caseId || ref.artifactId !== review.artifactId)
      || conditions.some((condition) => condition.sourceRefs.some((ref) => !history.has(key(ref)) || ref.caseId !== review.caseId || ref.artifactId !== review.artifactId))) {
      context.addIssue({ code: "custom", path: [index, "decision"], message: "Decision evidence and operation checks must belong to the exact artifact history." });
    }
    const findings = new Map(review.claimFindings.map((finding) => [finding.claimId, finding]));
    if (findings.size !== review.claimFindings.length || review.reasons.some((reason) => {
      if (reason.claimId !== undefined) {
        const evidence = findings.get(reason.claimId)?.reason;
        return !evidence || evidence.explanation !== reason.explanation
          || JSON.stringify(evidence.sourceRefs.map(key)) !== JSON.stringify(reason.sourceRefs.map(key))
          || JSON.stringify(evidence.requestQuotes) !== JSON.stringify(reason.requestQuotes);
      }
      return ["history", "adaptation", "check"].includes(reason.target)
        || (reason.target === "request_constraint"
          && (!reason.requirement || !reason.requestQuotes.some((quote) => quote.includes(reason.requirement!))));
    })) {
      context.addIssue({ code: "custom", path: [index, "claimFindings"], message: "Rejection subjects must use their canonical negative finding; independent omissions need an exact atomic requirement." });
    }
  }
});
export const assessmentReviewSchema = z.strictObject({
  requestConstraints: requestConstraintsSchema,
  missingEvidenceReview: missingEvidenceReviewSchema,
  artifactReviews: z.array(z.strictObject({
    caseId: id, artifactId: id, disposition: z.enum(["reuse", "adapt", "verify"]).nullable(), ...reviewFields,
  })).max(256),
  claimReviews: supportReviewSchema.shape.claimReviews,
});

export interface ReviewTargets {
  claimIds: string[];
  missingEvidenceClaimIds?: string[];
  artifacts?: {
    caseId: string;
    artifactId: string;
    disposition: BriefDisposition | null;
    // History covers source facts and the historical operation claim, not the offered disposition.
    operation?: OperationKind | null;
    claimIds: { history: string[]; adaptation: string[]; check: string[]; obligation: string[] };
  }[];
  sourceRefs?: Record<string, z.infer<typeof sourceRef>>;
  selections?: Pick<Selection, "caseId" | "artifactId" | "versionId">[];
}



export function reviewSchema(targets: ReviewTargets, request: string) {
  if (targets.selections) {
    const claimVerdicts = z.strictObject(Object.fromEntries(targets.claimIds.map((claimId) => [claimId, z.enum(["supported", "unsupported", "uncertain"])])));
    const entries = targets.selections.map((item) => ({ item, key: `${item.caseId}/${item.artifactId}/${item.versionId}` }));
    return z.strictObject({
      constraintQuotes: z.strictObject(Object.fromEntries(entries.map(({ key }) => [key, z.array(requestQuoteIdentity(request)).max(64).transform((quotes) => completeRequestQuotes(request, quotes))]))),
      claimVerdicts,
    }).transform(({ constraintQuotes, claimVerdicts }) => ({
      constraintReviews: entries.map(({ item, key }) => ({
        caseId: item.caseId, artifactId: item.artifactId, versionId: item.versionId, requestQuotes: constraintQuotes[key],
      })),
      claimReviews: targets.claimIds.map((claimId) => ({ claimId, verdict: claimVerdicts[claimId] })),
    })).pipe(briefSupportReviewSchema);
  }
  if (!targets.artifacts || (targets.artifacts.length > 0 && (!targets.sourceRefs || !Object.keys(targets.sourceRefs).length))) throw new Error("REVIEW_TARGETS_REQUIRED");
  const verdictIds = new Set(targets.claimIds);
  if (verdictIds.size !== targets.claimIds.length || targets.claimIds.some((claimId) => !id.safeParse(claimId).success)) {
    throw new Error("REVIEW_TARGET_CLAIMS_INVALID");
  }
  if ((targets.missingEvidenceClaimIds ?? []).some((claimId) => !verdictIds.has(claimId))
    || new Set(targets.missingEvidenceClaimIds ?? []).size !== (targets.missingEvidenceClaimIds ?? []).length) {
    throw new Error("REVIEW_TARGET_EVIDENCE_REQUESTS_INVALID");
  }
  const entries = targets.artifacts.map((item) => ({ item, key: `${item.caseId}/${item.artifactId}` }));
  if (new Set(entries.map(({ key }) => key)).size !== entries.length) throw new Error("REVIEW_TARGET_ARTIFACTS_INVALID");
  const inventoryClaimIds = new Set<string>();
  for (const { item } of entries) {
    const ownIds = Object.values(item.claimIds).flat();
    if (ownIds.length !== new Set(ownIds).size
      || ownIds.some((claimId) => inventoryClaimIds.has(claimId) || !verdictIds.has(claimId) || !id.safeParse(claimId).success)) {
      throw new Error("REVIEW_TARGET_ARTIFACT_CLAIMS_INVALID");
    }
    for (const claimId of ownIds) inventoryClaimIds.add(claimId);
  }
  const sourceLabels = targets.sourceRefs && Object.keys(targets.sourceRefs);
  const evidence = findingEvidence.extend({
    sourceRefs: z.array(sourceLabels?.length ? z.enum(sourceLabels) : id).min(1).max(16)
      .transform((labels) => labels.map((label) => targets.sourceRefs![label])),
    requestQuotes: requestQuoteList(request, 8),
  });
  const judgment = z.union([
    z.strictObject({ verdict: z.literal("supported"), reason: z.null() }),
    z.strictObject({ verdict: z.enum(["unsupported", "uncertain"]), reason: evidence }),
  ]);
  const claimJudgments = z.strictObject(Object.fromEntries(targets.claimIds.map((claimId) => [claimId, judgment])));
  const independentReason = z.union([
    evidence.extend({ target: z.literal("disposition") }),
    evidence.extend({
      target: z.literal("request_constraint"),
      requirement: z.string().min(1).max(500),
      requestQuotes: z.array(requestQuoteIdentity(request)).length(1),
    }),
  ]);
  const decisions = z.strictObject(Object.fromEntries(entries.map(({ item, key }) => {
    const fields = { disposition: item.disposition === null ? z.null() : z.literal(item.disposition), role: reviewFields.role };
    return [key, z.union([
      z.strictObject({ ...fields, verdict: z.literal("supported"), reasons: z.array(independentReason).max(0) }),
      z.strictObject({ ...fields, verdict: z.enum(["unsupported", "uncertain"]), reasons: z.array(independentReason).min(1).max(8) }),
    ])];
  })));
  return z.strictObject({
    requestConstraints: requestInventoryFor(request),
    claimJudgments,
    decisions,
    missingEvidenceReview: judgment,
  }).superRefine(({ decisions }, context) => {
    for (const { key } of entries) {
      for (const [index, reason] of decisions[key].reasons.entries()) {
        if (reason.target === "request_constraint" && !reason.requestQuotes[0]?.includes(reason.requirement)) {
          context.addIssue({ code: "custom", path: ["decisions", key, "reasons", index, "requirement"], message: "An omitted requirement must be an exact part of its cited request span." });
        }
      }
    }
  }).transform(({ decisions, claimJudgments, missingEvidenceReview, ...review }): z.input<typeof assessmentReviewSchema> => ({
    ...review,
    missingEvidenceReview: { ...missingEvidenceReview, claimIds: targets.missingEvidenceClaimIds ?? [] },
    artifactReviews: entries.map(({ item, key }) => {
      const claimFindings = Object.values(item.claimIds).flat().map((claimId) => ({ claimId, ...claimJudgments[claimId] }));
      const rejected = claimFindings.flatMap((finding) => {
        if (finding.reason === null) return [];
        const target = item.claimIds.history.includes(finding.claimId) ? "history" as const
          : item.claimIds.adaptation.includes(finding.claimId) ? "adaptation" as const
          : item.claimIds.check.includes(finding.claimId) ? "check" as const : "request_constraint" as const;
        return [{ ...finding.reason, target, claimId: finding.claimId }];
      });
      return {
        caseId: item.caseId, artifactId: item.artifactId, ...decisions[key], claimFindings,
        reasons: [...decisions[key].reasons, ...rejected].slice(0, 8),
      };
    }),
    claimReviews: targets.claimIds.map((claimId) => ({ claimId, verdict: claimJudgments[claimId].verdict })),
  })).pipe(assessmentReviewSchema);
}

export type AssessmentOutput = z.infer<typeof assessmentDraftSchema>;
type ArtifactWork = {
  artifactId: string;
  disposition: "reuse" | "adapt" | "verify" | null;
  dispositionClaimId: string;
  claimIds: string[];
  blockerClaimIds: string[];
  verificationClaimIds: string[];
  decision: ArtifactDecision;
};
export type AssessmentDraft = Omit<AssessmentOutput, "cases" | "leads" | "contrasts" | "claims" | "missingEvidenceRequests"> & {
  cases: (Omit<AssessmentOutput["cases"][number], "artifactWork"> & { claimIds: string[]; outcomeClaimIds: string[]; artifactWork: ArtifactWork[] })[];
  claims: z.infer<typeof claim>[];
  leads: z.infer<typeof lead>[];
  contrasts: z.infer<typeof lead>[];
  comparisons: ComparisonRow[];
  missingEvidenceRequests: AssessmentResult["missingEvidenceRequests"];
};
export type BriefDraft = z.infer<typeof briefDraftSchema>;
export type SupportReview = z.infer<typeof supportReviewSchema>;
export type BriefSupportReview = z.infer<typeof briefSupportReviewSchema>;
export type AssessmentReview = z.infer<typeof assessmentReviewSchema>;
export type Reference = z.infer<typeof sourceRef>;
export type ModelClaim = z.infer<typeof claim>;

export function obligationClaimText(requirement: string): string {
  return `The declared adaptations and prerequisite checks cover the current requirement: ${JSON.stringify(requirement)}.`;
}

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
  const missingEvidenceRequests = output.missingEvidenceRequests.map((item, index) => {
    const claimId = `missing-evidence-${index}`;
    const sourceRefs = resolveRefs(item.sourceRefs);
    const work = output.cases.find((candidate) => candidate.caseId === item.caseId)?.artifactWork.find((candidate) => candidate.artifactId === item.artifactId);
    if (!work || item.sourceRefs.some((label) => !work.historicalEvidence.includes(label))
      || sourceRefs.some((ref) => ref.caseId !== item.caseId || ref.artifactId !== item.artifactId)) {
      throw new z.ZodError([{ code: "custom", path: ["missingEvidenceRequests", index], message: "Missing-evidence requests need their exact own-artifact historical evidence." }]);
    }
    const factIds = sourceRefs.map((ref, factIndex) => {
      const factId = `${claimId}-fact-${factIndex}`;
      claims.push({ claimId: factId, kind: "source_fact", text: sourceText([ref]), sourceRefs: [ref], requestQuotes: [], dependsOnClaimIds: [] });
      return factId;
    });
    claims.push({
      claimId, kind: "interpretation", text: `Missing evidence request: ${item.text}`, sourceRefs,
      requestQuotes: item.requestQuotes, dependsOnClaimIds: factIds,
    });
    return { caseId: item.caseId, artifactId: item.artifactId, claimId };
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
    const decisionDependencies = implication.effect === "checked_decision" ? [dispositionId] : [];
    const implicationText = implication.effect === "checked_decision"
      ? `Checked artifact decision: ${work.disposition ?? "excluded"}; proposed changes and required checks are not established client capabilities.`
      : implication.effect === "context_only" ? "Context only; no implementation starting work is offered."
        : "Missing evidence must be obtained before a starting-work decision; no implementation starting work is offered.";
    claims.push(
      { ...assessment, text: `Recorded evidence has relation ${row.relation} to the current ${row.dimension} requirement; unestablished applicability remains unknown.`, sourceRefs: assessmentRefs, claimId: assessmentClaimId, kind: "interpretation", dependsOnClaimIds: [...new Set([...assessment.dependsOnClaimIds, evidenceClaimId, ...(requirementClaimId === null ? [] : [requirementClaimId])])] },
      { text: implicationText, sourceRefs: resolveRefs(work.historicalEvidence), requestQuotes: work.requestQuotes, claimId: implicationClaimId, kind: implication.effect === "checked_decision" ? "recommendation" : "interpretation", dependsOnClaimIds: [assessmentClaimId, ...decisionDependencies] },
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
      ...missingEvidenceRequests.filter((entry) => entry.caseId === item.caseId).flatMap((entry) =>
        [entry.claimId, ...claims.find((claim) => claim.claimId === entry.claimId)!.dependsOnClaimIds]),
      ...item.artifactWork.flatMap((work, workIndex) => work.disposition === null ? [`disposition-${caseIndex}-${workIndex}`] : []),
    ],
    outcomeClaimIds: outcomeClaimIdsByCase.get(item.caseId)!,
    artifactWork: item.artifactWork.map((work, workIndex) => {
      const dispositionClaimId = `disposition-${caseIndex}-${workIndex}`;
      const historicalLabels = [...new Set(work.historicalEvidence)];
      const historicalEvidence = resolveRefs(historicalLabels);
      const evidenceIds = new Map(historicalLabels.map((label, index) => [label, `artifact-${caseIndex}-${workIndex}-history-${index}`]));
      const historicalFactIds = [...evidenceIds.values()];
      const operationClaimId = work.operation === null ? null : `artifact-${caseIndex}-${workIndex}-operation`;
      const conditionIds = (indexes: string[], count: number, category: "adapt" | "check"): string[] => indexes.map((slot) => {
        const index = Number(slot);
        if (index >= count) throw new z.ZodError([{ code: "custom", path: ["obligations", category], message: "An obligation references a missing condition slot." }]);
        return `artifact-${caseIndex}-${workIndex}-${category}-${index}`;
      });
      const decisionChecks = work.operation === null ? [] : work.checks.map((check) => ({
        kind: check.kind,
        text: renderOperationCheck(work.operation, check.kind, check.requestQuotes),
        sourceRefs: resolveRefs(check.sourceRefs),
        requestQuotes: check.requestQuotes,
      }));
      const decision = artifactDecision.parse({
        disposition: work.disposition,
        operation: work.operation,
        historicalEvidence,
        requestQuotes: work.requestQuotes,
        adaptations: work.adaptations.map((condition) => ({ ...condition, sourceRefs: resolveRefs(condition.sourceRefs) })),
        checks: decisionChecks,
        obligations: work.obligations.map(({ adaptationIndexes, checkIndexes, ...obligation }, index) => ({
          ...obligation,
          claimId: `artifact-${caseIndex}-${workIndex}-obligation-${index}`,
          adaptationClaimIds: conditionIds(adaptationIndexes, work.adaptations.length, "adapt"),
          checkClaimIds: conditionIds(checkIndexes, work.checks.length, "check"),
        })),
      });
      for (const [index, ref] of historicalEvidence.entries()) {
        claims.push({ claimId: evidenceIds.get(historicalLabels[index])!, text: sourceText([ref]), kind: "source_fact", sourceRefs: [ref], requestQuotes: [], dependsOnClaimIds: [] });
      }
      if (operationClaimId !== null && work.operation !== null) {
        claims.push({
          claimId: operationClaimId,
          text: `The historical operation documented by this artifact is ${work.operation.replace("_", " ")}.`,
          kind: "interpretation",
          sourceRefs: historicalEvidence,
          requestQuotes: [],
          dependsOnClaimIds: historicalFactIds,
        });
      }
      const conditionEvidence = (labels: string[]) => labels.map((label) => {
        const claimId = evidenceIds.get(label);
        if (!claimId) throw new Error("ARTIFACT_FACTUAL_EVIDENCE_REQUIRED");
        return claimId;
      });
      const adaptationClaimIds = work.adaptations.map((condition, index) => {
        const claimId = `artifact-${caseIndex}-${workIndex}-adapt-${index}`;
        claims.push({
          ...condition, claimId, kind: "recommendation", sourceRefs: resolveRefs(condition.sourceRefs),
          text: `Proposed adaptation: ${condition.text}${condition.requestQuotes.map((quote) => ` Current request: ${quote}`).join("")}`,
          dependsOnClaimIds: [dispositionClaimId, ...conditionEvidence(condition.sourceRefs)],
        });
        return claimId;
      });
      const verificationClaimIds = work.operation === null ? [] : work.checks.map((check, index) => {
        const claimId = `artifact-${caseIndex}-${workIndex}-check-${index}`;
        const text = renderOperationCheck(work.operation, check.kind, check.requestQuotes);
        claims.push({
          claimId, text, kind: "recommendation", sourceRefs: resolveRefs(check.sourceRefs), requestQuotes: check.requestQuotes,
          dependsOnClaimIds: [dispositionClaimId, ...conditionEvidence(check.sourceRefs)],
        });
        return claimId;
      });
      const obligationClaimIds = decision.obligations.map((obligation) => {
        claims.push({
          claimId: obligation.claimId, kind: "interpretation", text: obligationClaimText(obligation.requirement),
          sourceRefs: historicalEvidence, requestQuotes: [obligation.requestQuote],
          dependsOnClaimIds: [...new Set([dispositionClaimId, ...obligation.adaptationClaimIds, ...obligation.checkClaimIds])],
        });
        return obligation.claimId;
      });
      claims.push({
        claimId: dispositionClaimId,
        text: work.disposition === null ? "This artifact is excluded; no implementation starting work is offered."
          : `${work.disposition === "adapt" ? "Conditional Adapt" : work.disposition === "reuse" ? "Reuse" : "Verify"} starting material; proposed changes and required checks do not establish current-client capabilities, combined acceptance or production readiness.`,
        kind: work.disposition === null ? "interpretation" : "recommendation",
        sourceRefs: historicalEvidence, requestQuotes: work.requestQuotes,
        dependsOnClaimIds: [...historicalFactIds, ...(operationClaimId === null ? [] : [operationClaimId])],
      });
      return {
        artifactId: work.artifactId, disposition: work.disposition, decision, dispositionClaimId,
        claimIds: [dispositionClaimId, ...historicalFactIds, ...(operationClaimId === null ? [] : [operationClaimId]), ...adaptationClaimIds, ...verificationClaimIds, ...obligationClaimIds],
        blockerClaimIds: [], verificationClaimIds,
      };
    }),
  }));
  const leads = output.leads.map(({ comparisons: _, ...lead }) => ({
    ...lead,
    usefulArtifactIds: output.cases.find((item) => item.caseId === lead.caseId)?.artifactWork
      .filter((work) => work.disposition === "reuse" || work.disposition === "adapt").map((work) => work.artifactId) ?? [],
  }));
  const contrasts = output.contrasts.map(({ comparisons: _, ...contrast }) => contrast);
  const qualified = applySourceHistoryQualifications(corpus, claims);
  const originalIds = new Set(claims.map((claim) => claim.claimId));
  for (const item of cases) item.claimIds.push(...qualified.filter((claim) => !originalIds.has(claim.claimId)
    && claim.sourceRefs.some((ref) => ref.caseId === item.caseId)).map((claim) => claim.claimId));
  return { ...output, missingEvidenceRequests, cases, leads, contrasts, comparisons, claims: qualified };
}

export function openRouterSchema(name: string, schema: z.ZodType): {
  type: "json_schema";
  json_schema: { name: string; strict: true; schema: Record<string, unknown> };
} {
  // Draft 7 wraps constrained reused schemas in allOf, forbidden by strict outputs.
  // Fresh cardinality-specific arrays above keep refs free of assertion siblings.
  const generated = z.toJSONSchema(schema, {
    target: "draft-2020-12", io: "input", reused: "ref",
    override: ({ jsonSchema }) => {
      if (jsonSchema.type === "object") jsonSchema.required ??= [];
      if (jsonSchema.const !== undefined) {
        jsonSchema.enum = [jsonSchema.const];
        delete jsonSchema.const;
      }
    },
  }) as Record<string, unknown>;
  delete generated.$schema;
  return { type: "json_schema", json_schema: { name, strict: true, schema: generated } };
}
