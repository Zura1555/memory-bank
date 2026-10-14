FICTIONAL SOURCE — Synthetic delivery notes. No real client or system is represented.

# Finch connector history

Date stated: 2024-11-12 to 2025-05-06

2024-11-12 — Test connector used TripPine API v1 polling every 15 minutes. In the test tenant, 38 of 40 sample status updates appeared in LedgerWing v1. Two remained pending; their cause was not investigated. The client accepted the test demonstration, not a production rollout.

2025-05-02 — TripPine announced API v2 for Finch’s planned expansion. The new request requires bulk asynchronous reservation updates. A review of the v2 capability sheet found no bulk job submission or asynchronous result retrieval for this account tier. The v1 connector’s polling behavior is not evidence of v2 compatibility.
2025-05-04 — Limited v2 compatibility probe used one non-writing status lookup in Finch’s test tenant. TripPine v2 returned `410 endpoint retired` for the v1 polling route; no updates were submitted. The probe confirms that this polling endpoint cannot be carried forward, but does not test any bulk or asynchronous alternative.

2025-05-06 — Correction to earlier planning note: a draft checklist said “carry forward the polling connector.” That advice is withdrawn for the v2 bulk workflow; it describes only the old v1 test. No bulk async integration attempt or outcome is recorded. The v1 test’s two pending records remain unexplained.
