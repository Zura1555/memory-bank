import assert from "node:assert/strict";
import test from "node:test";
import { jobView, type JobRecord } from "./jobs.ts";

test("reversed phase clocks cannot report a fabricated zero-duration result", () => {
  const at = (milliseconds: number) => new Date(Date.UTC(2026, 0, 1) + milliseconds);
  const job: JobRecord = {
    id: "clock-check", request_text: "Current request", corpus_version: "test", corpus_sha256: "a".repeat(64),
    stage: "failed", assessment_state: "failed", brief_state: "failed", error_code: "INTERNAL_FAILURE",
    assessment_result: null, brief_result: null, brief_selections: null,
    created_at: at(0), expires_at: at(86_400_000),
    assessment_queued_at: at(0), assessment_processing_started_at: at(1_000), assessment_finished_at: at(4_000),
    brief_queued_at: at(5_000), brief_processing_started_at: at(8_000), brief_finished_at: at(7_000),
  };
  const reversedFinish = jobView(job, at(10_000).getTime());
  assert.equal(reversedFinish.assessmentQueueWaitMs, 1_000);
  assert.equal(reversedFinish.assessmentProcessingMs, 3_000);
  assert.equal(reversedFinish.briefQueueWaitMs, null);
  assert.equal(reversedFinish.briefProcessingMs, null);

  job.brief_processing_started_at = at(4_000);
  assert.equal(jobView(job).briefQueueWaitMs, null);
  job.brief_processing_started_at = null;
  const missingStart = jobView(job, at(10_000).getTime());
  assert.equal(missingStart.briefQueueWaitMs, null);
  assert.equal(missingStart.briefProcessingMs, null);
  job.brief_processing_started_at = job.brief_finished_at = job.brief_queued_at;
  const simultaneous = jobView(job);
  assert.equal(simultaneous.briefQueueWaitMs, 0);
  assert.equal(simultaneous.briefProcessingMs, 0);
});
