import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { Dialog } from "@base-ui/react/dialog";
import { Select } from "@base-ui/react/select";
import { Button } from "@base-ui/react/button";
import { Field } from "@base-ui/react/field";
import { Input } from "@base-ui/react/input";
import { Collapsible } from "@base-ui/react/collapsible";
import { AppShell } from "./shell";
import type {
  ArtifactAssessment,
  ArtifactRole,
  AssessmentResult,
  AssessmentConclusion,
  ComparisonRow,
  BriefDisposition,
  BriefItem,
  BriefResult,
  CaseAssessment,
  CaseAvailability,
  Claim,
  ClaimKind,
  CreateJobRequest,
  CreateJobResponse,
  JobStage,
  JobView,
  Lead,
  KnowledgeCard,
  OutcomeStatus,
  PassageView,
  PhaseState,
  RequestConstraints,
  Selection,
  SourceRef,
  SourceCatalogEntry,
  StartBriefRequest,
  StartBriefResponse,
} from "../src/shared/protocol";
import { dispositionChanges } from "../src/ui/lineage";
import { readLocalJobs, writeLocalJobs, reopenedJobMode, type LocalJob } from "../src/ui/local-jobs";
import { checkedArtifactRefs } from "../src/ui/checked-sources";
import "./styles.css";

const phaseStates: PhaseState[] = ["not_started", "queued", "running", "ready", "failed", "reconciliation_required"];
const jobStages: JobStage[] = ["queued", "assembling", "drafting", "reference_check", "support_review", "ready", "failed", "reconciliation_required"];
const claimKinds: ClaimKind[] = ["source_fact", "interpretation", "recommendation"];
const availabilities: CaseAvailability[] = ["available", "partial", "unavailable", "failed"];
const outcomes: OutcomeStatus[] = ["observed_success", "partial", "failed", "unknown"];
const dispositions: BriefDisposition[] = ["reuse", "adapt", "verify"];
const assessmentConclusions: Record<AssessmentConclusion, string> = {
  precedent_found: "Relevant checked precedent was found.",
  no_useful_precedent: "No useful precedent was found among the eight cases with complete usable evidence.",
  cannot_be_established: "The checked evidence does not establish a reliable match or no-match conclusion. Incomplete or unavailable records are not proof of no match.",
};
function isAssessmentConclusion(value: unknown): value is AssessmentConclusion {
  return typeof value === "string" && Object.hasOwn(assessmentConclusions, value);
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function admissionFailure(response: Response, subject: string): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  const reasons: Record<string, string> = {
    ADMISSION_NOT_ENABLED: "Paid admission is disabled.",
    AUTHORIZED_CREDIT_EXHAUSTED: "Authorized credit is exhausted.",
    WORKFLOW_BUSY: "The service cannot admit another workflow yet.",
  };
  const code = isRecord(body) && isRecord(body.error) && typeof body.error.code === "string" ? body.error.code : "";
  return Object.hasOwn(reasons, code)
    ? `${subject} not admitted (HTTP ${response.status}). ${reasons[code]} No automatic retry was made.`
    : `The service could not accept the ${subject.toLowerCase()} (HTTP ${response.status}). No admission was confirmed.`;
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isTextList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isText);
}

function isSourceRef(value: unknown): value is SourceRef {
  return isRecord(value) && isText(value.caseId) && isText(value.artifactId) && isText(value.versionId) && isText(value.passageId);
}

function isSourceRefs(value: unknown): value is SourceRef[] {
  return Array.isArray(value) && value.every(isSourceRef);
}

function isKnowledgeCard(value: unknown): value is KnowledgeCard {
  if (!isRecord(value) || !isText(value.recordId) || !isText(value.caseId)
    || !["source_fact", "curator_interpretation"].includes(value.basis as string)
    || !isText(value.applicability) || !isSourceRefs(value.evidence) || value.evidence.length === 0
    || value.reviewStatus !== "reviewed" || !isText(value.reviewer) || !isText(value.reviewedAt)
    || (value.supersedesId !== undefined && !isText(value.supersedesId))
    || (value.supersededById !== undefined && !isText(value.supersededById))) return false;
  return value.kind === "decision"
    ? isText(value.context) && isText(value.choice)
      && (value.recordedRationale === undefined || isText(value.recordedRationale))
      && (value.recordedRejectedAlternatives === undefined || isTextList(value.recordedRejectedAlternatives))
    : value.kind === "lesson" && isText(value.observation) && isText(value.recommendedFutureAction) && isText(value.outcomeLimitations);
}

function isClaim(value: unknown): value is Claim {
  return isRecord(value)
    && isText(value.claimId)
    && isText(value.text)
    && claimKinds.includes(value.kind as ClaimKind)
    && isSourceRefs(value.sourceRefs)
    && isTextList(value.requestQuotes)
    && isTextList(value.dependsOnClaimIds);
}

function isArtifact(value: unknown): value is ArtifactAssessment {
  return isRecord(value)
    && isText(value.artifactId)
    && ["available", "partial", "unavailable"].includes(value.availability as string)
    && isTextList(value.exclusionReasons)
    && isTextList(value.claimIds)
    && ((value.disposition === null && value.dispositionClaimId === null)
      || (dispositions.includes(value.disposition as BriefDisposition)
        && isText(value.dispositionClaimId)
        && value.claimIds.includes(value.dispositionClaimId)))
    && isTextList(value.blockerClaimIds)
    && isTextList(value.verificationClaimIds);
}

function isCaseAssessment(value: unknown): value is CaseAssessment {
  return isRecord(value)
    && isText(value.caseId)
    && availabilities.includes(value.availability as CaseAvailability)
    && outcomes.includes(value.outcome as OutcomeStatus)
    && isTextList(value.outcomeClaimIds)
    && isTextList(value.claimIds)
    && Array.isArray(value.artifactWork) && value.artifactWork.every(isArtifact);
}

function isLead(value: unknown): value is Lead {
  return isRecord(value)
    && isText(value.caseId)
    && ["useful", "conditional", "partial"].includes(value.state as string)
    && isTextList(value.usefulArtifactIds)
    && isTextList(value.reasonClaimIds);
}
function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}


function isComparison(value: unknown): value is ComparisonRow {
  return isRecord(value) && isText(value.caseId)
    && ["product_version", "environment", "scale", "identity_access", "recovery_operations"].includes(value.dimension as string)
    && (value.requirementClaimId === null || isText(value.requirementClaimId))
    && isText(value.evidenceClaimId) && isText(value.assessmentClaimId) && isText(value.implicationClaimId)
    && ["match", "mismatch", "unknown"].includes(value.relation as string)
    && (value.requirementClaimId !== null || value.relation === "unknown");
}

function isRequestConstraints(value: unknown): value is RequestConstraints {
  return isRecord(value)
    && Object.keys(value).length === 5
    && ["product_version", "environment", "scale", "identity_access", "recovery_operations"]
      .every((dimension) => isTextList(value[dimension]) && value[dimension].length <= 8);
}

function isAssessment(value: unknown, request: string): value is AssessmentResult {
  if (!isRecord(value)
    || !Array.isArray(value.cases) || !value.cases.every(isCaseAssessment)
    || !Array.isArray(value.leads) || !value.leads.every(isLead)
    || !Array.isArray(value.contrasts) || !value.contrasts.every(isLead)
    || !Array.isArray(value.claims) || !value.claims.every(isClaim)
    || !isAssessmentConclusion(value.conclusion)
    || !isTextList(value.clarifyingClaimIds)
    || !isRequestConstraints(value.requestConstraints)
    || !Array.isArray(value.artifactReviews) || !value.artifactReviews.every((item: unknown) =>
      isRecord(item) && isText(item.caseId) && isText(item.artifactId) && ["starting_point", "context_only", "not_relevant", "unresolved"].includes(item.role as string))
    || !Array.isArray(value.comparisons) || value.comparisons.length > 24 || !value.comparisons.every(isComparison)
    || !Array.isArray(value.nextActions) || value.nextActions.length > 3
    || !value.nextActions.every((item: unknown) => isRecord(item) && isText(item.caseId) && isText(item.artifactId) && isText(item.claimId))
    || !isCount(value.withheldClaimCount)) return false;
  const requestConstraints = value.requestConstraints;
  if (Object.values(requestConstraints).some((quotes) => quotes.some((quote) => !request.includes(quote)))) return false;
  const claims = new Map<string, Claim>(value.claims.map((claim: Claim) => [claim.claimId, claim]));
  if (claims.size !== value.claims.length || value.claims.some((claim: Claim) => claim.dependsOnClaimIds.some((id) => !claims.has(id)))) return false;
  if (!value.comparisons.every((row: ComparisonRow) =>
    (row.requirementClaimId === null) === (requestConstraints[row.dimension].length === 0) &&
    (row.requirementClaimId === null || (claims.get(row.requirementClaimId)?.kind === "interpretation"
      && claims.get(row.requirementClaimId)?.requestQuotes.length === 1))
    && claims.get(row.evidenceClaimId)?.kind === "source_fact"
    && claims.get(row.assessmentClaimId)?.kind === "interpretation"
    && claims.get(row.implicationClaimId)?.kind === "recommendation"
    && claims.get(row.assessmentClaimId)?.dependsOnClaimIds.includes(row.evidenceClaimId)
    && (row.requirementClaimId === null || claims.get(row.assessmentClaimId)?.dependsOnClaimIds.includes(row.requirementClaimId))
    && claims.get(row.implicationClaimId)?.dependsOnClaimIds.includes(row.assessmentClaimId))) return false;
  const cases: CaseAssessment[] = value.cases;
  const roles = new Map<string, ArtifactRole>(value.artifactReviews.map((item: { caseId: string; artifactId: string; role: ArtifactRole }) => [`${item.caseId}/${item.artifactId}`, item.role]));
  if (roles.size !== value.artifactReviews.length
    || value.artifactReviews.some((review: { caseId: string; artifactId: string }) => !cases.some((item) => item.caseId === review.caseId && item.artifactWork.some((work) => work.artifactId === review.artifactId)))
    || cases.some((item) => item.artifactWork.some((work) => work.availability !== "unavailable" && !roles.has(`${item.caseId}/${work.artifactId}`)))
    || cases.some((item) => item.artifactWork.some((work) => (work.disposition === "reuse" || work.disposition === "adapt") && roles.get(`${item.caseId}/${work.artifactId}`) !== "starting_point"))) return false;
  if (!value.nextActions.every((action: { caseId: string; artifactId: string; claimId: string }) => {
    const work = cases.find((item) => item.caseId === action.caseId)?.artifactWork.find((item) => item.artifactId === action.artifactId);
    return work?.disposition && [...work.verificationClaimIds, ...work.blockerClaimIds].includes(action.claimId)
      && claims.get(action.claimId)?.kind === "recommendation";
  })) return false;
  if (!value.cases.every((item: CaseAssessment) => item.artifactWork.every((work) =>
    work.disposition === null || (work.dispositionClaimId !== null && claims.get(work.dispositionClaimId)?.kind === "recommendation")))) return false;
  if (value.conclusion === "precedent_found") return value.leads.length > 0;
  return true;
}

