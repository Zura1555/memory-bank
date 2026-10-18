import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import type { Env } from "./env.ts";
import type { ArtifactReview, SupportVerdict } from "../shared/protocol.ts";
import { OPERATION_CHECKS } from "../shared/operations.ts";
import { callModel, ModelCallError, modelConfig } from "./model.ts";
import { requestSpans } from "./request-constraints.ts";
import { buildCheckedBrief, validateBriefDraft } from "./gates.ts";
import { briefDraftSchemaFor } from "./schemas.ts";

const checkedReview = (artifactId: string): ArtifactReview => {
  const sourceRefs = [{ caseId: "case-1", artifactId, versionId: `${artifactId}-v1`, passageId: "p1" }];
  return {
    caseId: "case-1", artifactId, role: "starting_point", verdict: "supported", reasons: [],
    decision: {
      disposition: "adapt", operation: "api_adapter", historicalEvidence: sourceRefs, requestQuotes: [],
      adaptations: [{ text: "Adapt the recorded adapter to the current client.", sourceRefs, requestQuotes: [] }],
      checks: [{ kind: "client_api_access", text: OPERATION_CHECKS.api_adapter.client_api_access, sourceRefs, requestQuotes: [] }],
    },
  };
};
const checkedBriefDecisions = { cases: [{ caseId: "case-1", artifactWork: [{ artifactId: "art", disposition: "adapt" as const }] }], artifactReviews: [checkedReview("art")] };

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
      callModel({ OPENROUTER_API_KEY: "local-test-only" } as Env, "assessment_review", {
        instructions: "Review fictional evidence", untrustedData: {},
        currentRequest: "current request",
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
      callModel({ OPENROUTER_API_KEY: "local-test-only" } as Env, "brief_review", {
        instructions: "Review the brief", untrustedData: {},
        currentRequest: "current request",
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
      await assert.rejects(callModel({ OPENROUTER_API_KEY: "local-test-only" } as Env, "assessment_draft", {
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
      await assert.rejects(callModel({ OPENROUTER_API_KEY: "local-test-only" } as Env, "assessment_draft", {
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
      await assert.rejects(callModel({ OPENROUTER_API_KEY: "local-test-only" } as Env, "assessment_draft", {
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

test("compatible providers normalize reviews but reject foreign claims and truncated results", async () => {
  const originalFetch = globalThis.fetch;
  const prompt = {
    instructions: "Review the brief", untrustedData: {},
    reviewTargets: { claimIds: ["brief-claim"], selections: [] },
  };
  try {
    for (const provider of ["openai", "anthropic"]) {
      const env = {
        MODEL_PROVIDER: provider, MODEL_NAME: "compatible-model",
        OPENAI_API_KEY: "local-openai-only", ANTHROPIC_API_KEY: "local-anthropic-only",
      } as Env;
      for (const scenario of ["valid", "foreign-claim", "truncated"]) {
        const output = {
          claimVerdicts: { [scenario === "foreign-claim" ? "foreign" : "brief-claim"]: "supported" },
          constraintQuotes: {},
        };
        const id = provider === "anthropic" ? "msg_review" : "chatcmpl-review";
        globalThis.fetch = async () => Response.json(provider === "anthropic" ? {
          id, model: "served-model", stop_reason: scenario === "truncated" ? "max_tokens" : "tool_use",
          content: [{ type: "tool_use", name: "submit_result", input: output }],
          usage: { input_tokens: 123, output_tokens: 45 },
        } : {
          id, model: "served-model",
          choices: [{ finish_reason: scenario === "truncated" ? "length" : "stop", message: { content: JSON.stringify(output) } }],
          usage: { prompt_tokens: 123, completion_tokens: 45 },
        });
        if (scenario === "valid") {
          const result = await callModel(env, "brief_review", prompt);
          assert.deepEqual(result.output, {
            claimReviews: [{ claimId: "brief-claim", verdict: "supported" }], constraintReviews: [],
          });
          assert.deepEqual(result.usage, {
            promptTokens: 123, completionTokens: 45, reportedCostUsd: null,
            responseId: id, requestedModel: "compatible-model", returnedModel: "served-model",
            provider: provider === "anthropic" ? "api.anthropic.com" : "api.openai.com",
          });
        } else {
          await assert.rejects(callModel(env, "brief_review", prompt), (error: unknown) => {
            assert.ok(error instanceof ModelCallError);
            assert.equal(error.code, scenario === "foreign-claim" ? "MODEL_OUTPUT_SCHEMA_INVALID"
              : provider === "anthropic" ? "MODEL_OUTPUT_INCOMPLETE_OR_REFUSED" : "MODEL_OUTPUT_TOKEN_LIMIT");
            assert.equal(error.uncertain, true);
            assert.equal(error.generationId, id);
            return true;
          });
        }
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("invalid endpoint configuration and missing selected credentials fail before dispatch", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("must not dispatch"); };
  try {
    for (const invalid of [
      { MODEL_PROVIDER: "unknown" },
      { MODEL_PROVIDER: "openai" },
      { MODEL_PROVIDER: "opencode-go", MODEL_NAME: "gpt-6-luna" },
      { MODEL_PROVIDER: "opencode-go", MODEL_API: "unknown", MODEL_NAME: "gpt-6-luna" },
      { MODEL_PROVIDER: "opencode-go", MODEL_API: "responses" },
      { MODEL_BASE_URL: "https://user:secret@example.com/v1" },
      { MODEL_BASE_URL: "http://example.com/v1" },
      { MODEL_BASE_URL: "https://example.com/v1?api_key=secret" },
      { MODEL_BASE_URL: "not a URL" },
    ]) {
      assert.throws(() => modelConfig(invalid as Env), { code: "MODEL_CONFIGURATION_INVALID" });
    }
    for (const provider of ["openai", "anthropic"]) {
      await assert.rejects(callModel({
        MODEL_PROVIDER: provider, MODEL_NAME: "model", OPENROUTER_API_KEY: "wrong-provider-key",
      } as Env, "assessment_draft", { instructions: "No dispatch", untrustedData: {} }), {
        code: "MODEL_CREDENTIAL_UNAVAILABLE", uncertain: false,
      });
    }
    const go = { MODEL_PROVIDER: "opencode-go", MODEL_API: "responses", MODEL_NAME: "gpt-6-luna" };
    await assert.rejects(callModel({
      ...go, OPENAI_API_KEY: "wrong-provider-key",
    } as Env, "assessment_draft", { instructions: "No dispatch", untrustedData: {} }, "job-one"), {
      code: "MODEL_CREDENTIAL_UNAVAILABLE", uncertain: false,
    });
    for (const session of [undefined, "", "private\r\nheader", "x".repeat(129)]) {
      await assert.rejects(callModel({
        ...go, OPENCODE_API_KEY: "synthetic-only",
      } as Env, "assessment_draft", { instructions: "No dispatch", untrustedData: {} }, session), {
        code: "MODEL_SESSION_INVALID", uncertain: false,
      });
    }
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Go protocols preserve review validation, usage, and per-job identity over HTTP", async () => {
  let reply: unknown;
  const requests: { path: string; headers: IncomingHttpHeaders }[] = [];
  const server = createServer(async (request, response) => {
    request.resume();
    requests.push({ path: request.url!, headers: request.headers });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(reply));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}/gateway/v1/`;
  const prompt = {
    instructions: "Review fictional evidence", untrustedData: { request: "Untrusted request" },
    reviewTargets: { claimIds: ["brief-claim"], selections: [] },
  };
  try {
    for (const api of ["chat-completions", "messages", "responses"]) {
      const model = api === "responses" ? "gpt-6-luna" : api === "messages" ? "minimax-m3" : "kimi-k3";
      const env = {
        MODEL_PROVIDER: "opencode-go", MODEL_API: api, MODEL_NAME: model, MODEL_BASE_URL: base,
        OPENCODE_API_KEY: "synthetic-go-only", OPENAI_API_KEY: "wrong-provider-key", ANTHROPIC_API_KEY: "wrong-provider-key",
      } as Env;
      const defaultConfig = modelConfig({ ...env, MODEL_BASE_URL: undefined });
      assert.equal(defaultConfig.url, `https://opencode.ai/inference/go/${api === "messages" ? "anthropic" : "openai"}/v1/${api === "chat-completions" ? "chat/completions" : api}`);
      for (const scenario of ["valid", "foreign-claim", "truncated"]) {
        const output = { claimVerdicts: { [scenario === "foreign-claim" ? "foreign" : "brief-claim"]: "supported" }, constraintQuotes: {} };
        const id = api === "responses" ? "resp_review" : api === "messages" ? "msg_review" : "chatcmpl-review";
        reply = api === "messages" ? {
          id, model, stop_reason: scenario === "truncated" ? "max_tokens" : "tool_use",
          content: [{ type: "tool_use", name: "submit_result", input: output }],
          usage: { input_tokens: 123, output_tokens: 45 },
        } : api === "responses" ? {
          id, model, status: scenario === "truncated" ? "incomplete" : "completed",
          output: [
            { type: "reasoning", summary: [] },
            { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(output) }] },
          ],
          usage: { input_tokens: 123, output_tokens: 45 },
        } : {
          id, model, choices: [{ finish_reason: scenario === "truncated" ? "length" : "stop", message: { content: JSON.stringify(output) } }],
          usage: { prompt_tokens: 123, completion_tokens: 45 },
        };
        const session = scenario === "foreign-claim" ? "job-two" : "job-one";
        if (scenario === "valid") {
          const result = await callModel(env, "brief_review", prompt, session);
          assert.deepEqual(result.output, { claimReviews: [{ claimId: "brief-claim", verdict: "supported" }], constraintReviews: [] });
          assert.deepEqual(result.usage, {
            promptTokens: 123, completionTokens: 45, reportedCostUsd: null, responseId: id,
            requestedModel: model, returnedModel: model, provider: `127.0.0.1:${address.port}`,
          });
        } else {
          await assert.rejects(callModel(env, "brief_review", prompt, session), {
            code: scenario === "foreign-claim" ? "MODEL_OUTPUT_SCHEMA_INVALID"
              : api === "chat-completions" ? "MODEL_OUTPUT_TOKEN_LIMIT" : "MODEL_OUTPUT_INCOMPLETE_OR_REFUSED",
            generationId: id, uncertain: true,
          });
        }
        const request = requests.at(-1)!;
        assert.equal(requests.length, ["chat-completions", "messages", "responses"].indexOf(api) * 3 + ["valid", "foreign-claim", "truncated"].indexOf(scenario) + 1,
          "No automatic retry is allowed after a billed response");
        assert.equal(request.path, `/gateway/v1/${api === "chat-completions" ? "chat/completions" : api}`);
        assert.equal(request.headers["x-opencode-session"], session);
        assert.match(request.headers["user-agent"]!, /^memory-bank\//);
        assert.equal(request.headers[api === "messages" ? "x-api-key" : "authorization"],
          api === "messages" ? "synthetic-go-only" : "Bearer synthetic-go-only");
        assert.ok(!JSON.stringify(request).includes("wrong-provider-key"));
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("Responses refuses partial, refused, ambiguous, or non-JSON outputs and preserves billing diagnostics", async () => {
  const originalFetch = globalThis.fetch;
  const message = {
    type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: '{"claimVerdicts":{},"constraintQuotes":{}}' }],
  };
  const scenarios = [
    { status: "failed" },
    { incomplete_details: { reason: "max_output_tokens" } },
    { error: { code: "server_error" } },
    { output: [{ ...message, status: "incomplete" }] },
    { output: [{ ...message, content: [...message.content, { type: "refusal" }] }] },
    { output: [] },
    { output: [message, message] },
    { output: [message, { type: "function_call" }] },
    { output: [{ ...message, content: [{ type: "output_text", text: "invalid JSON" }] }], code: "MODEL_OUTPUT_INVALID_JSON" },
    { output: "malformed envelope", code: "MODEL_RESPONSE_INVALID" },
  ];
  try {
    for (const { code = "MODEL_OUTPUT_INCOMPLETE_OR_REFUSED", ...override } of scenarios) {
      let requests = 0;
      globalThis.fetch = async () => {
        requests++;
        return Response.json({ id: "resp_diagnostic", status: "completed", output: [message], ...override });
      };
      await assert.rejects(callModel({
        MODEL_PROVIDER: "opencode-go", MODEL_API: "responses", MODEL_NAME: "gpt-6-luna", OPENCODE_API_KEY: "synthetic-only",
      } as Env, "brief_review", {
        instructions: "Review fictional evidence", untrustedData: {}, reviewTargets: { claimIds: [], selections: [] },
      }, "job-one"), { code, generationId: "resp_diagnostic", uncertain: true, status: 200 });
      assert.equal(requests, 1);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("provider output selects a request identity whose original quotation remains visible after normalization", async () => {
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
  const prompt = { instructions: "Draft a brief", untrustedData: {}, responseSchema: briefDraftSchemaFor(request, selected, corpus, checkedBriefDecisions) };
  const wire = (text: string) => JSON.stringify({
    items: { "case-1/art/art-v1": {
      disposition: "adapt",
      recommendation: { text, sourceRefs: ["e1"], requestQuotes: [requestSpans(request)[0].spanId] },
      claims: [],
    } },
  });
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ id: "gen-brief-visible-quote", choices: [{ finish_reason: "stop", message: { content: wire(`Adapt only after this check: ${request}`) } }] });
    const accepted = await callModel({ OPENROUTER_API_KEY: "local-test-only" } as Env, "brief_draft", prompt);
    assert.equal((accepted.output as { adapt: unknown[] }).adapt.length, 1);
    globalThis.fetch = async () => Response.json({
      id: "gen-brief-hidden-quote", choices: [{ finish_reason: "stop", message: { content: wire("Adapt after checking compatibility.") } }],
    });
    const composed = await callModel({ OPENROUTER_API_KEY: "local-test-only" } as Env, "brief_draft", prompt);
    const composedClaim = (composed.output as { claims: { text: string }[] }).claims[0];
    assert.ok(composedClaim.text.startsWith("Check the target window first. "),
      "Hidden quotation metadata is never trusted as-is: the declared sentence is composed verbatim into the visible claim text before any brief is accepted");
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
      await assert.rejects(callModel({ OPENROUTER_API_KEY: "synthetic-only" } as Env, "assessment_review", {
        instructions: "Synthetic output failure", untrustedData: {},
        currentRequest: "current request",
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

test("provider redirects are rejected without forwarding the request or retrying", async () => {
  let status = 302;
  let requests = 0;
  let redirected = 0;
  const server = createServer((request, response) => {
    request.resume();
    if (request.url === "/redirected") {
      redirected++;
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    requests++;
    response.writeHead(status, { location: "/redirected" });
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  try {
    for (status of [302, 307]) {
      await assert.rejects(callModel({
        MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        OPENROUTER_API_KEY: "synthetic-only",
      } as Env, "assessment_review", {
        instructions: "Synthetic redirect check", untrustedData: {},
        currentRequest: "current request",
        reviewTargets: { claimIds: [], artifacts: [] },
      }), {
        code: "MODEL_PROVIDER_REJECTED", status, uncertain: false, failurePhase: "response_headers",
      });
    }
    assert.equal(requests, 2, "Each call reaches only its configured endpoint once");
    assert.equal(redirected, 0, "Neither credentials nor request content may reach a redirect target");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("brief citations derive exact item-local facts and preserve independent rejection", () => {
  const request = "Check the target window first.";
  const artifacts = ["art", "other-art"].map((artifactId, index) => ({
    artifactId, title: artifactId, fictional: true,
    versions: [{
      versionId: `${artifactId}-v1`, sourcePath: `corpora/test/originals/${artifactId}`, mimeType: "text/plain", sha256: "x",
      statedDate: null, importedAt: "2026-01-01", extractionStatus: "complete", exclusionReasons: [],
      passages: [
        { passageId: `p${index * 2 + 1}`, excerpt: `Recorded ${artifactId} procedure.`, sourceKind: "source", location: "L1" },
        { passageId: `p${index * 2 + 2}`, excerpt: `Stop ${artifactId} for client review on rejection.`, sourceKind: "source", location: "L2" },
      ],
    }],
  }));
  const corpus = {
    manifest: { schemaVersion: 2, corpusVersion: "test", cases: [{ caseId: "case-1", title: "Case", fictional: true, records: [], artifacts }] },
    manifestSha256: "x", availableVersions: new Set(artifacts.map((artifact) => artifact.versions[0].versionId)), caseAvailability: new Map(),
    passages: new Map(artifacts.flatMap((artifact) => artifact.versions[0].passages.map((passage) => [passage.passageId, {
      caseId: "case-1", artifactId: artifact.artifactId, versionId: artifact.versions[0].versionId,
      passageId: passage.passageId, title: artifact.title, fictional: true, statedDate: null,
      excerpt: passage.excerpt, sourceKind: passage.sourceKind, location: passage.location,
    }]))),
    versions: new Map(),
  } as never;
  const selected = artifacts.map((artifact) => ({
    caseId: "case-1", artifactId: artifact.artifactId, versionId: artifact.versions[0].versionId,
    passageIds: [artifact.versions[0].passages[0].passageId],
  }));
  const keys = selected.map((item) => `${item.caseId}/${item.artifactId}/${item.versionId}`);
  const schema = briefDraftSchemaFor(request, selected, corpus, {
    cases: [{ caseId: "case-1", artifactWork: artifacts.map(({ artifactId }) => ({ artifactId, disposition: "adapt" as const })) }],
    artifactReviews: artifacts.map(({ artifactId }) => checkedReview(artifactId)),
  });
  const wire = { items: Object.fromEntries(keys.map((key, index) => [key, {
    disposition: "adapt",
    recommendation: { text: "Adapt after checking the target window.", sourceRefs: [`e${index * 2 + 1}`], requestQuotes: [] },
    claims: [{ kind: "recommendation", text: "Stop for client review on rejection.", sourceRefs: [`e${index * 2 + 2}`, `e${index * 2 + 2}`], requestQuotes: [] }],
  }])) };
  const parsed = schema.parse(wire);
  assert.equal(validateBriefDraft(parsed, request, selected, corpus).size, 0);
  for (const item of parsed.adapt) {
    const owned = parsed.claims.filter((claim) => item.claimIds.includes(claim.claimId));
    const facts = owned.filter((claim) => claim.kind === "source_fact");
    const passages = artifacts.find((artifact) => artifact.artifactId === item.artifactId)!.versions[0].passages;
    assert.deepEqual(new Set(facts.flatMap((claim) => claim.sourceRefs.map((ref) => ref.passageId))), new Set(passages.map((passage) => passage.passageId)));
    assert.equal(facts.length, 2, "Repeated citations derive only one fact per passage.");
    for (const fact of facts) {
      assert.equal(fact.text, passages.find((passage) => passage.passageId === fact.sourceRefs[0].passageId)!.excerpt);
      assert.deepEqual(fact.requestQuotes, []);
      assert.deepEqual(fact.dependsOnClaimIds, []);
    }
    for (const authored of owned.filter((claim) => claim.kind !== "source_fact")) {
      for (const ref of authored.sourceRefs) {
        const fact = facts.find((claim) => claim.sourceRefs[0].passageId === ref.passageId)!;
        assert.ok(authored.dependsOnClaimIds.includes(fact.claimId));
      }
      if (authored.claimId !== item.dispositionClaimId) assert.ok(authored.dependsOnClaimIds.includes(item.dispositionClaimId));
    }
  }
  const foreign = structuredClone(wire);
  foreign.items[keys[0]].claims[0].sourceRefs = ["e3"];
  assert.equal(schema.safeParse(foreign).success, false, "Another selected artifact cannot supply a local fact.");
  const unknown = structuredClone(wire);
  unknown.items[keys[0]].claims[0].sourceRefs = ["missing"];
  assert.equal(schema.safeParse(unknown).success, false);
  const oldFactInventory = structuredClone(wire);
  Object.assign(oldFactInventory.items[keys[0]].claims[0], { kind: "source_fact" });
  assert.equal(schema.safeParse(oldFactInventory).success, false, "The redundant model-authored fact inventory is no longer wire input.");
  for (const target of ["recommendation", "claims"] as const) {
    const injected = structuredClone(wire);
    Object.assign(target === "recommendation" ? injected.items[keys[0]].recommendation : injected.items[keys[0]].claims[0], { dependsOnClaimIds: [] });
    assert.equal(schema.safeParse(injected).success, false, "The model cannot author dependency edges.");
  }
  assert.equal(schema.safeParse({ ...wire, claims: [] }).success, false);
  const verdicts = new Map<string, SupportVerdict>(parsed.claims.map((claim) => [claim.claimId, "supported"]));
  const disposition = parsed.claims.find((claim) => claim.claimId === parsed.adapt[0].dispositionClaimId)!;
  const decisiveFact = parsed.claims.find((claim) => claim.kind === "source_fact" && disposition.dependsOnClaimIds.includes(claim.claimId))!;
  verdicts.set(decisiveFact.claimId, "unsupported");
  const checked = buildCheckedBrief(parsed, verdicts, validateBriefDraft(parsed, request, selected, corpus), {
    request, constraintReviews: selected.map(({ caseId, artifactId, versionId }) => ({ caseId, artifactId, versionId, requestQuotes: [] })),
  });
  assert.deepEqual(checked.adapt.map((item) => item.artifactId), ["other-art"]);
  assert.ok(checked.claims.every((claim) => claim.sourceRefs.every((ref) => ref.artifactId === "other-art") || claim.kind === "source_fact"));
});

test("brief wire format composes a declared quotation verbatim instead of requiring retyped prose", async () => {
  const request = "Check the target window first. Preserve the audit trail after cutover.";
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
  const schema = briefDraftSchemaFor(request, selected, corpus, checkedBriefDecisions);
  const draft = (claims: { kind: string; text: string; sourceRefs: string[]; requestQuotes: string[] }[]) => ({
    items: { "case-1/art/art-v1": {
      disposition: "adapt", recommendation: {
        text: claims[0].text, sourceRefs: claims[0].sourceRefs,
        requestQuotes: claims[0].requestQuotes.map((quote) => requestSpans(request).find((span) => span.text === quote)!.spanId),
      }, claims: claims.slice(1),
    } },
  });
  // The claim declares its sentence exactly but states only the check in
  // prose: the declared sentence is composed verbatim into the stored text.
  const parsed = schema.parse(draft([
    { kind: "recommendation", text: "Adapt only after confirming the window with the client.", sourceRefs: ["e1"], requestQuotes: ["Check the target window first."] },
  ]));
  assert.ok(parsed.adapt[0].claimIds.includes("brief-0-disposition"));
  const composed = parsed.claims.find((claim) => claim.claimId === "brief-0-disposition")!;
  assert.ok(composed.text.startsWith("Check the target window first. "),
    "The declared quotation heads the stored claim text verbatim.");
  assert.ok(composed.text.includes("confirming the window with the client."));
  // Prose carrying a different complete request sentence than the declared
  // one is still rejected at parse time; composition never repairs that.
  assert.throws(() => schema.parse(draft([
    { kind: "recommendation", text: "Preserve the audit trail after cutover. Then adapt.", sourceRefs: ["e1"], requestQuotes: ["Check the target window first."] },
  ])));
});
