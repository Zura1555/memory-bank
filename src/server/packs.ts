import type { AssessmentResult, BriefDisposition, BriefItem, BriefResult, Claim, KnowledgeCard, PassageView, Selection, SourceRef } from "../shared/protocol.ts";
import { capabilityHash } from "./auth.ts";
import { EvidenceUnavailable, knowledgeCards, loadCorpus, sourceVersion, type CorpusSnapshot } from "./corpus.ts";
import { database } from "./db.ts";
import type { Env } from "./env.ts";
import { HttpFailure } from "./errors.ts";
import { revalidateAssessment, revalidateBrief, withAssessmentConstraintFloor } from "./gates.ts";
import { ownedJob, type JobRecord } from "./jobs.ts";
import { validateSelections } from "./selections.ts";
import { isSourceHistoryQualification } from "./source-history.ts";

const identity = (ref: { caseId: string; artifactId: string; versionId: string }) => `${ref.caseId}/${ref.artifactId}/${ref.versionId}`;
const sectionTitles = { reuse: "Reusable material — checked starting point, not production approval", adapt: "Required adaptations — complete before use", verify: "Unresolved verification — BLOCKED, not approved unchanged reuse" } as const;
const boundaries = [
  "Fictional demonstration data only. This pack is not production approval or an autonomous implementation plan.",
  "Job requests, checked results, and capabilities expire after seven days. New exports require an unexpired owned ready job.",
  "Evidence excerpts below are preserved offline; original bytes are not bundled or modified. Exact-original links are live references, may become unavailable, and are not promised indefinitely. Download and retain originals separately if needed.",
  "Verify-only material is BLOCKED until its checks are resolved; adaptation recommendations must be completed before use. Observed outcomes do not promise a repeat.",
  "Reviewed decision/lesson records are source context, not a new request-specific recommendation. Superseded advice is historical only.",
  "Evidence routes are public within the demo app. Source-level authorization is a separate release gate before confidential real data is used.",
];

export interface PackArtifact extends Selection {
  title: string;
  sha256: string;
  mimeType: string;
  statedDate: string | null;
  originalUrl: string;
  disposition: BriefDisposition | "withheld";
  status: string;
  checklistClaimIds: string[];
  blockingClaimIds: string[];
}

export interface StarterPack {
  schemaVersion: 1;
  fictional: true;
  jobId: string;
  createdAt: string;
  expiresAt: string;
  request: string;
  corpus: { version: string; sha256: string };
  boundaries: string[];
  inventory: PackArtifact[];
  brief: BriefResult;
  blockingQuestions: Claim[];
  assessmentHistory: Claim[];
  records: KnowledgeCard[];
  evidence: PassageView[];
}
// Keep only selected-source claims with their entire checked dependency chain.
function selectedClaims(claims: Claim[], selected: Set<string>, corpus: CorpusSnapshot): Claim[] {
  const accepted = new Set(claims.filter((claim) => claim.sourceRefs.every((ref) => selected.has(identity(ref)))).map((claim) => claim.claimId));
  // Required historical qualifications may cite another original in the same
  // case. Preserve those exact dependency facts, never additional starting work.
  const byId = new Map(claims.map((claim) => [claim.claimId, claim]));
  for (const id of accepted) for (const dependency of byId.get(id)!.dependsOnClaimIds) {
    const claim = byId.get(dependency);
    if (claim && isSourceHistoryQualification(corpus, claim)) accepted.add(dependency);
  }
  let changed = true;
  while (changed) {
    changed = false;

    for (const claim of claims) if (accepted.has(claim.claimId) && claim.dependsOnClaimIds.some((id) => !accepted.has(id))) {
      accepted.delete(claim.claimId);
      changed = true;
    }
  }
  return claims.filter((claim) => accepted.has(claim.claimId));
}

