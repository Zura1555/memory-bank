FICTIONAL SOURCE — Synthetic client-onboarding request. No real client or system is represented.

# Finch Travel: reservation sync request

Date stated: 2024-11-06

Finch Travel requested a one-way reservation-status connector from fictional TripPine API v1 to fictional LedgerWing API v1. Expected volume was at most 40 updates per day. The request asked for status polling every 15 minutes and a daily exception report. No bulk asynchronous processing was requested or assessed at the time.

The target's API generation and current support status were not included in the signed request. Credentials were limited to a test tenant. Acceptance required seeing status updates in the test ledger; no promise about newer API versions or bulk operations appears in the request.
