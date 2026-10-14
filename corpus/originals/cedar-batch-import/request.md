FICTIONAL SOURCE — Synthetic client-onboarding record. No real client or system is represented.

# Cedar Supply: request and acceptance

Date stated: 2025-02-03

Cedar Supply asked the fictional Juniper Delivery team to import 1,200 supplier records from a UTF-8 CSV export into a sandboxed LedgerLeaf workspace. The source export has 1,236 rows including a header and 36 rows marked inactive; the client wants active suppliers only. Each active row has a source key, legal name, contact email, and payment term code. The target has corresponding fields plus an internal target ID.

Acceptance note (2025-02-05): load active records, retain the source key for reconciliation, and provide counts for accepted, rejected, and duplicate rows. Client will review the rejection list. No production credentials or production writes are authorized.

The client says emails are unique “as far as we know”; no independent uniqueness audit was requested. Historical outcome for production is not applicable: this request was sandbox-only.
