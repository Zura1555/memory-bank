import type { Env } from "./env.ts";
import { database, transaction } from "./db.ts";

export async function expireJobContent(env: Env): Promise<void> {
  await transaction(database(env), async (client) => {
    await client.query(
      `WITH batch AS (
         SELECT id FROM jobs
         WHERE expires_at <= clock_timestamp()
           AND (capability_hash IS NOT NULL OR request_text <> '' OR assessment_result IS NOT NULL
             OR brief_result IS NOT NULL OR brief_selections IS NOT NULL)
         ORDER BY expires_at
         LIMIT 100
         FOR UPDATE SKIP LOCKED
       )
       UPDATE jobs j SET capability_hash = NULL, request_text = '', assessment_result = NULL,
         brief_result = NULL, brief_selections = NULL
       FROM batch WHERE j.id = batch.id`,
    );
    await client.query(
      `WITH batch AS (
         SELECT a.id FROM model_attempts a
         JOIN jobs j ON j.id = a.job_id
         WHERE j.expires_at <= clock_timestamp()
           AND (a.result_json IS NOT NULL OR a.raw_output IS NOT NULL OR a.validation_issues IS NOT NULL)
         ORDER BY j.expires_at, a.created_at
         LIMIT 500
         FOR UPDATE OF a SKIP LOCKED
       )
       UPDATE model_attempts a SET result_json = NULL, raw_output = NULL, validation_issues = NULL
       FROM batch WHERE a.id = batch.id`,
    );
    await client.query(
      `WITH batch AS (
         SELECT r.job_id FROM job_repairs r
         JOIN jobs j ON j.id = r.job_id
         WHERE j.expires_at <= clock_timestamp() AND r.plan_json IS NOT NULL
         ORDER BY j.expires_at, r.created_at
         LIMIT 100
         FOR UPDATE OF r SKIP LOCKED
       )
       UPDATE job_repairs r SET plan_json = NULL
       FROM batch WHERE r.job_id = batch.job_id`,
    );
  });
}
