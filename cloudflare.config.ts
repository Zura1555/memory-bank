import { bindings, defineConfig, exports, triggers } from "cf/config";

export default defineConfig(({ mode }) => ({
  accountId: "6d5eb3fa868f53e83e13401577cdfc01",
  worker: {
    name: "memory-bank",
    compatibilityDate: "2025-06-01",
    compatibilityFlags: mode === "development" ? ["nodejs_compat"] : ["nodejs_compat", "global_fetch_strictly_public"],
    entrypoint: "src/server/worker.ts",
    assets: {
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*"],
    },
    triggers: [
      triggers.scheduled({ schedule: "* * * * *" }),
      triggers.queue({
        name: "memory-bank-jobs",
        deadLetterQueue: "memory-bank-jobs-dead",
        maxBatchSize: 1,
        maxConcurrency: 1,
        maxRetries: 3,
      }),
    ],
    env: {
      APP_ENV: bindings.text(mode === "development" ? "development" : "production"),
      ...(mode === "development" ? {
        LOCAL_DATABASE_URL: bindings.secret(),
        MODEL_PROVIDER: bindings.secret(),
        MODEL_API: bindings.secret(),
        MODEL_BASE_URL: bindings.secret(),
        MODEL_NAME: bindings.secret(),
        OPENROUTER_API_KEY: bindings.secret(),
        OPENAI_API_KEY: bindings.secret(),
        ANTHROPIC_API_KEY: bindings.secret(),
        OPENCODE_API_KEY: bindings.secret(),
        OPERATOR_TOKEN: bindings.secret(),
      } : {}),
      HYPERDRIVE: mode !== "development" && bindings.hyperdrive({
        id: "0880749f093c4bdaab7dd377c76f68b4",
      }),
      ORIGINALS: bindings.r2({ name: "memory-bank-originals", dev: { remote: true } }),
      AI: bindings.ai({ dev: { remote: true } }),
      VECTORIZE: bindings.vectorize({
        name: mode === "development" ? "memory-bank-search-development" : "memory-bank-search-production",
        dev: { remote: true },
      }),
      // ponytail: per-location abuse guard, not a global spend cap; durable global budgeting would be required for spend enforcement.
      SEARCH_RATE_LIMITER: bindings.rateLimit({
        namespace: "1401",
        simple: { limit: 60, period: 60 },
      }),
      JOB_QUEUE: bindings.queue({ name: "memory-bank-jobs" }),
      WORKFLOW: bindings.workflow({
        name: "memory-bank-workflow",
        worker: "memory-bank",
        exportName: "MemoryBankWorkflow",
      }),
      ASSETS: bindings.assets(),
    },
    exports: {
      MemoryBankWorkflow: exports.workflow({ name: "memory-bank-workflow" }),
    },
  },
}));