function assessmentHistoryClaims(assessment: AssessmentResult, selections: Selection[], briefClaims: Claim[], corpus: CorpusSnapshot): Claim[] {
  const selectedCases = new Set(selections.map((selection) => selection.caseId));
  const linksByCase = new Map(assessment.cases.filter((item) => selectedCases.has(item.caseId))
    .map((item) => [item.caseId, new Set(item.claimIds)]));
  const included = new Set(briefClaims.map((claim) => claim.claimId));
  return assessment.claims.filter((claim) => {
    const caseId = claim.sourceRefs[0]?.caseId;
    return caseId !== undefined && linksByCase.get(caseId)?.has(claim.claimId) && !included.has(claim.claimId)
      && isSourceHistoryQualification(corpus, claim);
  });
}
export function buildStarterPack(job: JobRecord, corpus: CorpusSnapshot, origin: string): StarterPack {
  if (job.expires_at.getTime() <= Date.now()) throw new HttpFailure(410, "JOB_EXPIRED");
  if (job.stage !== "ready" || job.assessment_state !== "ready" || job.brief_state !== "ready" || !job.assessment_result || !job.brief_result || !job.brief_selections) {
    throw new HttpFailure(409, "CHECKED_BRIEF_REQUIRED");
  }
  if (corpus.manifest.corpusVersion !== job.corpus_version || corpus.manifestSha256 !== job.corpus_sha256) {
    throw new EvidenceUnavailable("The job's pinned corpus revision is unavailable.");
  }
  // Fail explicitly for a lost/corrupt selected original, rather than exporting a silently reduced pack.
  for (const selection of job.brief_selections) sourceVersion(corpus, selection.versionId);
  const assessment = revalidateAssessment(job.assessment_result, job.request_text, corpus);
  const selections = validateSelections(job.brief_selections, assessment, corpus);
  const selected = new Set(selections.map(identity));
  const floored = job.brief_result.constraintReviews
    ? { ...job.brief_result, constraintReviews: withAssessmentConstraintFloor(job.brief_result.constraintReviews, assessment, job.request_text) }
    : job.brief_result;
  const rechecked = revalidateBrief(floored, job.request_text, corpus, assessment);
  const claims = selectedClaims(rechecked.claims, selected, corpus);
  const claimIds = new Set(claims.map((claim) => claim.claimId));
  const keep = (items: BriefItem[]) => items.filter((item) => selected.has(identity(item)) && claimIds.has(item.dispositionClaimId) && item.claimIds.every((id) => claimIds.has(id)));
  const reuse = keep(rechecked.reuse), adapt = keep(rechecked.adapt), verify = keep(rechecked.verify);
  const items = [...reuse, ...adapt, ...verify];
  const brief = {
    reuse, adapt, verify, claims,
    constraintReviews: rechecked.constraintReviews.filter((review) => items.some((item) => identity(item) === identity(review))),
    withheldClaimCount: rechecked.withheldClaimCount + rechecked.claims.length - claims.length,
  };
  // Keep explicitly case-linked historical qualifications separate from item claims.
  const assessmentHistory = assessmentHistoryClaims(assessment, selections, claims, corpus);
  const assessmentClaims = selectedClaims(assessment.claims, selected, corpus);
  const assessmentIds = new Set(assessmentClaims.map((claim) => claim.claimId));
  const inventory: PackArtifact[] = selections.map((selection) => {
    const { version, artifact } = sourceVersion(corpus, selection.versionId);
    const item = items.find((candidate) => identity(candidate) === identity(selection));
    const work = assessment.cases.find((candidate) => candidate.caseId === selection.caseId)?.artifactWork.find((candidate) => candidate.artifactId === selection.artifactId);
    const blockingClaimIds = [...new Set([...(work?.blockerClaimIds ?? []), ...(work?.verificationClaimIds ?? []), ...assessment.clarifyingClaimIds,
      ...assessment.missingEvidenceRequests.filter((item) => item.caseId === selection.caseId && item.artifactId === selection.artifactId).map((item) => item.claimId)])]
      .filter((id) => assessmentIds.has(id) && assessmentClaims.find((claim) => claim.claimId === id)?.sourceRefs.some((ref) => identity(ref) === identity(selection)));
    return {
      ...selection, title: artifact.title, sha256: version.sha256, mimeType: version.mimeType, statedDate: version.statedDate,
      originalUrl: new URL(`/api/evidence/originals/${encodeURIComponent(version.versionId)}`, origin).href,
      disposition: item?.disposition ?? "withheld",
      status: !item ? "BLOCKED: no complete checked recommendation" : item.disposition === "verify" ? "BLOCKED: unresolved verification" : item.disposition === "adapt" ? "Adaptation required before use" : "Checked reusable starting point; not production approval",
      checklistClaimIds: item?.claimIds.filter((id) => claims.find((claim) => claim.claimId === id)?.kind === "recommendation") ?? [],
      blockingClaimIds,
    };
  });
  const blockingIds = new Set(inventory.flatMap((item) => item.blockingClaimIds));
  // Retain dependencies of blocking checks, but not unrelated assessment prose.
  const addDependencies = (id: string): void => {
    for (const dependency of assessmentClaims.find((claim) => claim.claimId === id)?.dependsOnClaimIds ?? []) {
      if (!blockingIds.has(dependency)) { blockingIds.add(dependency); addDependencies(dependency); }
    }
  };
  for (const id of [...blockingIds]) addDependencies(id);
  const blockingQuestions = assessmentClaims.filter((claim) => blockingIds.has(claim.claimId));
  const records = knowledgeCards(corpus).filter((record) => record.evidence.length > 0 && record.evidence.every((ref) => selected.has(identity(ref))));
  const refs = new Map<string, SourceRef>();
  for (const ref of [...claims.flatMap((claim) => claim.sourceRefs), ...blockingQuestions.flatMap((claim) => claim.sourceRefs), ...assessmentHistory.flatMap((claim) => claim.sourceRefs), ...records.flatMap((record) => record.evidence)]) refs.set(ref.passageId, ref);
  // Selected passages stay available offline even if their recommendation was withheld.
  for (const selection of selections) for (const passageId of selection.passageIds) refs.set(passageId, { ...selection, passageId });
  const evidence = [...refs.values()].map((ref) => {
    const passage = corpus.passages.get(ref.passageId);
    if (!passage || identity(passage) !== identity(ref)) throw new EvidenceUnavailable("A cited passage is unavailable.");
    return passage;
  });
  return {
    schemaVersion: 1 as const, fictional: true as const, jobId: job.id,
    createdAt: job.created_at.toISOString(), expiresAt: job.expires_at.toISOString(), request: job.request_text,
    corpus: { version: job.corpus_version, sha256: job.corpus_sha256 },
    boundaries, inventory, brief, blockingQuestions, assessmentHistory, records, evidence,
  };
}


