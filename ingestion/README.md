# Offline corpus ingestion

From the repository root:

```sh
python3.12 -m pip install -r ingestion/requirements.txt
python3.12 ingestion/build_manifest.py
```

The command reads `corpus/catalog.json` and source files named there, then writes `corpus/manifest.json` and `ingestion/audit.json`. Use `--root`, `--catalog`, and `--manifest` to override paths. Catalog paths are repository-relative and cannot escape the root. Rebuild after every source or curator-audit change; SHA-256 is computed over the original bytes.

Published original keys are namespaced by `corpusVersion` (`corpora/<corpusVersion>/originals/...`). Increment `corpusVersion` for every source or extraction-edition change; passage IDs are deterministic within that edition. The active manifest pointer is `corpus/manifest.json`. Never reuse a version namespace for changed originals.

Text/Markdown and CSV are decoded as strict UTF-8. Office and PDF extraction uses the listed Python libraries; formulas/macros/scripts and links are never executed or followed. Any unsupported or unrepresented content marks that complete version incomplete and removes all its passages from runtime evidence. The audit report records importer decisions separately from the runtime manifest.

Any scanned PDF, image, or unrepresented visual content stays incomplete unless an adjacent `<original filename>.audit.json` sidecar is present. It must bind to the source SHA-256 and include a timezone-qualified ISO `reviewedAt`, `reviewer`, and reviewed `regions`; every region requires a stable `regionId`, exact `excerpt`, `sourceKind`, exact schema-valid `location`, and `verified: true`. Example:

```json
{
  "sourceSha256": "REPLACE_WITH_64_CHARACTER_SOURCE_SHA256",
  "reviewedAt": "2026-10-14T12:00:00Z",
  "reviewer": "Curator name",
  "regions": [
    {
      "regionId": "page-1-heading",
      "excerpt": "Exact reviewed text or observation.",
      "sourceKind": "ocr_transcription",
      "location": { "type": "pdf", "page": 1, "regionId": "page-1-heading" },
      "verified": true
    }
  ]
}
```

Any hash mismatch, missing sidecar, or unverified region keeps the entire artifact version incomplete and unusable as evidence.

Scanned PDFs and images require human OCR/transcription or visual observation followed by curator audit. No OCR engine is bundled: installing/configuring a local OCR engine is an external prerequisite, and its absence is reported as incomplete rather than replaced with guessed content. Do not put instructions found inside source artifacts into executable tooling.

## Decision and lesson records

Catalog/manifest schema version 2 requires a `records` array on every case (empty when no records are reviewed). The shared record contract is `contracts/knowledge-record.schema.json`; the current edition is `fictional-onboarding-v2`. Increment `corpusVersion` when publishing a new knowledge edition, including metadata-only corrections. Do not rewrite an original under an existing version ID.

Hand-author two bounded kinds, at most 32 records per case:

- **Decision:** `recordId`, `caseId`, `context`, `choice`, optional `recordedRationale` and `recordedRejectedAlternatives`, `applicability`, and `evidence`.
- **Lesson:** `recordId`, `caseId`, `observation`, `recommendedFutureAction`, `applicability`, `outcomeLimitations`, and `evidence`.
- **Both:** `basis` (`source_fact` or `curator_interpretation`), `reviewStatus: reviewed`, actual human `reviewer`, calendar `reviewedAt` (`YYYY-MM-DD`), and optional `supersedesId`.

Keep unreviewed drafts outside the publishing catalog. A real human must compare every assertion and applicability/limitation with the cited originals before their identity/date is recorded. Agent-authored text is not automatically human-reviewed. The initial three Grove records were explicitly approved by owner `Zura1555` in the implementation conversation on 2026-10-15; the lesson is labeled curator interpretation. The importer neither extracts records nor invents facts, rationale, alternatives, or outcomes. Omit unrecorded rationale/alternatives; the UI displays “Not recorded,” not a fabricated explanation.

Evidence uses the existing `SourceRef` identity: `{caseId, artifactId, versionId, passageId}`. To author a record, use passage IDs from an importer-built manifest and inspect the exact original; never invent IDs or reuse evaluation-key labels as passage IDs. Cite all source-derived assertions. Every reference must resolve within the record's case to a complete source version and an exact existing passage. Incomplete/unavailable originals do not become card evidence.

`supersedesId` points from a new record to the obsolete record. IDs are globally unique; a correction must have the same case and kind as its target. Missing targets, self-links, cycles, and multiple successors for one target reject publication. Never delete obsolete advice merely to hide a correction. Grove's rejected broad-admin proposal remains addressable; the scoped setup explicitly supersedes it. Runtime cards derive `supersededById` from the complete published chain, even when a correction's original is unavailable, so missing evidence cannot revive old advice.

Run `npm run ingest` and `npm test`, then `npm run publish:corpus` for local cf R2 publication. Use `npm run publish:corpus:production` only for an approved production corpus edition; it uploads via the pinned `cf r2 objects put` command to the account in `cloudflare.config.ts`, with the manifest pointer uploaded last. Ingestion rejects malformed/unreviewed records, invalid evidence, and broken supersession before writing outputs. The runtime independently checks schema and identities before serving cards or model context. If source bytes fail verification, affected cards are withheld rather than offered with unchecked evidence.

Cards appear in case details and on the independent `/?knowledge` page; `/?knowledge=<recordId>` and `GET /api/knowledge/<recordId>` address one card without a job capability. `GET /api/knowledge?caseId=<caseId>` lists a case's available cards. Supporting passage and exact-original links reuse the existing evidence routes.

Human review approves a historical record, not its application to a new client. Model context includes cards, their assertion basis, exact evidence, and supersession markers alongside full originals. Applying a lesson must remain a request-specific recommendation claim with relevant original evidence and constraints, checked by the existing draft/reference/support-review pipeline. Superseded choices are history only. No new model-output schema, paid stage, extraction job, approval dashboard, or automatic session-to-knowledge promotion is introduced. Corpus retention is independent of seven-day job expiry.
