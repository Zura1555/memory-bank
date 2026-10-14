import type { Env, QueueMessage } from "./env.ts";
import { database } from "./db.ts";

interface PendingOutbox {
  id: string;
  job_id: string;
  phase: QueueMessage["phase"];
  workflow_id: string;
  attempt_id: string;
}

export async function publishPendingOutbox(env: Env): Promise<void> {
  const pool = database(env);
  const pending = await pool.query<PendingOutbox>(
    `SELECT o.id, o.job_id, o.phase, o.workflow_id, r.id AS attempt_id
     FROM job_outbox o JOIN phase_reservations r
       ON r.job_id = o.job_id AND r.phase = o.phase AND r.attempt_no = o.attempt_no
     WHERE o.published_at IS NULL
     ORDER BY o.created_at
     LIMIT 25`,
  );
  for (const row of pending.rows) {
    const message: QueueMessage = {
      jobId: row.job_id,
      phase: row.phase,
      attemptId: row.attempt_id,
      workflowId: row.workflow_id,
    };
    await env.JOB_QUEUE.send(message);
    await pool.query("UPDATE job_outbox SET published_at = now() WHERE id = $1 AND published_at IS NULL", [row.id]);
  }
}

export async function consumeQueue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      try {
        await env.WORKFLOW.create({
          id: message.body.workflowId,
          params: message.body,
          retention: { successRetention: "7 days", errorRetention: "7 days" },
        });
      } catch {
        await env.WORKFLOW.get(message.body.workflowId);
      }
      message.ack();
    } catch {
      message.retry();
    }
  }
}