function visibleConclusion(result: AssessmentResult, claims: ClaimMap): AssessmentConclusion {
  const hasSupportedLead = result.leads.some((lead) => claimsFor(lead.reasonClaimIds, claims).length > 0);
  if (result.conclusion === "no_useful_precedent"
    && (result.cases.length !== 8
      || result.cases.some((item) => item.availability !== "available")
      || result.leads.length > 0
      || result.artifactReviews.some((item) => item.role === "starting_point" || item.role === "unresolved"))) {
    return "cannot_be_established";
  }
  if (result.conclusion === "precedent_found" && !hasSupportedLead) return "cannot_be_established";
  return result.conclusion;
}

function isBriefItem(value: unknown): value is BriefItem {
  return isRecord(value)
    && isText(value.artifactId)
    && isText(value.caseId)
    && isText(value.versionId)
    && dispositions.includes(value.disposition as BriefDisposition)
    && isText(value.dispositionClaimId)
    && isTextList(value.claimIds)
    && value.claimIds.includes(value.dispositionClaimId);
}

function isBrief(value: unknown): value is BriefResult {
  if (!isRecord(value)
    || !Array.isArray(value.reuse) || !value.reuse.every(isBriefItem)
    || !Array.isArray(value.adapt) || !value.adapt.every(isBriefItem)
    || !Array.isArray(value.verify) || !value.verify.every(isBriefItem)
    || !Array.isArray(value.claims) || !value.claims.every(isClaim)
    || !isCount(value.withheldClaimCount)) return false;
  const claims = new Map<string, Claim>(value.claims.map((claim: Claim) => [claim.claimId, claim]));
  return [...value.reuse, ...value.adapt, ...value.verify].every((item: BriefItem) =>
    item.claimIds.every((claimId) => claims.has(claimId))
      && claims.get(item.dispositionClaimId)?.kind === "recommendation");
}

function isPhaseState(value: unknown): value is PhaseState {
  return phaseStates.includes(value as PhaseState);
}

function isDuration(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function isJobView(value: unknown): value is JobView {
  return isRecord(value)
    && isText(value.jobId)
    && isText(value.request)
    && isText(value.createdAt)
    && isText(value.expiresAt)
    && jobStages.includes(value.stage as JobStage)
    && isPhaseState(value.assessmentState)
    && isPhaseState(value.briefState)
    && isDuration(value.assessmentQueueWaitMs)
    && isDuration(value.assessmentProcessingMs)
    && isDuration(value.briefQueueWaitMs)
    && isDuration(value.briefProcessingMs)
    && (value.assessment === undefined || isAssessment(value.assessment, value.request))
    && (value.brief === undefined || isBrief(value.brief))
    && (value.error === undefined || (isRecord(value.error) && isText(value.error.code) && isText(value.error.message) && typeof value.error.retryable === "boolean"));
}
function isStartBriefResponse(value: unknown): value is StartBriefResponse {
  return isRecord(value) && isText(value.jobId) && isPhaseState(value.briefState);
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}

function JobTimings({ job }: { job: JobView }) {
  return (
    <section className="job-timings" aria-label="Job time targets and observed timings">
      <div className="timing-phase">
        <h3>Assessment</h3>
        <p className="timing-target">Target: 90 s processing; queue wait is reported separately</p>
        <dl>
          {job.assessmentQueueWaitMs !== null && <div><dt>Observed queue wait</dt><dd>{formatDuration(job.assessmentQueueWaitMs)}</dd></div>}
          {job.assessmentProcessingMs !== null && <div><dt>Observed processing time</dt><dd>{formatDuration(job.assessmentProcessingMs)}</dd></div>}
        </dl>
        {job.assessmentState !== "not_started" && job.assessmentQueueWaitMs === null && job.assessmentProcessingMs === null && <p className="timing-target">Observed timing unavailable: timestamps are missing or inconsistent.</p>}
      </div>
      <div className="timing-phase">
        <h3>Brief</h3>
        <p className="timing-target">Target: 30 s processing; queue wait is reported separately</p>
        <dl>
          {job.briefQueueWaitMs !== null && <div><dt>Observed queue wait</dt><dd>{formatDuration(job.briefQueueWaitMs)}</dd></div>}
          {job.briefProcessingMs !== null && <div><dt>Observed processing time</dt><dd>{formatDuration(job.briefProcessingMs)}</dd></div>}
        </dl>
        {job.briefState !== "not_started" && job.briefQueueWaitMs === null && job.briefProcessingMs === null && <p className="timing-target">Observed timing unavailable: timestamps are missing or inconsistent.</p>}
      </div>
    </section>
  );
}


function isCreateJobResponse(value: unknown): value is CreateJobResponse {
  return isRecord(value) && isText(value.jobId) && isText(value.capability) && isText(value.expiresAt)
    && Number.isFinite(Date.parse(value.expiresAt)) && Date.parse(value.expiresAt) > Date.now();
}

function isLocation(value: unknown): value is PassageView["location"] {
  return isRecord(value) && Object.values(value).every((item) =>
    item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean"
      || (Array.isArray(item) && item.every((entry) => typeof entry === "string")));
}

function isPassage(value: unknown, expected: SourceRef): value is PassageView {
  return isRecord(value)
    && value.caseId === expected.caseId
    && value.artifactId === expected.artifactId
    && value.versionId === expected.versionId
    && value.passageId === expected.passageId
    && isText(value.title)
    && value.fictional === true
    && (value.statedDate === null || isText(value.statedDate))
    && isText(value.excerpt)
    && ["native", "ocr_transcription", "visual_observation", "visual_interpretation"].includes(value.sourceKind as string)
    && isLocation(value.location);
}

const labels: Record<string, string> = {
  not_started: "Not started",
  queued: "Queued",
  running: "In progress",
  ready: "Ready",
  failed: "Failed",
  reconciliation_required: "Needs reconciliation",
  useful: "Useful lead",
  conditional: "Conditional lead",
  partial: "Partial outcome",
  available: "Available evidence",
  partial_evidence: "Partial evidence",
  unavailable: "Unavailable evidence",
  observed_success: "Observed success",
  precedent_found: "Precedent found",
  no_useful_precedent: "No useful precedent found",
  cannot_be_established: "Cannot be established",
  unknown: "Outcome unknown",
  source_fact: "Source fact",
  interpretation: "Interpretation",
  recommendation: "Recommendation",
  reuse: "Reuse",
  adapt: "Adapt",
  verify: "Verify",
  assembling: "Assembling examples",
  drafting: "Drafting results — not yet checked",
  reference_check: "Checking references",
  support_review: "Reviewing support",
  native: "Native text",
  ocr_transcription: "Audited OCR transcription",
  visual_observation: "Audited visual observation",
  visual_interpretation: "Audited visual interpretation",
};

function label(value: string): string {
  return labels[value] ?? value.replaceAll("_", " ");
}
function leadStateLabel(state: Lead["state"]): string {
  return state === "partial" ? "Partial lead" : label(state);
}


function Badge({ children, tone = "neutral" }: { children: string; tone?: string }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

type ClaimMap = Map<string, Claim>;
type InspectPassage = (ref: SourceRef) => void;

function claimsFor(ids: string[], claims: ClaimMap): Claim[] {
  return Array.from(new Set(ids)).flatMap((id) => {
    const claim = claims.get(id);
    return claim ? [claim] : [];
  });
}

function StringList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="detail-group">
      <h4>{title}</h4>
      <ul>{items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>
    </div>
  );
}

function SourceLinks({ refs, inspect, compact = false }: { refs: SourceRef[]; inspect: InspectPassage; compact?: boolean }) {
  if (refs.length === 0) return <p className="muted">No checked source references are available.</p>;
  const uniqueRefs = Array.from(new Map(refs.map((ref) => [`${ref.versionId}\u0000${ref.passageId}`, ref])).values());
  if (compact) return <div className="source-links" aria-label="Checked comparison evidence">{uniqueRefs.map((ref, index) =>
    <button key={`${ref.versionId}-${ref.passageId}`} className="text-button" type="button" onClick={() => inspect(ref)}>Inspect evidence{uniqueRefs.length > 1 ? ` ${index + 1}` : ""}</button>)}</div>;
  return (
    <div className="source-links" aria-label="Checked source records">
      {uniqueRefs.map((ref) => (
        <div className="source-link" key={`${ref.versionId}-${ref.passageId}`}>
          <span className="record-id">Case {ref.caseId} · Artifact {ref.artifactId} · Passage {ref.passageId} · Version {ref.versionId}</span>
          <button className="text-button" type="button" onClick={() => inspect(ref)}>Inspect checked passage</button>
          <a href={`/api/evidence/originals/${encodeURIComponent(ref.versionId)}`}>Download exact fictional original</a>
        </div>
      ))}
    </div>
  );
}

function ClaimCard({ claim, inspect }: { claim: Claim; inspect: InspectPassage }) {
  return (
    <article className="claim-card">
      <div className="card-heading"><Badge tone={claim.kind}>{label(claim.kind)}</Badge></div>
      <p>{claim.text}</p>
      {claim.requestQuotes.length > 0 && <StringList title="Client request excerpts" items={claim.requestQuotes} />}
      <SourceLinks refs={claim.sourceRefs} inspect={inspect} />
    </article>
  );
}

function ClaimGroup({ title, ids, claims, inspect }: { title: string; ids: string[]; claims: ClaimMap; inspect: InspectPassage }) {
  if (ids.length === 0) return null;
  const supported = claimsFor(ids, claims);
  return (
    <section className="claim-group">
      <h4>{title}</h4>
      {supported.length === 0
        ? <p className="muted small">No checked claim text is available for this section.</p>
        : <div className="claim-list">{supported.map((claim) => <ClaimCard key={claim.claimId} claim={claim} inspect={inspect} />)}</div>}
    </section>
  );
}

function WithheldNote({ count }: { count: number }) {
  if (count === 0) return null;
  return <p className="withheld-note" role="note">{count} claim{count === 1 ? " was" : "s were"} withheld during evidence review. Withheld text is not shown.</p>;
}

function LeadCard({ lead, contrast = false, claims, inspect }: { lead: Lead; contrast?: boolean; claims: ClaimMap; inspect: InspectPassage }) {
  return (
    <article className={`lead-card${contrast ? " contrast-card" : ""}`}>
      <div className="card-heading">
        <span className="record-id">Case {lead.caseId}</span>
        <Badge tone={contrast ? "contrast" : lead.state}>{contrast ? "Contrast — not a recommendation" : leadStateLabel(lead.state)}</Badge>
      </div>
      <StringList title="Related fictional artifacts" items={lead.usefulArtifactIds} />
      <ClaimGroup title={contrast ? "Checked contrast claims" : "Why this lead may be relevant"} ids={lead.reasonClaimIds} claims={claims} inspect={inspect} />
    </article>
  );
}

function ComparisonTable({ rows, claims, inspect }: { rows: ComparisonRow[]; claims: ClaimMap; inspect: InspectPassage }) {
  if (!rows.length) return <p className="muted">No supported dimension comparison is established.</p>;
  return <div className="comparison-scroll" tabIndex={0} role="region" aria-label="Checked applicability comparison">
    <table className="comparison-table">
      <caption>Topical similarity is not demonstrated applicability. Unknowns prevent assuming unchanged reuse.</caption>
      <thead><tr><th scope="col">Dimension</th><th scope="col">Current requirement</th><th scope="col">Past evidence</th><th scope="col">Applicability</th><th scope="col">Reuse implication</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.assessmentClaimId}>
        <th scope="row">{label(row.dimension)}</th>
        <td>{row.requirementClaimId === null ? "Unknown — not stated in this request." : claims.get(row.requirementClaimId)?.requestQuotes[0]}</td>
        <td>{claims.get(row.evidenceClaimId)?.text}<SourceLinks refs={claims.get(row.evidenceClaimId)?.sourceRefs ?? []} inspect={inspect} compact /></td>
        <td><Badge tone={row.relation === "unknown" ? "unknown" : row.relation === "mismatch" ? "failed" : "neutral"}>{row.relation === "unknown" ? "Unknown" : row.relation === "match" ? "Match" : "Mismatch"}</Badge><p>{claims.get(row.assessmentClaimId)?.text}</p></td>
        <td>{claims.get(row.implicationClaimId)?.text}<SourceLinks refs={claims.get(row.implicationClaimId)?.sourceRefs ?? []} inspect={inspect} compact /></td>
      </tr>)}</tbody>
    </table>
  </div>;
}