// Encode source-controlled text as text, never active Markdown/HTML.
const text = (value: string) => value.replace(/[\\`*_{}\[\]()<>#+.!|~\-]/gu, "\\$&").replace(/\r?\n/gu, "\n\n");
export function starterPackMarkdown(pack: StarterPack): string {
  const lines = ["# Evidence-linked starter pack", "", ...pack.boundaries.map((value) => `> ${text(value)}`), "",
    `Job: ${text(pack.jobId)} · Created: ${pack.createdAt} · Expires: ${pack.expiresAt}`,
    `Pinned corpus: ${text(pack.corpus.version)} · SHA-256: ${pack.corpus.sha256}`, "", "## Client request", text(pack.request), "", "## Selected artifact/version inventory"];
  for (const item of pack.inventory) lines.push("", `### ${text(identity(item))}`, text(item.title), text(item.status),
    `SHA-256: ${item.sha256}`, `Media type: ${text(item.mimeType)} · Stated date: ${item.statedDate ?? "unknown"}`,
    `[Live exact-original link — not bundled](<${item.originalUrl}>)`,
    `Selected passages: ${item.passageIds.map(text).join(", ")}`,
    `Recommendation/checklist claim IDs (checked brief): ${item.checklistClaimIds.map(text).join(", ") || "none — no approval inferred"}`,
    `Blocking question/check IDs (assessment): ${item.blockingClaimIds.map(text).join(", ") || "none recorded — not a safety guarantee"}`);
  for (const kind of ["reuse", "adapt", "verify"] as const) {
    lines.push("", `## ${sectionTitles[kind]}`);
    for (const item of pack.brief[kind]) lines.push(`- ${text(identity(item))}: recommendation ${text(item.dispositionClaimId)}; checked claims ${item.claimIds.map(text).join(", ")}`);
    if (!pack.brief[kind].length) lines.push("No complete checked items in this section.");
  }
  const renderClaims = (title: string, claims: Claim[]) => {
    lines.push("", `## ${title}`);
    for (const claim of claims) lines.push("", `### ${text(claim.claimId)} — ${claim.kind}`, text(claim.text),
      `Evidence: ${claim.sourceRefs.map((ref) => text(`${identity(ref)}/${ref.passageId}`)).join(", ") || "request only"}`,
      `Checked dependencies: ${claim.dependsOnClaimIds.map(text).join(", ") || "none"}`,
      ...claim.requestQuotes.map((quote) => `Request quote: ${text(quote)}`));
  };
  lines.push("", `Withheld brief claims: ${pack.brief.withheldClaimCount}. Withheld content is not exported.`);
  renderClaims("Checked brief claims / adaptation and verification checklist", pack.brief.claims);
  renderClaims("Blocking questions and checks — assessment evidence, not resolved by export", pack.blockingQuestions);
  if (pack.assessmentHistory.length) renderClaims("Checked assessment historical context — case-level only, not selected-procedure history", pack.assessmentHistory);
  lines.push("", "## Reviewed decisions and lessons — context, not automatic applicability");
  for (const record of pack.records) {
    lines.push("", `### ${text(record.recordId)} — ${record.kind}`, `Basis: ${record.basis} · Case: ${text(record.caseId)}`,
      `Reviewed by ${text(record.reviewer)} at ${record.reviewedAt}`, `Applicability: ${text(record.applicability)}`);
    if (record.supersededById) lines.push(`HISTORICAL ONLY — superseded by ${text(record.supersededById)}`);
    if (record.supersedesId) lines.push(`Supersedes: ${text(record.supersedesId)}`);
    if (record.kind === "decision") lines.push(text(record.context), text(record.choice), ...(record.recordedRationale ? [text(record.recordedRationale)] : []), ...(record.recordedRejectedAlternatives ?? []).map((alternative) => `Recorded rejected alternative: ${text(alternative)}`));
    else lines.push(text(record.observation), text(record.recommendedFutureAction), text(record.outcomeLimitations));
    lines.push(`Evidence: ${record.evidence.map((ref) => text(`${identity(ref)}/${ref.passageId}`)).join(", ")}`);
  }
  lines.push("", "## Preserved evidence excerpts — readable offline, not original bytes");
  for (const passage of pack.evidence) lines.push("", `### ${text(`${identity(passage)}/${passage.passageId}`)}`, text(passage.title),
    `Source kind: ${passage.sourceKind} · Stated date: ${passage.statedDate ?? "unknown"}`, `Location: ${text(JSON.stringify(passage.location))}`, text(passage.excerpt));
  return lines.join("\n\n") + "\n";
}

export async function exportStarterPack(env: Env, jobId: string, authorization: string | null, origin: string): Promise<StarterPack> {
  const hash = await capabilityHash(authorization);
  const job = await ownedJob(database(env), jobId, hash);
  if (job.brief_state !== "ready" || !job.brief_result) throw new HttpFailure(409, "CHECKED_BRIEF_REQUIRED");
  const corpus = await loadCorpus(env);
  return buildStarterPack(job, corpus, origin);
}
