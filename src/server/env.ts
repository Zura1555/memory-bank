import type { StartBriefRequest } from "../shared/protocol.ts";

export interface QueueMessage {
  jobId: string;
  phase: "assessment" | "brief";
  attemptId: string;
  workflowId: string;
}

export type WorkflowParams = QueueMessage;

export interface Env {
  APP_ENV?: string;
  LOCAL_DATABASE_URL?: string;
  OPENROUTER_API_KEY?: string;
  MODEL_PROVIDER?: string;
  MODEL_BASE_URL?: string;
  MODEL_NAME?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPERATOR_TOKEN?: string;
  HYPERDRIVE?: { connectionString: string };
  ORIGINALS: R2Bucket;
  JOB_QUEUE: Queue<QueueMessage>;
  WORKFLOW: Workflow<WorkflowParams>;
  ASSETS: Fetcher;
}

export type BriefSubmission = StartBriefRequest;