type PreviousAssessment = Pick<JobView, "request" | "expiresAt" | "assessment">;

function AssessmentLineage({ previous, current, inspect }: { previous: PreviousAssessment; current?: AssessmentResult; inspect: InspectPassage }) {
  if (!previous.assessment) return null;
  const changes = current ? dispositionChanges(previous.assessment, current) : [];
  const supportedChanges = changes.filter((change) => change.currentClaim !== null);
  const noLongerEstablished = changes.filter((change) => change.currentClaim === null);
  const previousClaims = new Map(previous.assessment.claims.map((claim) => [claim.claimId, claim]));
  const currentClaims = new Map((current?.claims ?? []).map((claim) => [claim.claimId, claim]));
  return <section className="content-section lineage-section" aria-label="Assessment lineage">
    <h3>Clarification recheck</h3>
    <p>Previous selections were cleared. Only the immediately previous checked assessment is retained in this tab, until its original expiry.</p>
    {current ? <><p>Previous conclusion: {label(visibleConclusion(previous.assessment, previousClaims))}. Current conclusion: {label(visibleConclusion(current, currentClaims))}.</p>
      <h4>Supported disposition changes</h4>
      {supportedChanges.length ? supportedChanges.map((change) => <article className="claim-card" key={`${change.caseId}/${change.artifactId}`}>
        <h4>{change.caseId} / {change.artifactId}: {label(change.before)} → {label(change.after!)}</h4>
        <p><strong>Previous:</strong> {change.previousClaim.text}</p><SourceLinks refs={change.previousClaim.sourceRefs} inspect={inspect} />
        <p><strong>Current:</strong> {change.currentClaim!.text}</p><SourceLinks refs={change.currentClaim!.sourceRefs} inspect={inspect} />
      </article>) : <p>No disposition change is established by two checked recommendations. Missing or withheld recommendations are not a supported change.</p>}
      {noLongerEstablished.length > 0 && <div className="notice notice-warning">
        <h4>Prior lead recommendations no longer established</h4>
        <ul>{noLongerEstablished.map((change) => <li key={`${change.caseId}/${change.artifactId}`}>{change.caseId} / {change.artifactId}: previous {label(change.before)} → not established. The current recommendation is missing or withheld, not a supported replacement.</li>)}</ul>
      </div>}
      <p className="muted">These compare checked results, not a claim that clarification alone caused a change.</p>
    </> : <p>The recheck has not produced a checked result. The previous result below is historical, not the current recommendation.</p>}
    <details><summary>Previous checked assessment — read only</summary>
      <p className="field-hint">Historical only. Expires <time dateTime={previous.expiresAt}>{new Date(previous.expiresAt).toLocaleString()}</time>. Previous work and brief cannot be selected or reused here.</p>
      <div className="submitted-request"><h4>Previous request</h4><p>{previous.request}</p></div>
      <p>{assessmentConclusions[visibleConclusion(previous.assessment, previousClaims)]}</p>
      <WithheldNote count={previous.assessment.withheldClaimCount} />
      {previous.assessment.leads.filter((lead) => claimsFor(lead.reasonClaimIds, previousClaims).length > 0).map((lead) => <LeadCard key={lead.caseId} lead={lead} claims={previousClaims} inspect={inspect} />)}
      {previous.assessment.contrasts.filter((lead) => claimsFor(lead.reasonClaimIds, previousClaims).length > 0).map((lead) => <LeadCard key={lead.caseId} lead={lead} contrast claims={previousClaims} inspect={inspect} />)}
      <h4>Previous availability and outcomes</h4>
      <ul>{previous.assessment.cases.map((item) => <li key={item.caseId}>{item.caseId}: {label(item.availability)} · Outcome: {label(claimsFor(item.outcomeClaimIds, previousClaims).length ? item.outcome : "unknown")}</li>)}</ul>
      <ComparisonTable rows={previous.assessment.comparisons} claims={previousClaims} inspect={inspect} />
      <ClaimGroup title="Previous checked claims" ids={previous.assessment.claims.map((claim) => claim.claimId)} claims={previousClaims} inspect={inspect} />
    </details>
  </section>;
}

function CuratedCard({ record, inspect }: { record: KnowledgeCard; inspect: InspectPassage }) {
  return <article className="claim-card" id={record.recordId}>
    <div className="card-heading">
      <h3>{record.kind === "decision" ? "Decision" : "Lesson"}: {record.recordId}</h3>
      <Badge tone={record.basis}>{record.basis === "source_fact" ? "Recorded source facts" : "Curator interpretation"}</Badge>
    </div>
    <p className="record-id">Fictional case {record.caseId} · Human reviewed by {record.reviewer} on {record.reviewedAt}</p>
    {record.supersededById && <p className="notice notice-warning"><strong>Historical — superseded; not current advice.</strong>{" "}
      <a href={`?knowledge=${encodeURIComponent(record.supersededById)}`}>Inspect correction: {record.supersededById}</a></p>}
    {record.supersedesId && <p>Corrects <a href={`?knowledge=${encodeURIComponent(record.supersedesId)}`}>{record.supersedesId}</a>; the earlier record remains inspectable.</p>}
    {record.kind === "decision" ? <>
      <h4>Context</h4><p>{record.context}</p>
      <h4>Recorded choice</h4><p>{record.choice}</p>
      <h4>Recorded rationale</h4><p>{record.recordedRationale ?? "Not recorded."}</p>
      <h4>Recorded rejected alternatives</h4>
      {record.recordedRejectedAlternatives ? <ul>{record.recordedRejectedAlternatives.map((item) => <li key={item}>{item}</li>)}</ul> : <p>Not recorded.</p>}
    </> : <>
      <h4>Observation</h4><p>{record.observation}</p>
      <h4>Recommended future action — requires a checked application</h4><p>{record.recommendedFutureAction}</p>
      <h4>Outcome and limitations</h4><p>{record.outcomeLimitations}</p>
    </>}
    <h4>Applicability</h4><p>{record.applicability}</p>
    <p className="field-hint">Historical evidence is not approval for a new request. Applying this record requires a checked recommendation against relevant passages and the client's constraints.</p>
    <SourceLinks refs={record.evidence} inspect={inspect} />
    <a href={`?knowledge=${encodeURIComponent(record.recordId)}`}>Permanent record link</a>
  </article>;
}

function CuratedKnowledge({ caseId, recordId, inspect }: { caseId?: string; recordId?: string; inspect: InspectPassage }) {
  const [records, setRecords] = useState<KnowledgeCard[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setRecords(null);
    setError(false);
    const path = recordId ? `/api/knowledge/${encodeURIComponent(recordId)}` : `/api/knowledge${caseId ? `?caseId=${encodeURIComponent(caseId)}` : ""}`;
    void (async () => {
      try {
        const response = await fetch(path, { signal: controller.signal });
        if (!response.ok) throw new Error("Knowledge unavailable");
        const body: unknown = await response.json();
        const items: unknown = recordId ? [body] : isRecord(body) ? body.records : null;
        if (!Array.isArray(items) || !items.every(isKnowledgeCard)) throw new Error("Invalid knowledge response");
        setRecords(items);
      } catch {
        if (!controller.signal.aborted) setError(true);
      }
    })();
    return () => controller.abort();
  }, [caseId, recordId]);
  if (error) return <p className="notice notice-error" role="alert">Reviewed knowledge or its exact source evidence is unavailable.</p>;
  if (records === null) return <p role="status">Loading reviewed knowledge…</p>;
  if (records.length === 0) return caseId ? null : <p>No reviewed knowledge records are available.</p>;
  return <section className="content-section" aria-label="Reviewed decisions and lessons">
    <h2>Reviewed decisions and lessons</h2>
    <div className="claim-list">{records.map((record) => <CuratedCard key={record.recordId} record={record} inspect={inspect} />)}</div>
  </section>;
}

function KnowledgePage({ recordId }: { recordId?: string }) {
  const [passageRef, setPassageRef] = useState<SourceRef | null>(null);
  return <section className="workflow" aria-labelledby="knowledge-title">
    <div className="intro"><p className="eyebrow">Human-reviewed context</p><h1 id="knowledge-title">Reviewed knowledge</h1>
      <p>Decisions and lessons from fictional past work, independent of expiring assessment jobs.</p></div>
    {recordId && <a href="/?knowledge" className="back-link">All reviewed records</a>}
    <div className="screen"><CuratedKnowledge recordId={recordId} inspect={setPassageRef} /></div>
    <EvidenceDialog sourceRef={passageRef} onClose={() => setPassageRef(null)} />
  </section>;
}

function isSourceCatalogEntry(value: unknown): value is SourceCatalogEntry {
  return isRecord(value) && isText(value.caseId) && isText(value.caseTitle)
    && isText(value.artifactId) && isText(value.title) && isText(value.versionId)
    && isText(value.mimeType) && (value.statedDate === null || isText(value.statedDate))
    && value.fictional === true && ["available", "incomplete", "unavailable"].includes(value.availability as string)
    && Array.isArray(value.exclusionReasons) && value.exclusionReasons.every(isText)
    && Array.isArray(value.passages) && value.passages.every((ref: unknown) =>
      isSourceRef(ref) && isRecord(ref) && ref.caseId === value.caseId
      && ref.artifactId === value.artifactId && ref.versionId === value.versionId
      && ["native", "ocr_transcription", "visual_observation", "visual_interpretation"].includes(ref.sourceKind as string))
    && (value.availability === "available" || value.passages.length === 0);
}

function SourceFilter({ title, value, options, onChange }: {
  title: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void;
}) {
  return <Select.Root items={options} value={value} onValueChange={(next) => { if (next !== null) onChange(next); }}>
    <div className="source-filter"><Select.Label className="field-label">{title}</Select.Label>
      <Select.Trigger className="version-select-trigger"><Select.Value /><Select.Icon aria-hidden="true">⌄</Select.Icon></Select.Trigger>
    </div>
    <Select.Portal><Select.Positioner className="version-select-positioner" sideOffset={6} collisionPadding={12}>
      <Select.Popup className="version-select-popup"><Select.List className="version-select-list">
        {options.map((option) => <Select.Item key={option.value} value={option.value} className="version-select-item">
          <Select.ItemText>{option.label}</Select.ItemText><Select.ItemIndicator aria-hidden="true">✓</Select.ItemIndicator>
        </Select.Item>)}
      </Select.List></Select.Popup>
    </Select.Positioner></Select.Portal>
  </Select.Root>;
}

