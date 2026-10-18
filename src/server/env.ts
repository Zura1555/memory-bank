import type { StartBriefRequest } from "../shared/protocol.ts";

export interface QueueMessage {
  jobId: string;
  phase: "assessment" | "brief";
  attemptId: string;
  workflowId: string;
}

export type WorkflowParams = QueueMessage;
export interface UploadWorkflowParams { uploadId: string; owner: string }

export interface Env {
  APP_ENV?: string;
  LOCAL_DATABASE_URL?: string;
  OPENROUTER_API_KEY?: string;
  MODEL_PROVIDER?: string;
  MODEL_API?: string;
  OPENCODE_API_KEY?: string;
  MODEL_BASE_URL?: string;
  MODEL_NAME?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPERATOR_TOKEN?: string;
  HYPERDRIVE?: { connectionString: string };
  AI?: Ai;
  VECTORIZE?: Vectorize;
  SEARCH_RATE_LIMITER?: RateLimit;
  ORIGINALS: R2Bucket;
  JOB_QUEUE: Queue<QueueMessage>;
  WORKFLOW: Workflow<WorkflowParams | UploadWorkflowParams>;
  ASSETS: Fetcher;
}

export type BriefSubmission = StartBriefRequest;
