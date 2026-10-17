import type { CreateJobResponse, JobView } from "../shared/protocol.ts";

export const localJobsKey = "memory-bank.jobs.v1";
export interface LocalJob extends CreateJobResponse {
  label: string;
  saved: boolean;
}
type JobStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function localJob(value: unknown): LocalJob | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.jobId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(item.jobId)
    || typeof item.capability !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(item.capability)
    || typeof item.label !== "string" || !item.label.trim() || item.label.length > 100
    || typeof item.saved !== "boolean" || typeof item.expiresAt !== "string"
    || !Number.isFinite(Date.parse(item.expiresAt))) return null;
  // Project only bookmark metadata: never retain results, sources, or full requests.
  return { jobId: item.jobId, capability: item.capability, label: item.label, saved: item.saved, expiresAt: item.expiresAt };
}

export function writeLocalJobs(storage: JobStorage, entries: LocalJob[], now = Date.now()): LocalJob[] {
  const unique = new Map<string, LocalJob>();
  for (const entry of entries) {
    const item = localJob(entry);
    if (!item) throw new Error("Invalid local bookmark");
    if (Date.parse(item.expiresAt) > now && !unique.has(item.jobId)) unique.set(item.jobId, item);
  }
  const live = [...unique.values()];
  const serialized = live.length ? JSON.stringify(live) : null;
  if (storage.getItem(localJobsKey) !== serialized) {
    if (serialized !== null) storage.setItem(localJobsKey, serialized);
    else storage.removeItem(localJobsKey);
  }
  return live;
}

export function readLocalJobs(storage: JobStorage, now = Date.now()): { entries: LocalJob[]; error: string | null } {
  const raw = storage.getItem(localJobsKey);
  if (raw === null) return { entries: [], error: null };
  let value: unknown;
  try { value = JSON.parse(raw); } catch { value = null; }
  if (!Array.isArray(value) || value.some((entry) => !localJob(entry))) {
    storage.removeItem(localJobsKey);
    return { entries: [], error: "Malformed local History/Saved data was removed. It could not be restored." };
  }
  const entries = value.map((entry) => localJob(entry)!);
  try { return { entries: writeLocalJobs(storage, entries, now), error: null }; }
  catch {
    // If pruning cannot be rewritten (e.g. quota), discard the key rather than retain expired access.
    storage.removeItem(localJobsKey);
    throw new Error("Local retention cleanup failed");
  }
}

export function reopenedJobMode(entry: CreateJobResponse, job: Pick<JobView, "jobId" | "expiresAt" | "assessmentState" | "briefState">, now = Date.now()): "assessment" | "brief" {
  if (job.jobId !== entry.jobId || Date.parse(job.expiresAt) !== Date.parse(entry.expiresAt)
    || !Number.isFinite(Date.parse(entry.expiresAt)) || Date.parse(entry.expiresAt) <= now) {
    throw new Error("The original live job could not be validated");
  }
  return job.assessmentState === "ready" && job.briefState !== "not_started" ? "brief" : "assessment";
}
