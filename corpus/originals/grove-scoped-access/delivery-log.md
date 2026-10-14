FICTIONAL SOURCE — Synthetic delivery notes. No real client or system is represented.

# Grove access setup notes

Date stated: 2025-01-20 to 2025-01-22

2025-01-20 — Early draft from a support engineer proposed temporary tenant-wide administrator access “to avoid delays.” No account was provisioned using that draft. Security contact rejected it because the request covers only job diagnostics.

2025-01-21 — Corrective decision: create two named accounts in `Import-Diagnostics-Readers`, grant read-only job status and rejected-row fields in the test workspace, require MFA, and set expiry for 2025-01-31. No chart access or configuration permission. Group membership is conditional on the identity provider retaining the expiry attribute.

2025-01-22 — Client provided screenshots showing both named accounts in the group, test-workspace scope, MFA enabled, and expiry date. Audit export lists sign-in time and account but omits viewed record identifiers. Client accepted this setup for the requested test period. Removal after expiry was not observed in our records; the account status on 2025-02-01 is unknown.