function SourcesPage() {
  const [sources, setSources] = useState<SourceCatalogEntry[] | null>(null);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState("");
  const [caseId, setCaseId] = useState("");
  const [mimeType, setMimeType] = useState("");
  const [passageRef, setPassageRef] = useState<SourceRef | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/sources", { signal: controller.signal });
        if (!response.ok) throw new Error("Sources unavailable");
        const body: unknown = await response.json();
        if (!isRecord(body) || !Array.isArray(body.sources) || !body.sources.every(isSourceCatalogEntry)) throw new Error("Invalid source inventory");
        if (!controller.signal.aborted) setSources(body.sources);
      } catch {
        if (!controller.signal.aborted) setError(true);
      }
    })();
    return () => controller.abort();
  }, []);
  const caseOptions = [...new Map((sources ?? []).map((source) => [source.caseId, { value: source.caseId, label: source.caseTitle }])).values()];
  const typeOptions = [...new Set((sources ?? []).map((source) => source.mimeType))].map((type) => ({ value: type, label: type }));
  const needle = query.trim().toLocaleLowerCase();
  const filtered = (sources ?? []).filter((source) => (!caseId || source.caseId === caseId)
    && (!mimeType || source.mimeType === mimeType)
    && (!needle || `${source.title} ${source.caseTitle}`.toLocaleLowerCase().includes(needle)));
  return <section className="workflow" aria-labelledby="sources-title">
    <div className="intro"><p className="eyebrow">The original work, not a summary</p><h1 id="sources-title">Sources</h1>
      <p>Browse the fictional corpus. Inspect exact retained passages and download their originals. This is not an AI relevance assessment.</p></div>
    {error ? <p className="notice notice-error" role="alert">The source inventory could not be verified. Reload to try again.</p>
      : sources === null ? <p role="status">Loading source inventory…</p> : <>
        <div className="screen source-controls" role="search" aria-label="Search the source corpus">
          <Field.Root name="source-search"><Field.Label>Search sources</Field.Label>
            <Input value={query} onValueChange={setQuery} placeholder="Source title or case name" className="source-search" type="search" />
          </Field.Root>
          <SourceFilter title="Case" value={caseId} onChange={setCaseId} options={[{ value: "", label: "All cases" }, ...caseOptions]} />
          <SourceFilter title="File type" value={mimeType} onChange={setMimeType} options={[{ value: "", label: "All file types" }, ...typeOptions]} />
          <Button className="secondary-button" type="button" onClick={() => { setQuery(""); setCaseId(""); setMimeType(""); }} disabled={!query && !caseId && !mimeType}>Clear filters</Button>
        </div>
        <p className="source-count muted" role="status">{filtered.length} of {sources.length} retained source versions</p>
        {filtered.length === 0 ? <p className="screen empty-state">No sources match these filters. Clear the filters to browse the corpus.</p>
          : <div className="source-catalog">{filtered.map((source) => <article className="screen source-card" key={`${source.caseId}-${source.artifactId}-${source.versionId}`}>
            <div className="card-heading"><div><p className="eyebrow">{source.caseTitle}</p><h2>{source.title}</h2></div><Badge tone={source.availability}>{label(source.availability)}</Badge></div>
            <p className="record-id">Case {source.caseId} · Artifact {source.artifactId} · Retained version {source.versionId}</p>
            <div className="badge-row"><Badge tone="fictional">Fictional source</Badge><Badge>{source.mimeType}</Badge>
              {[...new Set(source.passages.map((ref) => ref.sourceKind))].map((kind) => <Badge key={kind}>{label(kind)}</Badge>)}</div>
            <p className="muted source-date">{source.statedDate ? `Stated date: ${source.statedDate}` : "No stated date"}</p>
            {source.availability === "available" ? <>
              <a href={`/api/evidence/originals/${encodeURIComponent(source.versionId)}`}>Download exact fictional original</a>
              {source.passages.length > 0 ? <Collapsible.Root className="source-passages">
                <Collapsible.Trigger render={<Button className="secondary-button" />}>Inspect passages ({source.passages.length})</Collapsible.Trigger>
                <Collapsible.Panel><SourceLinks refs={source.passages} inspect={setPassageRef} /></Collapsible.Panel>
              </Collapsible.Root> : <p className="muted">No inspectable passages are retained.</p>}
            </> : <StringList title="Source unavailable for use" items={source.exclusionReasons} />}
          </article>)}</div>}
      </>}
    <EvidenceDialog sourceRef={passageRef} onClose={() => setPassageRef(null)} />
  </section>;
}

function CaseCard({ item, claims, inspect }: { item: CaseAssessment; claims: ClaimMap; inspect: InspectPassage }) {
  const outcomeHasSupport = claimsFor(item.outcomeClaimIds, claims).length > 0;
  return (
    <article className="case-card">
      <div className="card-heading">
        <span className="record-id">Case {item.caseId}</span>
        <div className="badge-row">
          <Badge tone={item.availability}>{label(item.availability === "partial" ? "partial_evidence" : item.availability)}</Badge>
          <Badge tone={outcomeHasSupport ? item.outcome : "unknown"}>{outcomeHasSupport ? label(item.outcome) : "Outcome not established"}</Badge>
        </div>
      </div>
      <ClaimGroup title="Checked case claims" ids={item.claimIds} claims={claims} inspect={inspect} />
      <ClaimGroup title="Evidence for observed outcome" ids={item.outcomeClaimIds} claims={claims} inspect={inspect} />
      <CuratedKnowledge caseId={item.caseId} inspect={inspect} />
    </article>
  );
}

function WorkCard({
  item,
  caseId,
  availability,
  reviewRole,
  claims,
  draft,
  onChange,
  inspect,
}: {
  item: ArtifactAssessment;
  caseId: string;
  availability: CaseAvailability;
  reviewRole: ArtifactRole | undefined;
  claims: ClaimMap;
  draft: WorkDraft;
  onChange: (next: WorkDraft) => void;
  inspect: InspectPassage;
}) {
  const otherClaimIds = item.claimIds.filter((id) => id !== item.dispositionClaimId);
  const hasSupportedWorkClaim = claimsFor(item.claimIds, claims).length > 0;
  const refs = checkedArtifactRefs(caseId, availability, item, claims);
  const versions = Array.from(new Set(refs.map((ref) => ref.versionId)));
  const selectedVersion = versions.includes(draft.versionId) ? draft.versionId : (versions[0] ?? "");
  const passageRefs = Array.from(new Map(
    refs.filter((ref) => ref.versionId === selectedVersion).map((ref) => [ref.passageId, ref]),
  ).values());
  const canSelect = item.disposition !== null && item.availability !== "unavailable" && (availability === "available" || availability === "partial") && hasSupportedWorkClaim && versions.length > 0;
  const blocked = item.availability === "unavailable" || availability === "failed" || availability === "unavailable";
  return (
    <article className={`work-card${draft.selected ? " work-card-selected" : ""}`}>
      <div className="card-heading">
        <div>
          <p className="eyebrow">Fictional work artifact</p>
          <h3>Artifact {item.artifactId}</h3>
        </div>
        {item.availability === "unavailable"
          ? <Badge tone="unavailable">Not assessed</Badge>
          : hasSupportedWorkClaim && item.disposition
            ? <Badge tone={item.disposition}>{label(item.disposition)}</Badge>
            : reviewRole === "context_only" || reviewRole === "not_relevant"
              ? <Badge tone="neutral">{reviewRole === "context_only" ? "Context only" : "Not applicable"}</Badge>
            : <Badge tone="unknown">Disposition withheld</Badge>}
      </div>
      <div className="badge-row status-row">
        <Badge tone={item.availability}>{`Artifact: ${label(item.availability)}`}</Badge>
      </div>
      <ClaimGroup title="Reviewed disposition recommendation" ids={item.dispositionClaimId ? [item.dispositionClaimId] : []} claims={claims} inspect={inspect} />
      <ClaimGroup title="Checked work claims" ids={otherClaimIds} claims={claims} inspect={inspect} />
      <ClaimGroup title="Blockers" ids={item.blockerClaimIds} claims={claims} inspect={inspect} />
      <ClaimGroup title="Verification claims" ids={item.verificationClaimIds} claims={claims} inspect={inspect} />
      {item.exclusionReasons.length > 0 && (
        <ul className="inline-blocker" aria-label="Excluded source versions">
          {item.exclusionReasons.map((reason, index) => <li key={`${index}-${reason}`}>{reason}</li>)}
        </ul>
      )}
      <SourceLinks refs={refs} inspect={inspect} />
      {blocked && <p className="inline-blocker">{item.availability === "unavailable" ? "No usable source version is available; this artifact was not assessed and cannot be selected." : `This case is ${label(availability).toLowerCase()}; this work cannot be selected.`}</p>}
      {!canSelect && !blocked && <p className="inline-blocker">{hasSupportedWorkClaim ? "No checked passage is available for selection." : "No supported work claim is available; this artifact cannot be selected."}</p>}
      <label className="select-work">
        <input
          type="checkbox"
          checked={draft.selected}
          disabled={!canSelect}
          onChange={(event) => onChange({ ...draft, selected: event.currentTarget.checked, versionId: selectedVersion })}
        />
        <span>Include this work in the brief</span>
      </label>
      {draft.selected && canSelect && (
        <div className="passage-picker">
          {versions.length > 1 && (
            <div>
              <Select.Root value={selectedVersion} onValueChange={(versionId) => {
                if (versionId !== null) onChange({ ...draft, versionId, passageIds: [] });
              }}>
                <Select.Label className="field-label">Retained version</Select.Label>
                <Select.Trigger className="version-select-trigger">
                  <Select.Value />
                  <Select.Icon aria-hidden="true">▾</Select.Icon>
                </Select.Trigger>
                <Select.Portal>
                  <Select.Positioner className="version-select-positioner" sideOffset={4} alignItemWithTrigger={false}>
                    <Select.Popup className="version-select-popup">
                      <Select.List className="version-select-list">
                        {versions.map((versionId) => (
                          <Select.Item className="version-select-item" key={versionId} value={versionId}>
                            <Select.ItemIndicator className="version-select-indicator" aria-hidden="true">✓</Select.ItemIndicator>
                            <Select.ItemText>{versionId}</Select.ItemText>
                          </Select.Item>
                        ))}
                      </Select.List>
                    </Select.Popup>
                  </Select.Positioner>
                </Select.Portal>
              </Select.Root>
            </div>
          )}
          {versions.length === 1 && <p className="muted small">Retained version: <span className="record-id">{selectedVersion}</span></p>}
          <fieldset>
            <legend>Select checked passages to include</legend>
            {passageRefs.length === 0 ? <p className="muted">No passages are available for this retained version.</p> : passageRefs.map((ref) => (
              <div className="passage-option" key={ref.passageId}>
                <label>
                  <input
                    type="checkbox"
                    checked={draft.passageIds.includes(ref.passageId)}
                    onChange={(event) => {
                      const passageIds = event.currentTarget.checked
                        ? [...new Set([...draft.passageIds, ref.passageId])]
                        : draft.passageIds.filter((id) => id !== ref.passageId);
                      onChange({ ...draft, versionId: selectedVersion, passageIds });
                    }}
                  />
                  <span>Passage <span className="record-id">{ref.passageId}</span></span>
                </label>
                <button className="text-button" type="button" onClick={() => inspect(ref)}>Inspect</button>
              </div>
            ))}
          </fieldset>
        </div>
      )}
    </article>
  );
}

