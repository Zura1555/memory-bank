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
      claimVerdicts: { "assessment-only": "supported" },
    }) } }],
  }, { headers: { "x-generation-id": "gen-wrong-inventory" } });
  try {
    await assert.rejects(
      callOpenRouter({ OPENROUTER_API_KEY: "local-test-only" } as Env, "brief_review", {
        instructions: "Review the brief", untrustedData: {},
        reviewTargets: { claimIds: ["brief-only"], selections: [{ caseId: "case", artifactId: "artifact", versionId: "version" }] },
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

test("brief provider grammar omits sentence patterns while runtime parsing still requires the visible quotation", async () => {
  const { briefDraftSchemaFor } = await import("./schemas.ts");
  const request = "Check the target window first.";
  const corpus = {
    manifest: { schemaVersion: 2, corpusVersion: "test", cases: [{
      caseId: "case-1", title: "Case", fictional: true, records: [],
      artifacts: [{ artifactId: "art", title: "Art", fictional: true, versions: [{
        versionId: "art-v1", sourcePath: "corpora/test/originals/x", mimeType: "text/plain", sha256: "x",
        statedDate: null, importedAt: "2026-01-01", extractionStatus: "complete", exclusionReasons: [],
        passages: [{ passageId: "p1", excerpt: "Recorded procedure.", sourceKind: "source", location: "L1" }],
      }] }],
    }] },
    manifestSha256: "x", availableVersions: new Set(["art-v1"]), caseAvailability: new Map(),
    passages: new Map([["p1", { caseId: "case-1", artifactId: "art", versionId: "art-v1", passageId: "p1", title: "Art", fictional: true, statedDate: null, excerpt: "Recorded procedure.", sourceKind: "source", location: "L1" }]]),
    versions: new Map(),
  } as never;
  const selected = [{ caseId: "case-1", artifactId: "art", versionId: "art-v1", passageIds: ["p1"] }];
  const prompt = { instructions: "Draft a brief", untrustedData: {}, responseSchema: briefDraftSchemaFor(request, selected, corpus) };
  const wire = (text: string) => JSON.stringify({
    items: { "case-1/art/art-v1": { disposition: "adapt", dispositionClaimId: "c1", claimIds: ["c1"] } },
    claims: [{ claimId: "c1", kind: "recommendation", text, sourceRefs: ["e1"], requestQuotes: [request], dependsOnClaimIds: [] }],
  });
  const originalFetch = globalThis.fetch;
  try {
    let capturedSchema = "";
    globalThis.fetch = async (_input, init) => {
      capturedSchema = JSON.stringify(JSON.parse(init!.body as string).response_format.json_schema.schema);
      return Response.json({ id: "gen-brief-visible-quote", choices: [{ finish_reason: "stop", message: { content: wire(`Adapt only after this check: ${request}`) } }] });
    };
    const accepted = await callOpenRouter({ OPENROUTER_API_KEY: "local-test-only" } as Env, "brief_draft", prompt);
    assert.equal((accepted.output as { adapt: unknown[] }).adapt.length, 1);
    const patterns: string[] = [];
    const collect = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(collect);
      if (typeof node !== "object" || node === null) return;
      for (const [key, value] of Object.entries(node)) { if (key === "pattern") patterns.push(String(value)); collect(value); }
    };
    collect(JSON.parse(capturedSchema));
    assert.ok(!patterns.some((pattern) => pattern.includes("Check the target")), "Provider schema must not embed the request sentence as a text pattern");
    assert.ok(capturedSchema.includes("^[a-z0-9]"), "Anchored identity patterns stay in the provider grammar");

    globalThis.fetch = async () => Response.json({
      id: "gen-brief-hidden-quote", choices: [{ finish_reason: "stop", message: { content: wire("Adapt after checking compatibility.") } }],
    });
    await assert.rejects(callOpenRouter({ OPENROUTER_API_KEY: "local-test-only" } as Env, "brief_draft", prompt), (error: unknown) => {
      assert.ok(error instanceof ModelCallError);
      assert.equal(error.code, "MODEL_OUTPUT_SCHEMA_INVALID", "Hidden quotation metadata is still rejected before any brief is accepted");
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unusable output retains reported usage and distinguishes safe failure conditions without retrying", async () => {
  const originalFetch = globalThis.fetch;
  const scenarios = [
    { choices: [], code: "MODEL_OUTPUT_CHOICE_MISSING" },
    { choices: [{ finish_reason: "length", message: { content: "PRIVATE_PARTIAL_OUTPUT" } }], code: "MODEL_OUTPUT_TOKEN_LIMIT" },
    { choices: [{ finish_reason: "stop", message: { refusal: "PRIVATE_REFUSAL" } }], code: "MODEL_OUTPUT_REFUSED" },
    { choices: [{ finish_reason: "content_filter" }], code: "MODEL_OUTPUT_CONTENT_FILTERED" },
    { choices: [{ finish_reason: "PRIVATE_UNKNOWN_REASON" }], code: "MODEL_OUTPUT_NOT_STOPPED" },
    { choices: [{ finish_reason: "stop", message: {} }], code: "MODEL_OUTPUT_CONTENT_MISSING" },
    { choices: [{ finish_reason: "stop", message: { content: "PRIVATE_INVALID_JSON" } }], code: "MODEL_OUTPUT_INVALID_JSON" },
    { choices: [{ finish_reason: "stop", message: { content: "{}" } }], code: "MODEL_OUTPUT_SCHEMA_INVALID" },
    { choices: [{ finish_reason: "length" }], code: "MODEL_OUTPUT_TOKEN_LIMIT", unpriced: true },
  ];
  try {
    for (const scenario of scenarios) {
      let requests = 0;
      globalThis.fetch = async () => {
        requests++;
        return Response.json({
          id: "gen-unusable-output", model: "openai/gpt-6-luna", provider: "OpenAI",
          choices: scenario.choices,
          ...("unpriced" in scenario ? {} : { usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.001 } }),
        });
      };
      await assert.rejects(callOpenRouter({ OPENROUTER_API_KEY: "synthetic-only" } as Env, "assessment_review", {
        instructions: "Synthetic output failure", untrustedData: {},
        reviewTargets: { claimIds: ["claim-one"], artifacts: [] },
      }), (error: unknown) => {
        assert.ok(error instanceof ModelCallError);
        assert.equal(error.code, scenario.code);
        assert.equal(error.uncertain, true, "Reported usage does not authorize releasing a hold or accepting output");
        assert.equal(error.generationId, "gen-unusable-output");
        assert.equal(error.failurePhase, "output_validation");
        assert.deepEqual(error.usage, {
          promptTokens: "unpriced" in scenario ? null : 100,
          completionTokens: "unpriced" in scenario ? null : 20,
          reportedCostUsd: "unpriced" in scenario ? null : 0.001,
          responseId: "gen-unusable-output", requestedModel: "openai/gpt-6-luna",
          returnedModel: "openai/gpt-6-luna", provider: "OpenAI",
        });
        assert.ok(!JSON.stringify(error).includes("PRIVATE_"));
        return true;
      });
      assert.equal(requests, 1);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
