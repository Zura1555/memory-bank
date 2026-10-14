import { Hono } from "hono";
import type { Env } from "./env.ts";
import { createAssessmentJob, startBrief } from "./admission.ts";
import { capabilityHash } from "./auth.ts";
import { exactOriginal, exactPassage, EvidenceUnavailable } from "./corpus.ts";
import { HttpFailure } from "./errors.ts";
import { getOwnedJob } from "./jobs.ts";
import { requestSchema, startBriefSchema } from "./schemas.ts";
import {
  operatorBudgetSchema,
  operatorReconciliationSchema,
  operatorStatus,
  reconcileReservation,
  requireOperator,
  updateOperatorBudget,
} from "./operator.ts";

const MAX_JSON_BODY_BYTES = 128 * 1024;
const routeIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/u;

function jsonError(status: number, code: string, message: string, retryable = false): Response {
  return new Response(JSON.stringify({ error: { code, message, retryable } }), {
    status,
    headers: { "Content-Type": "application/json; charset=UTF-8" },
  });
}

async function readJsonBody(request: Request): Promise<unknown> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") throw new HttpFailure(415, "JSON_REQUIRED");
  const contentEncoding = request.headers.get("content-encoding");
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity") throw new HttpFailure(415, "UNSUPPORTED_CONTENT_ENCODING");

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength)) throw new HttpFailure(400, "INVALID_CONTENT_LENGTH");
    if (Number(contentLength) > MAX_JSON_BODY_BYTES) throw new HttpFailure(413, "REQUEST_TOO_LARGE");
  }
  if (!request.body) throw new HttpFailure(400, "INVALID_JSON");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new HttpFailure(413, "REQUEST_TOO_LARGE");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof HttpFailure) throw error;
    throw new HttpFailure(400, "INVALID_JSON");
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new HttpFailure(400, "INVALID_JSON");
  }
}

function checkedRouteId(value: string, code: string): string {
  if (!routeIdPattern.test(value)) throw new HttpFailure(404, code);
  return value;
}

export const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (c.req.path === "/api" || c.req.path.startsWith("/api/")) c.header("Cache-Control", "no-store");
});

app.onError((error) => {
  if (error instanceof HttpFailure) {
    return jsonError(error.status, error.code, "The request could not be completed.", error.retryable);
  }
  if (error instanceof EvidenceUnavailable) {
    return jsonError(503, "EVIDENCE_UNAVAILABLE", "Checked evidence is unavailable.");
  }
  return jsonError(500, "INTERNAL_ERROR", "The request could not be completed.");
});

app.get("/api/health", (c) => c.json({ status: "ok" as const }));

app.post("/api/jobs", async (c) => {
  const body = requestSchema.safeParse(await readJsonBody(c.req.raw));
  if (!body.success) throw new HttpFailure(400, "INVALID_REQUEST");
  return c.json(await createAssessmentJob(c.env, body.data.request), 202);
});

app.get("/api/jobs/:jobId", async (c) => {
  const jobId = checkedRouteId(c.req.param("jobId"), "JOB_NOT_FOUND");
  return c.json(await getOwnedJob(c.env, jobId, c.req.header("Authorization") ?? null));
});

app.post("/api/jobs/:jobId/brief", async (c) => {
  const jobId = checkedRouteId(c.req.param("jobId"), "JOB_NOT_FOUND");
  const body = startBriefSchema.safeParse(await readJsonBody(c.req.raw));
  if (!body.success) throw new HttpFailure(400, "INVALID_REQUEST");
  const capability = await capabilityHash(c.req.header("Authorization") ?? null);
  return c.json(await startBrief(c.env, jobId, capability, body.data.selections), 202);
});

app.get("/api/evidence/passages/:passageId", async (c) => {
  const passageId = checkedRouteId(c.req.param("passageId"), "EVIDENCE_NOT_FOUND");
  return c.json(await exactPassage(c.env, passageId));
});

app.get("/api/evidence/originals/:versionId", async (c) => {
  const versionId = checkedRouteId(c.req.param("versionId"), "EVIDENCE_NOT_FOUND");
  const original = await exactOriginal(c.env, versionId);
  return new Response(original.bytes, {
    headers: {
      "Content-Type": original.mimeType,
      "Content-Disposition": `attachment; filename="${original.versionId}"`,
      "Content-Length": String(original.bytes.byteLength),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
app.get("/api/operator/status", async (c) => {
  requireOperator(c.env, c.req.header("Authorization") ?? null);
  return c.json(await operatorStatus(c.env));
});

app.put("/api/operator/budget", async (c) => {
  requireOperator(c.env, c.req.header("Authorization") ?? null);
  const body = operatorBudgetSchema.safeParse(await readJsonBody(c.req.raw));
  if (!body.success) throw new HttpFailure(400, "INVALID_REQUEST");
  await updateOperatorBudget(c.env, body.data);
  return c.json({ updated: true });
});

app.post("/api/operator/reconciliations", async (c) => {
  requireOperator(c.env, c.req.header("Authorization") ?? null);
  const body = operatorReconciliationSchema.safeParse(await readJsonBody(c.req.raw));
  if (!body.success) throw new HttpFailure(400, "INVALID_REQUEST");
  return c.json(await reconcileReservation(c.env, body.data));
});

app.notFound((c) => {
  if (c.req.path === "/api" || c.req.path.startsWith("/api/")) {
    return jsonError(404, "NOT_FOUND", "The requested endpoint was not found.");
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
