import { app } from "./http.ts";
import type { Env } from "./env.ts";
import { consumeQueue, publishPendingOutbox } from "./outbox.ts";
import { expireJobContent } from "./retention.ts";
import { MemoryBankWorkflow } from "./workflow.ts";
import { expireUploads } from "./uploads.ts";

export { MemoryBankWorkflow };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    const response = await app.fetch(request, env, ctx);
    if (request.method === "POST" && (path === "/api/jobs" || /^\/api\/jobs\/[^/]+\/brief$/u.test(path))) {
      ctx.waitUntil(publishPendingOutbox(env).catch(() => console.error("Memory Bank outbox delivery will retry.")));
    }
    return response;
  },
  queue: consumeQueue,
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(Promise.all([
      publishPendingOutbox(env).catch(() => console.error("Memory Bank outbox delivery will retry.")),
      expireJobContent(env).catch(() => console.error("Memory Bank retention cleanup will retry.")),
      expireUploads(env).catch(() => console.error("Memory Bank private upload cleanup will retry.")),
    ]).then(() => undefined));
  },
};
