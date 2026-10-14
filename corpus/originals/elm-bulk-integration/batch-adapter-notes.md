FICTIONAL SOURCE — Synthetic work product. No real client or system is represented.

# Elm sandbox batch adapter notes

Date stated: 2025-04-11

1. Read StayLedger v4 adjustment export and retain each `adjustment_ref` unchanged.
2. Submit at most 500 records to PaySpring Connect v3 `POST /jobs`; retain returned job ID.
3. Retrieve job status later and associate every per-item result with `adjustment_ref`.
4. Record accepted and rejected item counts. Do not resubmit a job solely because polling was interrupted; retrieve its terminal status first.
5. Stop for client review on batch-level validation rejection.

Observed sandbox boundaries: this sample used two 300-item batches. It does not demonstrate production writes, sustained throttling, or behavior for larger jobs. No generic retry policy was validated; confirm version, limits, and duplicate handling with the new tenant before adapting.
