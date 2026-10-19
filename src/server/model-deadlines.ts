// Total response completion budget, not a header or idle timeout.
// Recovered #32 generation + provider latency was 241.640 s; allow bounded headroom.
export const MODEL_REQUEST_TIMEOUT_MS = 300_000;
export const PAID_STEP_TIMEOUT_SECONDS = MODEL_REQUEST_TIMEOUT_MS / 1_000 + 30;
// One job-wide repair may add a draft and fresh review to a phase.
export const EXPOSED_PHASE_TIMEOUT_MS = (4 * PAID_STEP_TIMEOUT_SECONDS + 30) * 1_000;
