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
