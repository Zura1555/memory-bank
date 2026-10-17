import { bindings, defineConfig, exports, triggers } from "cf/config";

export default defineConfig(({ mode }) => ({
  accountId: "6d5eb3fa868f53e83e13401577cdfc01",
  worker: {
    name: "memory-bank",
    compatibilityDate: "2025-06-01",
    compatibilityFlags: ["nodejs_compat"],
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
      HYPERDRIVE: mode !== "development" && bindings.hyperdrive({
        id: "0880749f093c4bdaab7dd377c76f68b4",
      }),
      ORIGINALS: bindings.r2({ name: "memory-bank-originals" }),
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
