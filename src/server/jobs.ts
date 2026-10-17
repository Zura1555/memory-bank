import type { Pool } from "pg";
import type { AssessmentResult, BriefResult, JobView, PhaseState, JobStage, Selection } from "../shared/protocol.ts";
import type { Env } from "./env.ts";
import { database } from "./db.ts";
import { capabilityHash } from "./auth.ts";
import { HttpFailure } from "./errors.ts";
import { EvidenceUnavailable, loadCorpus } from "./corpus.ts";
import { revalidateAssessment, revalidateBrief, withAssessmentConstraintFloor } from "./gates.ts";

export interface JobRecord {
  id: string;
  request_text: string;
  corpus_version: string;
  corpus_sha256: string;
  stage: JobStage;
  assessment_state: PhaseState;
  brief_state: PhaseState;
  assessment_result: AssessmentResult | null;
  brief_result: BriefResult | null;
  brief_selections: Selection[] | null;
  error_code: string | null;
  created_at: Date;
  expires_at: Date;
  assessment_queued_at: Date;
  assessment_processing_started_at: Date | null;
  assessment_finished_at: Date | null;
  brief_queued_at: Date | null;
  brief_processing_started_at: Date | null;
  brief_finished_at: Date | null;
}

export async function ownedJob(pool: Pool, jobId: string, hash: Buffer): Promise<JobRecord> {
  const result = await pool.query<JobRecord>(
    `SELECT id, request_text, corpus_version, corpus_sha256, stage, assessment_state, brief_state, assessment_result, brief_result,
       brief_selections, error_code, created_at, expires_at, assessment_queued_at,
       assessment_processing_started_at, assessment_finished_at, brief_queued_at,
       brief_processing_started_at, brief_finished_at
     FROM jobs WHERE id = $1 AND capability_hash = $2`,
    [jobId, hash],
  );
  const job = result.rows[0];
  if (!job) throw new HttpFailure(404, "JOB_NOT_FOUND");
  if (job.expires_at.getTime() <= Date.now()) throw new HttpFailure(410, "JOB_EXPIRED");
  return job;
}

function phaseTimes(queuedAt: Date | null, startedAt: Date | null, finishedAt: Date | null, now: number): { queueWaitMs: number | null; processingMs: number | null } {
  if (!queuedAt) return { queueWaitMs: null, processingMs: null };
  const queued = queuedAt.getTime();
  const started = startedAt?.getTime() ?? null;
  if (started === null && finishedAt) return { queueWaitMs: null, processingMs: null };
  const end = finishedAt?.getTime() ?? now;
  if ((started !== null && started < queued) || end < (started ?? queued)) return { queueWaitMs: null, processingMs: null };
  const queueWaitMs = (started ?? (finishedAt ? queued : now)) - queued;
  const processingMs = started === null ? null : end - started;
  return { queueWaitMs, processingMs };
}

export function jobView(job: JobRecord, now = Date.now()): JobView {
  const assessment = phaseTimes(job.assessment_queued_at, job.assessment_processing_started_at, job.assessment_finished_at, now);
  const brief = phaseTimes(job.brief_queued_at, job.brief_processing_started_at, job.brief_finished_at, now);
  const errorMessage = job.error_code ? ({
    EVIDENCE_UNAVAILABLE: "Required source evidence is unavailable or incomplete.",
    MODEL_PROVIDER_REJECTED: "The model provider rejected this attempt. No automatic retry was made.",
    MODEL_OUTPUT_SCHEMA_INVALID: "The generated response failed its required checks. No unchecked output is shown.",
    MODEL_OUTPUT_INVALID_JSON: "The generated response could not be validated. No unchecked output is shown.",
    MODEL_OUTPUT_INCOMPLETE_OR_REFUSED: "The model did not complete the required review. No unchecked output is shown.",
    MODEL_OUTPUT_CHOICE_MISSING: "The model returned no completion. No unchecked output is shown.",
    MODEL_OUTPUT_TOKEN_LIMIT: "The model reached its output token limit. No incomplete output is shown.",
    MODEL_OUTPUT_REFUSED: "The model refused this response. No unchecked output is shown.",
    MODEL_OUTPUT_CONTENT_FILTERED: "The provider filtered this response. No unchecked output is shown.",
    MODEL_OUTPUT_NOT_STOPPED: "The model did not finish normally. No unchecked output is shown.",
    MODEL_OUTPUT_CONTENT_MISSING: "The model returned no text response. No unchecked output is shown.",
    STRUCTURAL_CHECK_FAILED: "The generated response failed reference or evidence checks. No unchecked output is shown.",
    MODEL_DISPATCH_UNCERTAIN: "The model dispatch outcome is uncertain. Operator reconciliation is required; no automatic retry was made.",
    INTERNAL_FAILURE: "The requested stage failed. No unchecked output is shown.",
  } as Record<string, string>)[job.error_code] ?? "The requested stage failed. No unchecked output is shown." : undefined;
  return {
    jobId: job.id,
    request: job.request_text,
    createdAt: job.created_at.toISOString(),
    expiresAt: job.expires_at.toISOString(),
    stage: job.stage,
    assessmentState: job.assessment_state,
    briefState: job.brief_state,
    assessmentQueueWaitMs: assessment.queueWaitMs,
    assessmentProcessingMs: assessment.processingMs,
    briefQueueWaitMs: brief.queueWaitMs,
    briefProcessingMs: brief.processingMs,
    ...(job.assessment_state === "ready" && job.assessment_result ? { assessment: job.assessment_result } : {}),
    ...(job.brief_state === "ready" && job.brief_result ? { brief: job.brief_result } : {}),
    ...(errorMessage ? { error: { code: job.error_code ?? "INTERNAL_FAILURE", message: errorMessage, retryable: false } } : {}),
  };
}

export async function getOwnedJob(env: Env, jobId: string, authorization: string | null): Promise<JobView> {
  const hash = await capabilityHash(authorization);
  const job = await ownedJob(database(env), jobId, hash);
  if ((job.assessment_state === "ready" && job.assessment_result) || (job.brief_state === "ready" && job.brief_result)) {
    const corpus = await loadCorpus(env);
    if (corpus.manifest.corpusVersion !== job.corpus_version || corpus.manifestSha256 !== job.corpus_sha256) {
      throw new EvidenceUnavailable("The job's pinned corpus revision is unavailable.");
    }
    if (job.assessment_result) job.assessment_result = revalidateAssessment(job.assessment_result, job.request_text, corpus);
    if (job.brief_result) {
      const floored = job.assessment_result && job.brief_result.constraintReviews
        ? { ...job.brief_result, constraintReviews: withAssessmentConstraintFloor(job.brief_result.constraintReviews, job.assessment_result, job.request_text) }
        : job.brief_result;
      job.brief_result = revalidateBrief(floored, job.request_text, corpus, job.assessment_result ?? undefined);
    }
  }
  return jobView(job);
}
