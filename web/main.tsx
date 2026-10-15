import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { Dialog } from "@base-ui/react/dialog";
import type {
  ArtifactAssessment,
  AssessmentResult,
  AssessmentConclusion,
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
  OutcomeStatus,
  PassageView,
  PhaseState,
  Selection,
  SourceRef,
  StartBriefRequest,
  StartBriefResponse,
} from "../src/shared/protocol";
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


function isAssessment(value: unknown): value is AssessmentResult {
  if (!isRecord(value)
    || !Array.isArray(value.cases) || !value.cases.every(isCaseAssessment)
    || !Array.isArray(value.leads) || !value.leads.every(isLead)
    || !Array.isArray(value.contrasts) || !value.contrasts.every(isLead)
    || !Array.isArray(value.claims) || !value.claims.every(isClaim)
    || !isAssessmentConclusion(value.conclusion)
    || !isTextList(value.clarifyingClaimIds)
    || !isCount(value.withheldClaimCount)) return false;
  const claims = new Map<string, Claim>(value.claims.map((claim: Claim) => [claim.claimId, claim]));
  if (!value.cases.every((item: CaseAssessment) => item.artifactWork.every((work) =>
    work.disposition === null || (work.dispositionClaimId !== null && claims.get(work.dispositionClaimId)?.kind === "recommendation")))) return false;
  if (value.conclusion === "precedent_found") return value.leads.length > 0;
  return true;
}

function visibleConclusion(result: AssessmentResult, claims: ClaimMap): AssessmentConclusion {
  const hasSupportedLead = result.leads.some((lead) => claimsFor(lead.reasonClaimIds, claims).length > 0);
  if (result.conclusion === "no_useful_precedent"
    && (result.cases.length !== 8
      || result.cases.some((item) => item.availability !== "available" || item.outcome === "unknown")
      || result.leads.length > 0
      || result.withheldClaimCount > 0)) {
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
    && (value.assessment === undefined || isAssessment(value.assessment))
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
      </div>
      <div className="timing-phase">
        <h3>Brief</h3>
        <p className="timing-target">Target: 30 s processing; queue wait is reported separately</p>
        <dl>
          {job.briefQueueWaitMs !== null && <div><dt>Observed queue wait</dt><dd>{formatDuration(job.briefQueueWaitMs)}</dd></div>}
          {job.briefProcessingMs !== null && <div><dt>Observed processing time</dt><dd>{formatDuration(job.briefProcessingMs)}</dd></div>}
        </dl>
      </div>
    </section>
  );
}


function isCreateJobResponse(value: unknown): value is CreateJobResponse {
  return isRecord(value) && isText(value.jobId) && isText(value.capability) && isText(value.expiresAt);
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
  drafting: "Drafting checked results",
  reference_check: "Checking references",
  support_review: "Reviewing support",
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

function SourceLinks({ refs, inspect }: { refs: SourceRef[]; inspect: InspectPassage }) {
  if (refs.length === 0) return <p className="muted">No checked source references are available.</p>;
  const uniqueRefs = Array.from(new Map(refs.map((ref) => [`${ref.versionId}\u0000${ref.passageId}`, ref])).values());
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
    </article>
  );
}

