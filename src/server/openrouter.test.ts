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
      callOpenRouter({ OPENROUTER_API_KEY: "local-test-only" } as Env, "assessment_review", {
        instructions: "Review fictional evidence", untrustedData: {},
        reviewTargets: { claimIds: ["claim-one"], artifacts: [] },
      }),
      (error: unknown) => {
        assert.ok(error instanceof ModelCallError);
        assert.equal(error.uncertain, true);
        assert.equal(error.generationId, "gen-interrupted");
        assert.equal(error.code, "MODEL_DISPATCH_UNCERTAIN");
        assert.equal(error.status, 200);
        assert.equal(error.failurePhase, "response_body");
        assert.equal(error.failureCause, "timeout");
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("brief review cannot accept a verdict for a background assessment claim", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    id: "gen-wrong-inventory", model: "openai/gpt-6-luna", provider: "OpenAI",
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
      claimReviews: [{ claimId: "assessment-only", verdict: "supported" }],
    }) } }],
  }, { headers: { "x-generation-id": "gen-wrong-inventory" } });
  try {
    await assert.rejects(
      callOpenRouter({ OPENROUTER_API_KEY: "local-test-only" } as Env, "brief_review", {
        instructions: "Review the brief", untrustedData: {},
        reviewTargets: { claimIds: ["brief-only"] },
      }),
      (error: unknown) => {
        assert.ok(error instanceof ModelCallError);
        assert.equal(error.code, "MODEL_OUTPUT_SCHEMA_INVALID");
        assert.equal(error.uncertain, true);
        assert.equal(error.generationId, "gen-wrong-inventory");
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("transport diagnostics distinguish the observed deadline from other failures without retaining raw errors", async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  const scenarios = [
    { phase: "fetch", cause: "transport_error", error: new TypeError("private request: timeout"), deadline: false },
    { phase: "fetch", cause: "aborted", error: new DOMException("private request", "AbortError"), deadline: false },
    { phase: "fetch", cause: "deadline_exceeded", error: new TypeError("private request"), deadline: true },
    { phase: "response_body", cause: "deadline_exceeded", error: new DOMException("private request", "AbortError"), deadline: true },
  ];
  try {
    for (const scenario of scenarios) {
      AbortSignal.timeout = scenario.deadline
        ? () => AbortSignal.abort(new DOMException("local deadline", "TimeoutError"))
        : originalTimeout;
      let requests = 0;
      globalThis.fetch = async () => {
        requests++;
        if (scenario.phase === "fetch") throw scenario.error;
        return new Response(new ReadableStream({ start(controller) { controller.error(scenario.error); } }));
      };
      await assert.rejects(callOpenRouter({ OPENROUTER_API_KEY: "local-test-only" } as Env, "assessment_draft", {
        instructions: "Synthetic failure check", untrustedData: {},
      }), (error: unknown) => {
        assert.ok(error instanceof ModelCallError);
        assert.equal(error.code, "MODEL_DISPATCH_UNCERTAIN");
        assert.equal(error.uncertain, true);
        assert.equal(error.failurePhase, scenario.phase);
        assert.equal(error.failureCause, scenario.cause);
        assert.equal(error.status, scenario.phase === "fetch" ? null : 200);
        assert.ok(!JSON.stringify(error).includes("private request"));
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(requests, 1, "Failure classification must not retry provider access");
    }
  } finally {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
  }
});

test("provider rejections retain a safe generation ID without changing billing uncertainty", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const status of [429, 503]) {
      globalThis.fetch = async () => new Response("private provider payload", {
        status, headers: { "x-generation-id": "gen-rejected" },
      });
      await assert.rejects(callOpenRouter({ OPENROUTER_API_KEY: "local-test-only" } as Env, "assessment_draft", {
        instructions: "Synthetic rejection check", untrustedData: {},
      }), (error: unknown) => {
        assert.ok(error instanceof ModelCallError);
        assert.equal(error.code, "MODEL_PROVIDER_REJECTED");
        assert.equal(error.generationId, "gen-rejected");
        assert.equal(error.failurePhase, "response_headers");
        assert.equal(error.failureCause, null);
        assert.equal(error.status, status);
        assert.equal(error.uncertain, status >= 500);
        assert.ok(!JSON.stringify(error).includes("private provider payload"));
        return true;
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("invalid output preserves an envelope-only generation ID but rejects arbitrary diagnostic strings", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const id of ["gen-envelope-only", "private", "private request: must not persist", `gen-${"a".repeat(253)}`]) {
      globalThis.fetch = async () => Response.json({
        id, choices: [{ finish_reason: "stop", message: { content: "invalid JSON" } }],
      });
      await assert.rejects(callOpenRouter({ OPENROUTER_API_KEY: "local-test-only" } as Env, "assessment_draft", {
        instructions: "Synthetic output check", untrustedData: {},
      }), (error: unknown) => {
        assert.ok(error instanceof ModelCallError);
        assert.equal(error.code, "MODEL_OUTPUT_INVALID_JSON");
        assert.equal(error.uncertain, true);
        assert.equal(error.failurePhase, "output_validation");
        assert.equal(error.generationId, id === "gen-envelope-only" ? id : null);
        return true;
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