function BriefCard({ item, claims, inspect }: { item: BriefItem; claims: ClaimMap; inspect: InspectPassage }) {
  return (
    <article className="brief-card">
      <div className="card-heading">
        <div>
          <p className="eyebrow">Fictional work artifact · Case {item.caseId} · Version {item.versionId}</p>
          <h3>Artifact {item.artifactId}</h3>
        </div>
        <Badge tone={item.disposition}>{label(item.disposition)}</Badge>
      </div>
      <div className="source-links"><a href={`/api/evidence/originals/${encodeURIComponent(item.versionId)}`}>Download exact selected original</a></div>
      <ClaimGroup title="Reviewed disposition recommendation" ids={[item.dispositionClaimId]} claims={claims} inspect={inspect} />
      <ClaimGroup title="Supporting checked claims" ids={item.claimIds.filter((id) => id !== item.dispositionClaimId)} claims={claims} inspect={inspect} />
    </article>
  );
}

function PackExport({ session, expiresAt }: { session: Session; expiresAt: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(Date.parse(expiresAt) <= Date.now());
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, Date.parse(expiresAt) - Date.now()));
    return () => { window.clearTimeout(timer); controller.current?.abort(); };
  }, [expiresAt]);
  async function download(format: "markdown" | "json") {
    if (busy || expired) return;
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(session.jobId)}/pack/${format}`, {
        headers: { Authorization: `Bearer ${session.capability}` }, signal: request.signal,
      });
      if (!response.ok) {
        if (response.status === 410) setExpired(true);
        throw new Error(response.status === 503 ? "Export blocked: exact source evidence is unavailable or corrupt. No replacement version was used." : `Export unavailable (HTTP ${response.status}). A ready owned unexpired checked brief is required.`);
      }
      const blob = await response.blob();
      if (request.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `starter-pack-${session.jobId}.${format === "json" ? "json" : "md"}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : "Export could not be downloaded.");
    } finally {
      if (!request.signal.aborted) setBusy(false);
    }
  }
  return <section className="content-section" aria-labelledby="pack-title">
    <h3 id="pack-title">Export evidence-linked starter pack</h3>
    <p>Review reusable material, required adaptations, and blocked verification below. Export preserves the checked brief, selected version inventory, hashes, reviewed context, and cited excerpts without another model call.</p>
    <p>Fictional data only; not production approval. Excerpts remain readable offline. Originals are linked, not bundled or changed; live links are not guaranteed indefinitely. New exports stop at the application job expiry shown above.</p>
    <div className="action-row">
      <button className="secondary-button" type="button" disabled={busy || expired} onClick={() => void download("markdown")}>Download Markdown pack</button>
      <button className="secondary-button" type="button" disabled={busy || expired} onClick={() => void download("json")}>Download JSON manifest</button>
    </div>
    {busy && <p role="status">Validating selected sources and preparing export…</p>}
    {expired && <p role="alert">Job expired. No new export is available; already downloaded packs remain readable offline.</p>}
    {error && <p className="notice notice-error" role="alert">{error}</p>}
  </section>;
}

interface WorkDraft {
  selected: boolean;
  versionId: string;
  passageIds: string[];
}

type Session = CreateJobResponse;

type PollMode = "assessment" | "brief" | "restore" | null;

function readBrowserJobs() {
  try { return readLocalJobs(window.localStorage); }
  catch { return { entries: [] as LocalJob[], error: "Local History/Saved persistence failed. Browser storage may be unavailable or full; use browser settings to clear retained data. The main workflow still works in this tab." }; }
}