function WorkCard({
  item,
  caseId,
  availability,
  claims,
  draft,
  onChange,
  inspect,
}: {
  item: ArtifactAssessment;
  caseId: string;
  availability: CaseAvailability;
  claims: ClaimMap;
  draft: WorkDraft;
  onChange: (next: WorkDraft) => void;
  inspect: InspectPassage;
}) {
  const otherClaimIds = item.claimIds.filter((id) => id !== item.dispositionClaimId);
  const workClaimIds = [...item.claimIds, ...item.blockerClaimIds, ...item.verificationClaimIds];
  const hasSupportedWorkClaim = claimsFor(item.claimIds, claims).length > 0;
  const refs = claimsFor(workClaimIds, claims).flatMap((claim) => claim.sourceRefs)
    .filter((ref) => ref.caseId === caseId && ref.artifactId === item.artifactId);
  const versions = Array.from(new Set(refs.map((ref) => ref.versionId)));
  const selectedVersion = versions.includes(draft.versionId) ? draft.versionId : (versions[0] ?? "");
  const passageRefs = Array.from(new Map(
    refs.filter((ref) => ref.versionId === selectedVersion).map((ref) => [ref.passageId, ref]),
  ).values());
  const canSelect = item.availability !== "unavailable" && (availability === "available" || availability === "partial") && hasSupportedWorkClaim && versions.length > 0;
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
            <label className="field-label">
              Retained version
              <select value={selectedVersion} onChange={(event) => onChange({ ...draft, versionId: event.currentTarget.value, passageIds: [] })}>
                {versions.map((versionId) => <option key={versionId} value={versionId}>{versionId}</option>)}
              </select>
            </label>
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

interface WorkDraft {
  selected: boolean;
  versionId: string;
  passageIds: string[];
}

interface Session {
  jobId: string;
  capability: string;
}

type PollMode = "assessment" | "brief" | null;

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
          {sourceRef && <EvidencePassage key={JSON.stringify(sourceRef)} sourceRef={sourceRef} />}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const stepNames = ["Client request", "Checked examples", "Selected work", "Checked brief"];

function App() {
  const [step, setStep] = useState(1);
  const [request, setRequest] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const [pollMode, setPollMode] = useState<PollMode>(null);
  const [workDrafts, setWorkDrafts] = useState<Record<string, WorkDraft>>({});
  const [serviceError, setServiceError] = useState<string | null>(null);
  const [passageRef, setPassageRef] = useState<SourceRef | null>(null);
  const [submittingRequest, setSubmittingRequest] = useState(false);
  const [questionAnswers, setQuestionAnswers] = useState("");
  const [submittingBrief, setSubmittingBrief] = useState(false);
  const sessionGeneration = useRef(0);
  const requestSubmissionId = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const briefController = useRef<AbortController | null>(null);
  const pollController = useRef<AbortController | null>(null);

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
        setJob(body);
        setServiceError(null);
        const currentState = pollMode === "assessment" ? body.assessmentState : body.briefState;
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

  const assessment = job?.assessment;
  const assessmentClaims = useMemo(() => new Map((assessment?.claims ?? []).map((claim) => [claim.claimId, claim] as const)), [assessment]);
  const briefClaims = useMemo(() => new Map((job?.brief?.claims ?? []).map((claim) => [claim.claimId, claim] as const)), [job?.brief]);
  const checkedLeads = (assessment?.leads ?? []).filter((lead) => claimsFor(lead.reasonClaimIds, assessmentClaims).length > 0);
  const checkedContrasts = (assessment?.contrasts ?? []).filter((lead) => claimsFor(lead.reasonClaimIds, assessmentClaims).length > 0);
  const workChoices = useMemo(() => (assessment?.cases ?? []).flatMap((caseItem) => caseItem.artifactWork.map((item) => {
    const claimIds = [...item.claimIds, ...item.blockerClaimIds, ...item.verificationClaimIds];
    const sourceRefs = claimsFor(claimIds, assessmentClaims).flatMap((claim) => claim.sourceRefs)
      .filter((ref) => ref.caseId === caseItem.caseId && ref.artifactId === item.artifactId);
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

  async function createAssessment(requestText: string) {
    const trimmed = requestText.trim();
    if (!trimmed || submittingRequest) return;
    if (new TextEncoder().encode(trimmed).byteLength > 16 * 1024) {
      setServiceError("The request and answers must stay within 16 KiB.");
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
        setServiceError(`The service could not accept the request (HTTP ${response.status}).`);
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
      setSession({ jobId: result.jobId, capability: result.capability });
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
    await createAssessment(`${request.trim()}\n\nClarifications supplied by the delivery lead:\n${answers}`);
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
    setPollMode(null);
    setWorkDrafts({});
    setQuestionAnswers("");
    setSubmittingRequest(false);
    setSubmittingBrief(false);
    setServiceError(null);
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
        setServiceError(`The service could not start the brief (HTTP ${response.status}).`);
        return;
      }
      const receipt: unknown = await response.json();
      if (generation !== sessionGeneration.current || controller.signal.aborted) return;
      if (!isStartBriefResponse(receipt) || receipt.jobId !== session.jobId) {
        setServiceError("The service returned an unsupported brief receipt. No unchecked brief is shown.");
        return;
      }
      setJob((current) => current ? { ...current, briefState: receipt.briefState } : current);
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

  const assessmentState = job?.assessmentState ?? "queued";
  const briefState = job?.briefState ?? "not_started";
  const assessmentAvailable = assessmentState === "ready" && !!assessment;

  return (
    <main className="app-shell">
      <header className="app-header">
        <a href="/" className="brand" aria-label="Memory Bank home"><span className="brand-mark" aria-hidden="true">M</span><span>Memory Bank</span></a>
        <span className="fictional-banner">Fictional examples only</span>

        {session && <button className="secondary-button new-request-button" type="button" onClick={startNewRequest}>New request</button>}
      </header>
      <section className="workflow" aria-labelledby="workflow-title">
        <div className="intro">
          <p className="eyebrow">Evidence-grounded work planning</p>
          <h1 id="workflow-title">Build a checked work brief</h1>
          <p>Review fictional past examples, choose the evidence that applies, and inspect every checked passage before using it.</p>
        </div>
        <nav className="step-nav" aria-label="Workflow steps">
          <ol>{stepNames.map((name, index) => (
            <li key={name} className={step === index + 1 ? "step-current" : step > index + 1 ? "step-complete" : ""} aria-current={step === index + 1 ? "step" : undefined}>
              <span className="step-number">{index + 1}</span><span>{name}</span>
            </li>
          ))}</ol>
        </nav>

        {serviceError && <p role="alert" className="notice notice-error">{serviceError}</p>}
        {step > 1 && job && <JobTimings job={job} />}

        {step === 1 && (
          <section className="screen" aria-labelledby="request-title">
            <div className="screen-heading"><span className="step-kicker">Step 1 of 4</span><h2 id="request-title">What does the client need?</h2><p>Describe the request and constraints. This is sent to the service to check against fictional past examples.</p></div>
            <form onSubmit={submitRequest} className="request-form">
              <label htmlFor="client-request">Client request</label>
              <textarea id="client-request" name="request" value={request} onChange={(event) => setRequest(event.currentTarget.value)} rows={8} maxLength={6000} required placeholder="Describe the requested work, relevant constraints, and what a useful outcome would look like." />
              <p className="field-hint">Do not include sensitive personal information.</p>
              <button className="primary-button" type="submit" disabled={submittingRequest || !request.trim()}>{submittingRequest ? "Sending request…" : "Check past examples"}</button>
            </form>
          </section>
        )}

        {step === 2 && (
          <section className="screen" aria-labelledby="examples-title">
            <div className="screen-heading"><span className="step-kicker">Step 2 of 4</span><h2 id="examples-title">Checked past examples</h2><p>These are checked fictional records, not proof that the same outcome will happen again.</p></div>
            {job && <div className="submitted-request"><h3>Your request</h3><p>{request.trim()}</p></div>}
            {(assessmentState === "queued" || assessmentState === "running" || assessmentState === "not_started") && (
              <div className="status-panel" role="status" aria-live="polite">
                <span className="status-indicator" aria-hidden="true" />
                <div><strong>{assessmentState === "queued" ? "Waiting in the service queue" : assessmentState === "not_started" ? "Assessment is not started" : label(job?.stage ?? "assembling")}</strong><p>No result is shown until the evidence check is ready.</p></div>
              </div>
            )}
            {assessmentState === "failed" && <div className="notice notice-error" role="alert"><strong>Evidence check failed.</strong> No past-example result is available.</div>}
            {assessmentState === "reconciliation_required" && <div className="notice notice-warning" role="alert"><strong>Evidence reconciliation is required.</strong> Results are withheld until the checked evidence can be reconciled.</div>}
            {assessmentState === "ready" && !assessment && <div className="notice notice-error" role="alert">The service did not return a supported checked assessment. No result is shown.</div>}
            {assessmentAvailable && (
              <>
                <div className={`conclusion-panel conclusion-${visibleConclusion(assessment, assessmentClaims)}`} role="status">
                  <strong>{label(visibleConclusion(assessment, assessmentClaims))}</strong>
                  <p>{assessmentConclusions[visibleConclusion(assessment, assessmentClaims)]}</p>
                </div>
                <WithheldNote count={assessment.withheldClaimCount} />
                {assessment.clarifyingClaimIds.length > 0 && (
                  <section className="content-section clarification-section" aria-labelledby="clarification-title">
                    <div className="section-heading">
                      <div><p className="eyebrow">Decisive missing details</p><h3 id="clarification-title">Questions that may change which work applies</h3></div>
                    </div>
                    <ClaimGroup title="Checked questions and why they matter" ids={assessment.clarifyingClaimIds} claims={assessmentClaims} inspect={setPassageRef} />
                    <form className="request-form clarification-form" onSubmit={submitClarifications}>
                      <label htmlFor="clarification-answers">Client answers</label>
                      <textarea id="clarification-answers" value={questionAnswers} onChange={(event) => setQuestionAnswers(event.currentTarget.value)} rows={4} maxLength={4000} placeholder="Answer the questions that apply. Submitting starts a fresh assessment and clears these results and selections." />
                      <button className="secondary-button" type="submit" disabled={submittingRequest || !questionAnswers.trim()}>{submittingRequest ? "Rechecking…" : "Recheck with these answers"}</button>
                    </form>
                  </section>
                )}
                <section className="content-section" aria-labelledby="lead-title">
                  <div className="section-heading"><div><p className="eyebrow">Checked leads</p><h3 id="lead-title">Examples that may be relevant</h3></div><span className="muted">Up to three leads</span></div>
                  {checkedLeads.length === 0 ? <p className="empty-state">No supported checked leads were returned.</p> : <div className="card-grid">{checkedLeads.slice(0, 3).map((lead, index) => <LeadCard key={`${lead.caseId}-${index}`} lead={lead} claims={assessmentClaims} inspect={setPassageRef} />)}</div>}
                </section>
                {checkedContrasts.length > 0 && <section className="content-section" aria-labelledby="contrast-title">
                  <div className="section-heading"><div><p className="eyebrow">Contrasts</p><h3 id="contrast-title">Comparisons, not recommendations</h3></div></div>
                  <div className="card-grid">{checkedContrasts.slice(0, 3).map((lead, index) => <LeadCard key={`${lead.caseId}-${index}`} lead={lead} contrast claims={assessmentClaims} inspect={setPassageRef} />)}</div>
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
        )}

        {step === 3 && (
          <section className="screen" aria-labelledby="work-title">
            <div className="screen-heading"><span className="step-kicker">Step 3 of 4</span><h2 id="work-title">Select work for the brief</h2><p>Choose the fictional work artifacts that fit. Select at least one checked passage for each chosen artifact.</p></div>
            {!assessmentAvailable && <div className="notice notice-warning" role="alert">A ready, supported assessment is required before work can be selected.</div>}
            {assessmentAvailable && workChoices.length === 0 && <div className="empty-state">No checked work artifacts are available for selection.</div>}
            {assessmentAvailable && workChoices.length > 0 && <div className="work-list">{workChoices.map(({ caseId, availability, item, sourceRefs, key }) => (
              <WorkCard key={key} caseId={caseId} availability={availability} item={item} claims={assessmentClaims} draft={getDraft(key, sourceRefs)} onChange={(next) => updateDraft(key, next)} inspect={setPassageRef} />
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
                <div><strong>{briefState === "queued" ? "Brief queued" : briefState === "not_started" ? "Brief has not started" : label(job?.stage ?? "drafting")}</strong><p>The service status is checked directly; no progress estimate is invented.</p></div>
              </div>
            )}
            {briefState === "ready" && !job?.brief && pollMode === "brief" && <div className="status-panel" role="status" aria-live="polite"><span className="status-indicator" aria-hidden="true" /><div><strong>Retrieving the checked brief</strong><p>The service reported readiness; the checked result is still being fetched.</p></div></div>}
            {briefState === "failed" && <div className="notice notice-error" role="alert"><strong>Brief check failed.</strong> No checked brief is available.</div>}
            {briefState === "reconciliation_required" && <div className="notice notice-warning" role="alert"><strong>Brief reconciliation is required.</strong> No unsupported brief content is shown.</div>}
            {briefState === "ready" && !job?.brief && pollMode !== "brief" && <div className="notice notice-error" role="alert">The service did not return a supported checked brief. No result is shown.</div>}
            {briefState === "ready" && job?.brief && (
              <>
                <WithheldNote count={job.brief.withheldClaimCount} />
                {(["reuse", "adapt", "verify"] as const).map((kind) => {
                  const items = (job.brief?.[kind] ?? []).filter((item) => claimsFor(item.claimIds, briefClaims).length > 0);
                  return <section className="content-section" aria-labelledby={`brief-${kind}`} key={kind}>
                    <div className="section-heading"><div><p className="eyebrow">Fictional work artifacts</p><h3 id={`brief-${kind}`}>{label(kind)}</h3></div></div>
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
      <footer className="app-footer"><span>Memory Bank</span><span>Fictional evidence · checked before use</span></footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
