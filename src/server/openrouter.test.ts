import assert from "node:assert/strict";
import test from "node:test";
import type { Env } from "./env.ts";
import { callOpenRouter, ModelCallError } from "./openrouter.ts";

test("an interrupted provider body keeps its generation ID and cannot be treated as a free failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(" "));
      controller.error(new DOMException("Provider response timed out", "TimeoutError"));
    },
  }), { headers: { "content-type": "application/json", "x-generation-id": "gen-interrupted" } });
  try {
    await assert.rejects(
      callOpenRouter({ OPENROUTER_API_KEY: "local-test-only" } as Env, "assessment_review", { instructions: "Review fictional evidence", untrustedData: {} }),
      (error: unknown) => {
        assert.ok(error instanceof ModelCallError);
        assert.equal(error.uncertain, true);
        assert.equal(error.generationId, "gen-interrupted");
        assert.equal(error.code, "MODEL_DISPATCH_UNCERTAIN");
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