function EvidencePassage({ sourceRef }: { sourceRef: SourceRef }) {
  const [passage, setPassage] = useState<PassageView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const passageId = sourceRef.passageId;
    const controller = new AbortController();
    let active = true;
    setPassage(null);
    setError(null);
    setLoading(true);
    fetch(`/api/evidence/passages/${encodeURIComponent(passageId)}`, { signal: controller.signal })
      .then(async (response) => {
        if (response.status !== 200) throw new Error("passage unavailable");
        return response.json() as Promise<unknown>;
      })
      .then((body) => {
        if (!active) return;
        if (!isPassage(body, sourceRef)) {
          setError("This passage could not be verified as fictional checked evidence.");
          return;
        }
        setPassage(body);
      })
      .catch(() => {
        if (active && !controller.signal.aborted) setError("The checked passage could not be retrieved. Try again later.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [sourceRef]);

  return (
    <>
      {loading && <p role="status" className="muted">Retrieving the checked passage…</p>}
      {error && <p role="alert" className="notice notice-error">{error}</p>}
      {passage && (
        <div className="passage-content">
          <div className="badge-row"><Badge tone="fictional">Fictional record</Badge><Badge>{label(passage.sourceKind)}</Badge></div>
          <h3>{passage.title}</h3>
          <p className="muted">{passage.statedDate ? `Stated date: ${passage.statedDate}` : "No stated date"}</p>
          <blockquote>{passage.excerpt}</blockquote>
          {Object.keys(passage.location).length > 0 && (
            <dl className="location-list">
              {Object.entries(passage.location).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{Array.isArray(value) ? value.join(", ") : value === null ? "Not stated" : String(value)}</dd></div>)}
            </dl>
          )}
          <div className="source-links"><a href={`/api/evidence/originals/${encodeURIComponent(passage.versionId)}`}>Download exact fictional original</a></div>
        </div>
      )}
    </>
  );
}

function EvidenceDialog({ sourceRef, onClose }: { sourceRef: SourceRef | null; onClose: () => void }) {
  return (
    <Dialog.Root open={sourceRef !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="evidence-backdrop" />
        <Dialog.Popup className="evidence-dialog" aria-modal="true">
          <div className="dialog-header">
            <div>
              <Dialog.Description className="eyebrow">Checked evidence · Fictional source</Dialog.Description>
              <Dialog.Title>Exact passage</Dialog.Title>
            </div>
            <Dialog.Close className="icon-button" aria-label="Close passage">Close</Dialog.Close>
          </div>
          {sourceRef && <p className="record-id">Requested source: Case {sourceRef.caseId} · Artifact {sourceRef.artifactId} · Retained version {sourceRef.versionId} · Passage {sourceRef.passageId}</p>}
          {sourceRef && <EvidencePassage key={JSON.stringify(sourceRef)} sourceRef={sourceRef} />}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const stepNames = ["Client request", "Checked examples", "Selected work", "Checked brief"];

// Authored from public fictional corpus requests, never held-out evaluation requests.
const suggestedRequests = [
  { title: "Plan a sandbox CSV import", basis: "Cedar Supply", request: "Plan a sandbox import of active supplier records from a UTF-8 CSV. Preserve source keys and reconcile accepted, rejected, and duplicate rows. What past mapping and reconciliation work could help, and what must we verify for a new target? No production writes are authorized." },
  { title: "Scope temporary support access", basis: "Grove Clinic", request: "Two external support engineers need temporary read-only access to import errors in a test workspace. Require named accounts, MFA, expiry, and an access log; exclude patient charts and configuration changes. Find useful prior access work and identify unverified lifecycle or audit controls." },
  { title: "Prepare an operator handover", basis: "Ibis Foods", request: "Prepare a test-environment handover of a nightly inventory import to a primary and backup operator. We need a runbook, escalation contact, recovery procedure, and witnessed recovery exercise. Which past work is useful, and which acceptance gaps remain? Production scheduling is out of scope." },
];

function App({ active }: { active: boolean }) {
  const [step, setStep] = useState(1);
  const [request, setRequest] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const [previousJob, setPreviousJob] = useState<PreviousAssessment | null>(null);
  const [pollMode, setPollMode] = useState<PollMode>(null);
  const [workDrafts, setWorkDrafts] = useState<Record<string, WorkDraft>>({});
  const [serviceError, setServiceError] = useState<string | null>(null);
  const [passageRef, setPassageRef] = useState<SourceRef | null>(null);
  const [submittingRequest, setSubmittingRequest] = useState(false);
  const [questionAnswers, setQuestionAnswers] = useState("");
  const [submittedClarification, setSubmittedClarification] = useState<{ context: string; answers: string } | null>(null);
  const [submittingBrief, setSubmittingBrief] = useState(false);
  const [localData, setLocalData] = useState(readBrowserJobs);
  const [library, setLibrary] = useState<"History" | "Saved">("History");
  const sessionGeneration = useRef(0);
  const requestSubmissionId = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const briefController = useRef<AbortController | null>(null);
  const pollController = useRef<AbortController | null>(null);

  function changeLocalJobs(change: (entries: LocalJob[]) => LocalJob[]) {
    try {
      const current = readLocalJobs(window.localStorage);
      const entries = writeLocalJobs(window.localStorage, change(current.entries));
      setLocalData({ entries, error: current.error });
    } catch {
      setLocalData((current) => ({
        entries: current.entries.filter((entry) => Date.parse(entry.expiresAt) > Date.now()),
        error: "Local History/Saved persistence failed. The change was not saved; browser storage may be unavailable or full. The main workflow still works in this tab.",
      }));
    }
  }

  useEffect(() => {
    const refresh = () => setLocalData(readBrowserJobs());
    const deadlines = localData.entries.map((entry) => Date.parse(entry.expiresAt));
    const timer = deadlines.length ? window.setTimeout(refresh, Math.max(0, Math.min(...deadlines) - Date.now())) : undefined;
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [localData.entries]);

  useEffect(() => {
    if (!session) return;
    let timer: number;
    const expire = () => {
      const remaining = Date.parse(session.expiresAt) - Date.now();
      if (remaining > 0) {
        window.clearTimeout(timer);
        timer = window.setTimeout(expire, remaining);
        return;
      }
      startNewRequest();
      setRequest("");
      setLocalData(readBrowserJobs());
      setServiceError("This job reached its original expiry. Its request, results, and access capability are no longer available in this tab.");
    };
    timer = window.setTimeout(expire, Math.max(0, Date.parse(session.expiresAt) - Date.now()));
    window.addEventListener("focus", expire);
    document.addEventListener("visibilitychange", expire);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", expire);
      document.removeEventListener("visibilitychange", expire);
    };
  }, [session]);
  useEffect(() => { if (!active) setPassageRef(null); }, [active]);

  useEffect(() => {
    if (!previousJob) return;
    let timer: number;
    const expire = () => {
      const remaining = Date.parse(previousJob.expiresAt) - Date.now();
      if (Number.isFinite(remaining) && remaining > 0) {
        window.clearTimeout(timer);
        timer = window.setTimeout(expire, remaining);
        return;
      }
      setPreviousJob(null);
      setPassageRef(null);
    };
    expire();
    window.addEventListener("focus", expire);
    document.addEventListener("visibilitychange", expire);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", expire);
      document.removeEventListener("visibilitychange", expire);
    };
  }, [previousJob]);

  useEffect(() => {
    if (!session || !pollMode) return;
    const generation = sessionGeneration.current;
    const controller = new AbortController();
    pollController.current = controller;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const response = await fetch(`/api/jobs/${encodeURIComponent(session.jobId)}`, {
          headers: { Authorization: `Bearer ${session.capability}` },
          signal: controller.signal,
        });
        if (controller.signal.aborted || generation !== sessionGeneration.current) return;
        if (response.status === 404 || response.status === 410) {
          changeLocalJobs((entries) => entries.filter((entry) => entry.jobId !== session.jobId));
          startNewRequest();
          setRequest("");
          setServiceError(`This job is missing or expired (HTTP ${response.status}). No cached result is available.`);
          return;
        }
        if (response.status !== 200) {
          setServiceError(`Status check failed (HTTP ${response.status}). Retrying the real status check.`);
          timer = window.setTimeout(poll, 2500);
          return;
        }
        const body: unknown = await response.json();
        if (controller.signal.aborted || generation !== sessionGeneration.current) return;
        if (!isJobView(body) || body.jobId !== session.jobId) {
          setServiceError("The service returned an unsupported job response. No unchecked result is shown.");
          setPollMode(null);
          return;
        }
        let mode: "assessment" | "brief";
        try { mode = reopenedJobMode(session, body); }
        catch {
          startNewRequest();
          setRequest("");
          changeLocalJobs((entries) => entries.filter((entry) => entry.jobId !== session.jobId));
          setServiceError("The original live job or expiry could not be validated. No cached result is available.");
          return;
        }
        setJob(body);
        setRequest(body.request);
        setServiceError(null);
        if (pollMode === "restore") setStep(mode === "brief" ? 4 : 2);
        const currentState = (pollMode === "restore" ? mode : pollMode) === "assessment" ? body.assessmentState : body.briefState;
        if (["ready", "failed", "reconciliation_required"].includes(currentState)) {
          setPollMode(null);
          return;
        }
        timer = window.setTimeout(poll, 2500);
      } catch {
        if (!controller.signal.aborted && generation === sessionGeneration.current) {
          setServiceError("The service could not be reached. Retrying the real status check.");
          timer = window.setTimeout(poll, 2500);
        }
      }
    };
    void poll();
    return () => {
      controller.abort();
      if (pollController.current === controller) pollController.current = null;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [session, pollMode]);

  const assessment = job?.assessmentState === "ready" ? job.assessment : undefined;
  const assessmentClaims = useMemo(() => new Map((assessment?.claims ?? []).map((claim) => [claim.claimId, claim] as const)), [assessment]);
  const briefClaims = useMemo(() => new Map((job?.brief?.claims ?? []).map((claim) => [claim.claimId, claim] as const)), [job?.brief]);
  const checkedLeads = (assessment?.leads ?? []).filter((lead) => claimsFor(lead.reasonClaimIds, assessmentClaims).length > 0);
  const checkedContrasts = (assessment?.contrasts ?? []).filter((lead) => claimsFor(lead.reasonClaimIds, assessmentClaims).length > 0);
  const unrankedComparisons = useMemo(() => {
    const ranked = new Set([...(assessment?.leads ?? []), ...(assessment?.contrasts ?? [])].map((item) => item.caseId));
    const groups = new Map<string, ComparisonRow[]>();
    for (const row of assessment?.comparisons ?? []) {
      if (ranked.has(row.caseId)) continue;
      const rows = groups.get(row.caseId);
      if (rows) rows.push(row); else groups.set(row.caseId, [row]);
    }
    return [...groups];
  }, [assessment]);
  const workChoices = useMemo(() => (assessment?.cases ?? []).flatMap((caseItem) => caseItem.artifactWork.map((item) => {
    const sourceRefs = checkedArtifactRefs(caseItem.caseId, caseItem.availability, item, assessmentClaims);
    return {
      caseId: caseItem.caseId,
      availability: caseItem.availability,
      item,
      sourceRefs,
      key: `${caseItem.caseId}\u0000${item.artifactId}`,
    };
  })), [assessment, assessmentClaims]);
  const selectedCount = workChoices.filter(({ key }) => workDrafts[key]?.selected).length;
  const selections: Selection[] = workChoices.flatMap(({ caseId, item, sourceRefs, key }) => {
    const draft = workDrafts[key];
    if (!draft?.selected) return [];
    const passages = Array.from(new Set(sourceRefs
      .filter((ref) => ref.versionId === draft.versionId && draft.passageIds.includes(ref.passageId))
      .map((ref) => ref.passageId)));
    return [{ caseId, artifactId: item.artifactId, versionId: draft.versionId, passageIds: passages }];
  });
  const selectionsValid = selectedCount > 0 && selections.length === selectedCount && selections.every((selection) => selection.passageIds.length > 0);

  async function createAssessment(requestText: string, clarification = false) {
    const trimmed = requestText.trim();
    if (!trimmed || submittingRequest) return;
    if (clarification && job?.assessment && job.assessmentState === "ready" && Date.parse(job.expiresAt) > Date.now()) {
      setPreviousJob({ request: job.request, expiresAt: job.expiresAt, assessment: job.assessment });
    } else if (!clarification) {
      setPreviousJob(null);
      setSubmittedClarification(null);
    }
    sessionGeneration.current += 1;
    pollController.current?.abort();
    briefController.current?.abort();
    setWorkDrafts({});
    setPassageRef(null);
    setSubmittingBrief(false);
    setJob(null);
    setSession(null);
    setPollMode(null);
    setStep(2);
    setRequest(trimmed);
    setQuestionAnswers("");
    setServiceError(null);
    if (new TextEncoder().encode(trimmed).byteLength > 16 * 1024) {
      setServiceError("The request and answers must stay within 16 KiB. No new assessment was admitted; previous selections and brief were cleared.");
      return;
    }
    const submissionId = ++requestSubmissionId.current;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setSubmittingRequest(true);
    setServiceError(null);
    try {
      const body: CreateJobRequest = { request: trimmed };
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (submissionId !== requestSubmissionId.current || controller.signal.aborted) return;
      if (response.status !== 202) {
        const message = await admissionFailure(response, "Request");
        if (submissionId === requestSubmissionId.current && !controller.signal.aborted) setServiceError(message);
        return;
      }
      const result: unknown = await response.json();
      if (submissionId !== requestSubmissionId.current || controller.signal.aborted) return;
      if (!isCreateJobResponse(result)) {
        setServiceError("The service returned an unsupported job receipt. No capability was saved.");
        return;
      }
      sessionGeneration.current += 1;
      pollController.current?.abort();
      briefController.current?.abort();
      setRequest(trimmed);
      setQuestionAnswers("");
      setSubmittingBrief(false);
      setSession(result);
      changeLocalJobs((entries) => [
        { ...result, label: trimmed.slice(0, 100), saved: entries.find((entry) => entry.jobId === result.jobId)?.saved ?? false },
        ...entries.filter((entry) => entry.jobId !== result.jobId),
      ]);
      setJob(null);
      setWorkDrafts({});
      setPollMode("assessment");
      setStep(2);
    } catch {
      if (submissionId === requestSubmissionId.current && !controller.signal.aborted) {
        setServiceError("The service could not be reached. Your request was not confirmed.");
      }
    } finally {
      if (submissionId === requestSubmissionId.current) setSubmittingRequest(false);
      if (requestController.current === controller) requestController.current = null;
    }
  }

  async function submitRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await createAssessment(request);
  }

  async function submitClarifications(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const answers = questionAnswers.trim();
    if (!answers || submittingRequest) return;
    setSubmittedClarification({ context: request.trim(), answers });
    await createAssessment(`${request.trim()}\n\nClarifications supplied by the delivery lead:\n${answers}`, true);
  }

  function startNewRequest() {
    sessionGeneration.current += 1;
    requestSubmissionId.current += 1;
    requestController.current?.abort();
    briefController.current?.abort();
    pollController.current?.abort();
    requestController.current = null;
    briefController.current = null;
    pollController.current = null;
    setStep(1);
    setSession(null);
    setJob(null);
    setPreviousJob(null);
    setPassageRef(null);
    setPollMode(null);
    setWorkDrafts({});
    setQuestionAnswers("");
    setSubmittedClarification(null);
    setSubmittingRequest(false);
    setSubmittingBrief(false);
    setServiceError(null);
  }

  function reopen(entry: LocalJob) {
    startNewRequest();
    setRequest("");
    if (Date.parse(entry.expiresAt) <= Date.now()) {
      setLocalData(readBrowserJobs());
      setServiceError("This bookmark has expired. Saved never extends the original job access.");
      return;
    }
    setSession({ jobId: entry.jobId, capability: entry.capability, expiresAt: entry.expiresAt });
    setPollMode("restore");
    setStep(2);
  }

  function toggleSaved() {
    if (!session || !job || (!job.assessment && !job.brief)) return;
    const saved = localData.entries.find((entry) => entry.jobId === session.jobId)?.saved ?? false;
    changeLocalJobs((entries) => [
      { ...session, label: job.request.slice(0, 100), saved: !saved },
      ...entries.filter((entry) => entry.jobId !== session.jobId),
    ]);
  }

  async function submitBrief() {
    if (!session || !selectionsValid || submittingBrief) return;
    const generation = sessionGeneration.current;
    briefController.current?.abort();
    const controller = new AbortController();
    briefController.current = controller;
    setSubmittingBrief(true);
    setServiceError(null);
    try {
      const body: StartBriefRequest = { selections };
      const response = await fetch(`/api/jobs/${encodeURIComponent(session.jobId)}/brief`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.capability}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (generation !== sessionGeneration.current || controller.signal.aborted) return;
      if (response.status !== 202) {
        const message = await admissionFailure(response, "Brief");
        if (generation === sessionGeneration.current && !controller.signal.aborted) setServiceError(message);
        return;
      }
      const receipt: unknown = await response.json();
      if (generation !== sessionGeneration.current || controller.signal.aborted) return;
      if (!isStartBriefResponse(receipt) || receipt.jobId !== session.jobId) {
        setServiceError("The service returned an unsupported brief receipt. No unchecked brief is shown.");
        return;
      }
      setJob((current) => current ? { ...current, brief: undefined, briefState: receipt.briefState } : current);
      setPollMode("brief");
      setStep(4);
    } catch {
      if (generation === sessionGeneration.current && !controller.signal.aborted) {
        setServiceError("The service could not be reached. The brief was not confirmed.");
      }
    } finally {
      if (generation === sessionGeneration.current && briefController.current === controller) setSubmittingBrief(false);
      if (briefController.current === controller) briefController.current = null;
    }
  }

  function getDraft(key: string, sourceRefs: SourceRef[]): WorkDraft {
    return workDrafts[key] ?? { selected: false, versionId: sourceRefs[0]?.versionId ?? "", passageIds: [] };
  }

  function updateDraft(key: string, next: WorkDraft) {
    setWorkDrafts((current) => ({ ...current, [key]: next }));
  }

  const assessmentState = job?.assessmentState ?? "not_started";
  const briefState = job?.briefState ?? "not_started";
  const assessmentAvailable = assessmentState === "ready" && !!assessment;
  const rechecking = submittingRequest || pollMode === "assessment" || pollMode === "restore";
  const questions = assessmentAvailable ? assessment : previousJob?.assessment;
  const questionClaims = assessmentAvailable ? assessmentClaims : new Map((questions?.claims ?? []).map((claim) => [claim.claimId, claim]));

  return (
    <>
      <section className="workflow" aria-labelledby="workflow-title">
        {(session || previousJob || step > 1) && <div className="workflow-actions"><Button className="secondary-button new-request-button" type="button" onClick={startNewRequest}>New request</Button></div>}
        <div className="intro">
          <p className="eyebrow">Ask Memory Bank · fictional evidence</p>
          <h1 id="workflow-title">What can past work help you deliver?</h1>
          <p>Bring a client request. Find checked leads, inspect the sources, and choose the work for an evidence-backed reuse brief.</p>
        </div>
        <details className="local-library">
          <summary>History and Saved</summary>
          <h2 id="local-library-title">History and Saved</h2>
          <p className="field-hint">This browser/device only — no account sync or durable archive. Accepted jobs are recorded locally with a short request label and access capability. Do not retain them on a shared browser. Saving never extends the original seven-day expiry. No results, source bodies, or packs are stored here; downloaded packs remain independent offline files.</p>
          <div className="action-row" role="group" aria-label="Local job lists">
            <button className="secondary-button" type="button" aria-pressed={library === "History"} onClick={() => setLibrary("History")}>History</button>
            <button className="secondary-button" type="button" aria-pressed={library === "Saved"} onClick={() => setLibrary("Saved")}>Saved</button>
            <button className="text-button" type="button" onClick={() => changeLocalJobs((entries) => library === "History" ? [] : entries.map((entry) => ({ ...entry, saved: false })))}>Clear {library === "History" ? "History and Saved" : "Saved"}</button>
          </div>
          {localData.error && <p role="alert" className="notice notice-error">{localData.error}</p>}
          <p className="field-hint">Reopen validates the live job with the server; it does not regenerate an assessment. Remove/clear only changes this browser, never remote jobs.</p>
          <ul className="local-job-list" aria-label={library}>
            {localData.entries.filter((entry) => library === "History" || entry.saved).map((entry) => (
              <li key={entry.jobId}>
                <p>{entry.label} {entry.saved && <Badge>Saved</Badge>}</p>
                <p className="field-hint">Expires <time dateTime={entry.expiresAt}>{new Date(entry.expiresAt).toLocaleString()}</time></p>
                <div className="action-row">
                  <button className="secondary-button" type="button" onClick={() => reopen(entry)} aria-label={`Reopen ${entry.label}`}>Reopen</button>
                  {entry.saved && <button className="text-button" type="button" onClick={() => changeLocalJobs((entries) => entries.map((item) => item.jobId === entry.jobId ? { ...item, saved: false } : item))} aria-label={`Unsave ${entry.label}`}>Unsave</button>}
                  <button className="text-button" type="button" onClick={() => changeLocalJobs((entries) => entries.filter((item) => item.jobId !== entry.jobId))} aria-label={`Remove ${entry.label}`}>Remove</button>
                </div>
              </li>
            ))}
          </ul>
          {!localData.entries.some((entry) => library === "History" || entry.saved) && <p className="empty-state">No local {library.toLowerCase()} entries.</p>}
        </details>
        <nav className="step-nav" aria-label="Workflow steps">
          <ol>{stepNames.map((name, index) => (
            <li key={name} className={step === index + 1 ? "step-current" : step > index + 1 ? "step-complete" : ""} aria-current={step === index + 1 ? "step" : undefined}>
              <span className="step-number">{index + 1}</span><span>{name}</span>
            </li>
          ))}</ol>
        </nav>

        {serviceError && <p role="alert" className="notice notice-error">{serviceError}</p>}
        {step > 1 && (request.trim() || submittedClarification) && <section className="submitted-request" aria-label="Submitted request">
          <h2>Client request</h2><p>{submittedClarification?.context ?? request.trim()}</p>
          {submittedClarification && <><h3>Submitted clarification</h3><p>{submittedClarification.answers}</p></>}
        </section>}
        {step > 1 && job && <p className="field-hint">Application job access expires: <time dateTime={job.expiresAt}>{new Date(job.expiresAt).toLocaleString()}</time> (seven days after creation). Provider/platform and backup retention is separate; downloaded packs remain on your device.</p>}
        {step > 1 && job && <JobTimings job={job} />}
        {session && job && (assessmentAvailable || (job.briefState === "ready" && job.brief)) && (
          <div className="action-row">
            <button className="secondary-button" type="button" aria-pressed={localData.entries.some((entry) => entry.jobId === session.jobId && entry.saved)} onClick={toggleSaved}>
              {localData.entries.some((entry) => entry.jobId === session.jobId && entry.saved) ? "Unsave checked job" : "Save checked job"}
            </button>
            <span className="field-hint">Bookmark this live assessment / brief until its original expiry.</span>
          </div>
        )}

        {step === 1 && (
          <section className="screen" aria-labelledby="request-title">
            <div className="screen-heading"><span className="step-kicker">Step 1 of 4</span><h2 id="request-title">What does the client need?</h2><p>Describe the request and constraints. This is sent to the service to check against fictional past examples.</p></div>
            <form onSubmit={submitRequest} className="request-form">
              <Field.Root name="request">
                <Field.Label htmlFor="client-request">Client request</Field.Label>
                <Field.Control render={<textarea id="client-request" aria-describedby="request-hint request-processing request-retention" rows={8} maxLength={6000} required placeholder="Describe the requested work, relevant constraints, and what a useful outcome would look like." />} value={request} onValueChange={setRequest} />
                <Field.Description id="request-hint" className="field-hint">Do not include sensitive personal information.</Field.Description>
                <p id="request-processing" className="field-hint">Requests, fictional evidence, and generated drafts/reviews are sent through <a href="https://openrouter.ai/privacy">OpenRouter</a> to <a href="https://developers.openai.com/api/docs/guides/your-data">OpenAI</a>. The deployed app uses <a href="https://www.cloudflare.com/privacypolicy/">Cloudflare</a> for processing/storage and <a href="https://neon.com/privacy-policy">Neon</a> for job storage; development uses local platform/database equivalents.</p>
                <p id="request-retention" className="field-hint">Application request/results and job access expire seven days after creation; minimal billing and replay-prevention records remain. Provider/platform copies follow the linked policies, not this seven-day expiry; backup retention is separate. Downloaded packs remain on your device.</p>
              </Field.Root>
              <Button className="primary-button" type="submit" disabled={submittingRequest || !request.trim()}>{submittingRequest ? "Sending request…" : "Check past examples"}</Button>
            </form>
            <section className="request-suggestions" aria-labelledby="suggestions-title">
              <h3 id="suggestions-title">Try a fictional client request</h3>
              <p className="field-hint">Inspired by the fictional corpus, not checked matches. Choosing one fills the editable request above; only submitting starts an admission request.</p>
              <div className="suggestion-grid">{suggestedRequests.map((suggestion) => <Button key={suggestion.title} type="button" className="secondary-button suggestion-button" onClick={() => {
                setRequest(suggestion.request);
                document.getElementById("client-request")?.focus();
              }}><span>{suggestion.title}</span><span className="field-hint">Based on {suggestion.basis}</span></Button>)}</div>
            </section>
          </section>
        )}

        {step === 2 && (
          <section className="screen" aria-labelledby="examples-title">
            <div className="screen-heading"><span className="step-kicker">Step 2 of 4</span><h2 id="examples-title">Checked past examples</h2><p>These are checked fictional records, not proof that the same outcome will happen again.</p></div>
            <div className="assessment-layout">
            <section className="current-assessment" aria-labelledby="current-assessment-title">
            <h3 id="current-assessment-title">Current assessment</h3>
            {(session || submittingRequest) && (assessmentState === "queued" || assessmentState === "running" || assessmentState === "not_started") && (
              <div className="status-panel" role="status" aria-live="polite">
                <span className="status-indicator" aria-hidden="true" />
                <div><strong>{submittingRequest ? "Submitting request for admission" : !job ? "Retrieving job status" : assessmentState === "queued" ? "Waiting in the service queue" : assessmentState === "not_started" ? "Assessment is not started" : label(job.stage)}</strong><p>No draft is shown. Results appear only after reference checks and separate support review pass.</p></div>
              </div>
            )}
            {assessmentState === "failed" && <div className="notice notice-error" role="alert"><strong>Assessment failed.</strong> {job?.error?.message ?? "No checked past-example result is available."}</div>}
            {assessmentState === "reconciliation_required" && <div className="notice notice-warning" role="alert"><strong>Assessment needs operator reconciliation.</strong> {job?.error?.message ?? "The service could not establish the dispatch outcome. No automatic retry was made."}</div>}
            {assessmentState === "ready" && !assessment && <div className="notice notice-error" role="alert">The service did not return a supported checked assessment. No result is shown.</div>}
            {!session && !submittingRequest && <p className="notice notice-warning" role="status">No current checked answer is available. No selections or dependent brief remain.{previousJob ? " Previous content is historical only." : ""}</p>}
            {assessmentAvailable && (
              <>
                <div className={`conclusion-panel conclusion-${visibleConclusion(assessment, assessmentClaims)}`} role="status">
                  <strong>{label(visibleConclusion(assessment, assessmentClaims))}</strong>
                  <p>{assessmentConclusions[visibleConclusion(assessment, assessmentClaims)]}</p>
                </div>
                <WithheldNote count={assessment.withheldClaimCount} />
                {assessment.nextActions.length > 0 && <section className="content-section" aria-label="Checked next actions">
                  <h3>What to verify next — and why it affects reuse</h3>
                  <div className="card-grid">{assessment.nextActions.map((action) => <article key={action.claimId}>
                    <h4>{action.caseId} / {action.artifactId}</h4>
                    <ClaimCard claim={assessmentClaims.get(action.claimId)!} inspect={setPassageRef} />
                  </article>)}</div>
                </section>}
                <section className="content-section" aria-labelledby="lead-title">
                  <div className="section-heading"><div><p className="eyebrow">Checked leads</p><h3 id="lead-title">Examples that may be relevant</h3></div><span className="muted">Up to three leads</span></div>
                  {checkedLeads.length === 0 ? <p className="empty-state">No supported checked leads were returned.</p> : checkedLeads.slice(0, 3).map((lead) => <div key={lead.caseId}>
                    <LeadCard lead={lead} claims={assessmentClaims} inspect={setPassageRef} />
                    <ComparisonTable rows={assessment.comparisons.filter((row) => row.caseId === lead.caseId)} claims={assessmentClaims} inspect={setPassageRef} />
                    <section className="checked-source-cards" aria-label={`Checked source artifacts for ${lead.caseId}`}>
                      <h4>Checked source artifacts</h4>
                      <p className="field-hint">Accepted work evidence, not corpus-only browse matches. Choose artifacts, retained versions, and passages in the next step; nothing is selected automatically.</p>
                      <div className="card-grid">{workChoices.filter((work) => work.caseId === lead.caseId && lead.usefulArtifactIds.includes(work.item.artifactId) && work.sourceRefs.length > 0).map(({ item, sourceRefs, key }) => <article className="checked-source-card" key={key}>
                        <div className="card-heading"><h4>{item.artifactId}</h4><Badge tone="fictional">Fictional source</Badge></div>
                        {item.disposition && <Badge tone={item.disposition}>{label(item.disposition)}</Badge>}
                        <ClaimGroup title="Checked reuse recommendation" ids={item.dispositionClaimId ? [item.dispositionClaimId] : []} claims={assessmentClaims} inspect={setPassageRef} />
                        <ClaimGroup title="Blockers" ids={item.blockerClaimIds} claims={assessmentClaims} inspect={setPassageRef} />
                        <ClaimGroup title="Required verification" ids={item.verificationClaimIds} claims={assessmentClaims} inspect={setPassageRef} />
                        <SourceLinks refs={sourceRefs} inspect={setPassageRef} />
                      </article>)}</div>
                      {!workChoices.some((work) => work.caseId === lead.caseId && lead.usefulArtifactIds.includes(work.item.artifactId) && work.sourceRefs.length > 0) && <p className="empty-state">No eligible checked source artifacts for this lead.</p>}
                    </section>
                  </div>)}
                </section>
                {checkedContrasts.length > 0 && <section className="content-section" aria-labelledby="contrast-title">
                  <div className="section-heading"><div><p className="eyebrow">Contrasts</p><h3 id="contrast-title">Comparisons, not recommendations</h3></div></div>
                  {checkedContrasts.map((lead) => <div key={lead.caseId}>
                    <LeadCard lead={lead} contrast claims={assessmentClaims} inspect={setPassageRef} />
                    <ComparisonTable rows={assessment.comparisons.filter((row) => row.caseId === lead.caseId)} claims={assessmentClaims} inspect={setPassageRef} />
                  </div>)}
                </section>}
                {unrankedComparisons.length > 0 && <section className="content-section" aria-label="Unestablished applicability">
                  <h3>Applicability not established</h3>
                  <p>These checked conflicts or unknowns explain why a proposed example is not a checked lead. They do not recommend its work as a starting point.</p>
                  {unrankedComparisons.map(([caseId, rows]) => <div key={caseId}><h4>{caseId}</h4><ComparisonTable rows={rows} claims={assessmentClaims} inspect={setPassageRef} /></div>)}
                </section>}
                <section className="content-section" aria-labelledby="claim-title">
                  <div className="section-heading"><div><p className="eyebrow">Checked claims</p><h3 id="claim-title">Facts, interpretations, and recommendations</h3></div></div>
                  {assessment.claims.length === 0 ? <p className="empty-state">No checked claims were returned.</p> : <div className="claim-list">{assessment.claims.map((claim) => <ClaimCard key={claim.claimId} claim={claim} inspect={setPassageRef} />)}</div>}
                </section>
                <section className="content-section" aria-labelledby="case-status-title">
                  <div className="section-heading"><div><p className="eyebrow">Evidence coverage</p><h3 id="case-status-title">Availability, outcomes, and uncertainty</h3></div></div>
                  {assessment.cases.length === 0 ? <p className="empty-state">No checked case records were returned.</p> : <div className="card-grid">{assessment.cases.map((item) => <CaseCard key={item.caseId} item={item} claims={assessmentClaims} inspect={setPassageRef} />)}</div>}
                </section>
                <div className="action-row"><button className="primary-button" type="button" onClick={() => setStep(3)}>Choose work from these examples</button></div>
              </>
            )}
            </section>
            {(assessmentAvailable || submittedClarification) && <aside className="clarification-section" aria-labelledby="clarification-title">
              <p className="eyebrow">Decision-critical constraints</p>
              <h3 id="clarification-title">{questions?.clarifyingClaimIds.length ? "Questions that may change which work applies" : "Add or clarify client constraints"}</h3>
              {!assessmentAvailable && questions && <p className="field-hint">Previous checked questions — not a newly checked answer.</p>}
              <ClaimGroup title="Checked questions and why they matter" ids={questions?.clarifyingClaimIds ?? []} claims={questionClaims} inspect={setPassageRef} />
              <form className="request-form clarification-form" onSubmit={submitClarifications}>
                <label htmlFor="clarification-answers">Client answers</label>
                <textarea id="clarification-answers" value={questionAnswers} onChange={(event) => setQuestionAnswers(event.currentTarget.value)} rows={4} maxLength={4000} disabled={rechecking} aria-describedby="clarification-hint" placeholder="Answer relevant questions or supply a new client constraint." />
                <p id="clarification-hint" className="field-hint">Only submitting starts a fresh evidence check. It immediately clears artifact, version, and passage selections and the dependent brief, even if admission fails. One previous checked assessment remains read-only until its original expiry.</p>
                <button className="secondary-button" type="submit" disabled={rechecking || !questionAnswers.trim()}>{rechecking ? "Rechecking…" : "Recheck with these answers"}</button>
              </form>
            </aside>}
            </div>
            {previousJob && <AssessmentLineage previous={previousJob} current={assessmentAvailable ? assessment : undefined} inspect={setPassageRef} />}
          </section>
        )}

        {step === 3 && (
          <section className="screen" aria-labelledby="work-title">
            <div className="screen-heading"><span className="step-kicker">Step 3 of 4</span><h2 id="work-title">Select work for the brief</h2><p>Choose the fictional work artifacts that fit. Select at least one checked passage for each chosen artifact.</p></div>
            {!assessmentAvailable && <div className="notice notice-warning" role="alert">A ready, supported assessment is required before work can be selected.</div>}
            {assessmentAvailable && workChoices.length === 0 && <div className="empty-state">No checked work artifacts are available for selection.</div>}
            {assessmentAvailable && workChoices.length > 0 && <div className="work-list">{workChoices.map(({ caseId, availability, item, sourceRefs, key }) => (
              <WorkCard key={key} caseId={caseId} availability={availability} item={item} reviewRole={assessment.artifactReviews.find((review) => review.caseId === caseId && review.artifactId === item.artifactId)?.role} claims={assessmentClaims} draft={getDraft(key, sourceRefs)} onChange={(next) => updateDraft(key, next)} inspect={setPassageRef} />
            ))}</div>}
            {selectedCount > 0 && !selectionsValid && <p className="notice notice-warning" role="status">Each selected artifact needs at least one checked passage from its chosen retained version.</p>}
            {selectedCount === 0 && assessmentAvailable && workChoices.length > 0 && <p className="field-hint">No work is selected. Choosing work is required to make a brief.</p>}
            <div className="action-row action-row-split">
              <button className="secondary-button" type="button" onClick={() => setStep(2)}>Back to checked examples</button>
              <button className="primary-button" type="button" onClick={() => void submitBrief()} disabled={!selectionsValid || submittingBrief || !session}>{submittingBrief ? "Starting brief…" : "Check selected work"}</button>
            </div>
          </section>
        )}

        {step === 4 && (
          <section className="screen" aria-labelledby="brief-title">
            <div className="screen-heading"><span className="step-kicker">Step 4 of 4</span><h2 id="brief-title">Checked brief</h2><p>Review the supported claims, blockers, and checks before using this fictional brief.</p></div>
            {(briefState === "queued" || briefState === "running" || briefState === "not_started") && (
              <div className="status-panel" role="status" aria-live="polite">
                <span className="status-indicator" aria-hidden="true" />
                <div><strong>{briefState === "queued" ? "Waiting in the brief queue" : briefState === "not_started" ? "Brief has not started" : job?.stage === "ready" ? "Retrieving brief status" : label(job?.stage ?? "running")}</strong><p>No draft is shown until reference checks and separate support review pass. Queue wait is not processing time.</p></div>
              </div>
            )}
            {briefState === "ready" && !job?.brief && pollMode === "brief" && <div className="status-panel" role="status" aria-live="polite"><span className="status-indicator" aria-hidden="true" /><div><strong>Retrieving the checked brief</strong><p>The service reported readiness; the checked result is still being fetched.</p></div></div>}
            {briefState === "failed" && <div className="notice notice-error" role="alert"><strong>Brief check failed.</strong> {job?.error?.message ?? "No checked brief is available."}</div>}
            {briefState === "reconciliation_required" && <div className="notice notice-warning" role="alert"><strong>Brief needs operator reconciliation.</strong> {job?.error?.message ?? "The service could not establish the dispatch outcome. No automatic retry was made."}</div>}
            {briefState === "ready" && !job?.brief && pollMode !== "brief" && <div className="notice notice-error" role="alert">The service did not return a supported checked brief. No result is shown.</div>}
            {briefState === "ready" && job?.brief && (
              <>
                <WithheldNote count={job.brief.withheldClaimCount} />
                {session && job.stage === "ready" && <PackExport key={session.jobId} session={session} expiresAt={job.expiresAt} />}
                {(["reuse", "adapt", "verify"] as const).map((kind) => {
                  const items = (job.brief?.[kind] ?? []).filter((item) => claimsFor(item.claimIds, briefClaims).length > 0);
                  return <section className="content-section" aria-labelledby={`brief-${kind}`} key={kind}>
                    <div className="section-heading"><div><p className="eyebrow">Fictional work artifacts</p><h3 id={`brief-${kind}`}>{label(kind)}</h3></div></div>
                    {kind === "verify" && <p className="notice notice-warning">BLOCKED: unresolved checks. Not approved for unchanged reuse or production.</p>}
                    {kind === "adapt" && <p>Required adaptations must be completed before use; checked recommendations are the checklist, not an invented implementation plan.</p>}
                    {kind === "reuse" && <p>Checked reusable starting points only. This is not production approval.</p>}
                    {items.length === 0 ? <p className="empty-state">No supported {label(kind).toLowerCase()} items are available.</p> : <div className="card-grid">{items.map((item, index) => <BriefCard key={`${item.caseId}-${item.artifactId}-${index}`} item={item} claims={briefClaims} inspect={setPassageRef} />)}</div>}
                  </section>;
                })}
                <section className="content-section" aria-labelledby="brief-claims-title">
                  <div className="section-heading"><div><p className="eyebrow">Checked claims</p><h3 id="brief-claims-title">Facts, interpretations, and recommendations</h3></div></div>
                  {job.brief.claims.length === 0 ? <p className="empty-state">No checked claims were returned.</p> : <div className="claim-list">{job.brief.claims.map((claim) => <ClaimCard key={claim.claimId} claim={claim} inspect={setPassageRef} />)}</div>}
                </section>
                <div className="fictional-reminder"><Badge tone="fictional">Fictional examples only</Badge><p>Verify the checked claims and limits with the client. Observed outcomes do not promise a repeat.</p></div>
              </>
            )}
            <div className="action-row"><button className="secondary-button" type="button" onClick={() => setStep(3)}>Back to selected work</button></div>
          </section>
        )}
      </section>
      <EvidenceDialog sourceRef={passageRef} onClose={() => setPassageRef(null)} />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<AppShell
  ask={(active) => <App active={active} />}
  sources={<SourcesPage />}
  knowledge={(recordId) => <KnowledgePage key={recordId ?? "all"} recordId={recordId} />}
/>);
