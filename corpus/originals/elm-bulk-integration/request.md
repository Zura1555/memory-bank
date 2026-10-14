FICTIONAL SOURCE — Synthetic client-onboarding request. No real client or system is represented.

# Elm Rentals: billing integration request

Date stated: 2025-04-02

Elm Rentals asked for a connector between its fictional StayLedger v4 account and fictional PaySpring Connect API v3. The workflow must submit billing adjustments in bulk asynchronously, receive a job identifier, and later retrieve per-item results. They expect around 2,400 adjustments per month; target throttling limits and retry semantics were not documented at intake.

Acceptance requires evidence that the source can submit a batch, the target can process it asynchronously, and each adjustment can be reconciled to a result. Production write authorization is conditional on a client-operated sandbox review. The request does not establish that the prior connector handles Elm’s credentials, rate limits, or error mix.
