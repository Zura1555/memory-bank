export type JobKind = "assessment" | "brief";
export type PhaseState = "not_started" | "queued" | "running" | "ready" | "failed" | "reconciliation_required";
export type JobStage = "queued" | "assembling" | "drafting" | "reference_check" | "support_review" | "ready" | "failed" | "reconciliation_required";
export type CaseAvailability = "available" | "partial" | "unavailable" | "failed";
export type OutcomeStatus = "observed_success" | "partial" | "failed" | "unknown";
export type ClaimKind = "source_fact" | "interpretation" | "recommendation";
export type SupportVerdict = "supported" | "unsupported" | "uncertain";
export type BriefDisposition = "reuse" | "adapt" | "verify";
export type AssessmentConclusion = "precedent_found" | "no_useful_precedent" | "cannot_be_established";

export interface SourceRef {
  caseId: string;
  artifactId: string;
  versionId: string;
  passageId: string;
}

export interface Claim {
  claimId: string;
  text: string;
  kind: ClaimKind;
  sourceRefs: SourceRef[];
  requestQuotes: string[];
  dependsOnClaimIds: string[];
}

export interface ClaimReview {
  claimId: string;
  verdict: SupportVerdict;
}

export interface ArtifactAssessment {
  artifactId: string;
  availability: "available" | "partial" | "unavailable";
  exclusionReasons: string[];
  disposition: BriefDisposition | null;
  dispositionClaimId: string | null;
  claimIds: string[];
  blockerClaimIds: string[];
  verificationClaimIds: string[];
}

export interface CaseAssessment {
  caseId: string;
  availability: CaseAvailability;
  outcome: OutcomeStatus;
  outcomeClaimIds: string[];
  claimIds: string[];
  artifactWork: ArtifactAssessment[];
}

export interface Lead {
  caseId: string;
  state: "useful" | "conditional" | "partial";
  usefulArtifactIds: string[];
  reasonClaimIds: string[];
}

export interface AssessmentResult {
  conclusion: AssessmentConclusion;
  clarifyingClaimIds: string[];
  cases: CaseAssessment[];
  leads: Lead[];
  contrasts: Lead[];
  claims: Claim[];
  withheldClaimCount: number;
}

export interface BriefItem {
  artifactId: string;
  caseId: string;
  versionId: string;
  disposition: BriefDisposition;
  dispositionClaimId: string;
  claimIds: string[];
}
export interface BriefResult {
  reuse: BriefItem[];
  adapt: BriefItem[];
  verify: BriefItem[];
  claims: Claim[];
  withheldClaimCount: number;
}

export interface CreateJobRequest {
  request: string;
}

export interface CreateJobResponse {
  jobId: string;
  capability: string;
  expiresAt: string;
}

export interface Selection {
  caseId: string;
  artifactId: string;
  versionId: string;
  passageIds: string[];
}

export interface StartBriefRequest {
  selections: Selection[];
}
export interface StartBriefResponse {
  jobId: string;
  briefState: PhaseState;
}

export interface JobView {
  jobId: string;
  request: string;
  createdAt: string;
  expiresAt: string;
  stage: JobStage;
  assessmentState: PhaseState;
  briefState: PhaseState;
  assessmentQueueWaitMs: number | null;
  assessmentProcessingMs: number | null;
  briefQueueWaitMs: number | null;
  briefProcessingMs: number | null;
  assessment?: AssessmentResult;
  brief?: BriefResult;
  error?: { code: string; message: string; retryable: boolean };
}

export interface PassageView extends SourceRef {
  title: string;
  fictional: true;
  statedDate: string | null;
  excerpt: string;
  sourceKind: "native" | "ocr_transcription" | "visual_observation" | "visual_interpretation";
  location: Record<string, string | number | boolean | null | string[]>;
}

// HTTP contract used by the browser and Worker.
// POST /api/jobs {request} -> 202 CreateJobResponse
// GET /api/jobs/:jobId (Authorization: Bearer <capability>) -> 200 JobView
// POST /api/jobs/:jobId/brief (capability + StartBriefRequest) -> 202 StartBriefResponse
// GET /api/evidence/passages/:passageId -> 200 PassageView
// GET /api/evidence/originals/:versionId -> exact retained original bytes
// GET /api/health -> 200 {status:"ok"}
