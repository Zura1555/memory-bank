import copy
import json
import unittest
from pathlib import Path

from build_manifest import build, validate_records


class KnowledgePublishingTest(unittest.TestCase):
    def test_rejects_unreviewed_untraceable_or_ambiguous_knowledge(self):
        root = Path(__file__).resolve().parents[1]
        manifest, _ = build(root / "corpus/catalog.json", root)
        grove_index = next(i for i, case in enumerate(manifest["cases"]) if case["caseId"] == "grove-scoped-access")
        mutations = {
            "duplicate ID": lambda records: records.append(copy.deepcopy(records[0])),
            "unknown evidence case": lambda records: records[0]["evidence"][0].update(caseId="missing"),
            "wrong evidence artifact": lambda records: records[0]["evidence"][0].update(artifactId="request"),
            "wrong evidence version": lambda records: records[0]["evidence"][0].update(versionId="request-2025-01-14"),
            "missing evidence passage": lambda records: records[0]["evidence"][0].update(passageId="missing"),
            "missing superseded ID": lambda records: records[1].update(supersedesId="missing"),
            "different record kind": lambda records: records[2].update(supersedesId=records[0]["recordId"]),
            "cycle": lambda records: records[0].update(supersedesId=records[1]["recordId"]),
            "self-cycle": lambda records: records[0].update(supersedesId=records[0]["recordId"]),
            "ambiguous successors": lambda records: records.append({**copy.deepcopy(records[1]), "recordId": "another-correction"}),
            "unreviewed": lambda records: records[0].update(reviewStatus="draft"),
            "missing reviewer": lambda records: records[0].pop("reviewer"),
            "blank reviewer": lambda records: records[0].update(reviewer="  "),
            "invalid date": lambda records: records[0].update(reviewedAt="2026-02-30"),
            "unknown field": lambda records: records[0].update(inferredOutcome="success"),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                candidate = copy.deepcopy(manifest)
                mutate(candidate["cases"][grove_index]["records"])
                with self.assertRaises(ValueError):
                    validate_records(candidate)
        incomplete = copy.deepcopy(manifest)
        incomplete["cases"][grove_index]["artifacts"][1]["versions"][0]["extractionStatus"] = "incomplete"
        with self.assertRaisesRegex(ValueError, "incomplete source"):
            validate_records(incomplete)


    def test_source_history_records_require_agent_verification_and_exact_evidence(self):
        root = Path(__file__).resolve().parents[1]
        manifest, _ = build(root / "corpus/catalog.json", root)
        records = {
            record["recordId"]: record
            for case in manifest["cases"] for record in case["records"]
            if record["kind"] == "source_fact"
        }
        self.assertEqual(set(records), {
            "elm-batch-count-discrepancy",
            "elm-sandbox-limitations",
            "ibis-recovery-correction-history",
        })
        expected_evidence = {
            "elm-batch-count-discrepancy": [
                ("elm-bulk-integration", "delivery-log", "notes-2025-04-17", "p-f0307a32de54738459c000dce90f00a3"),
                ("elm-bulk-integration", "delivery-log", "notes-2025-04-17", "p-f8671693077604825e9d0089517cb7e1"),
            ],
            "elm-sandbox-limitations": [
                ("elm-bulk-integration", "delivery-log", "notes-2025-04-17", "p-21debbf5cf36d783aed25c67591aa425"),
                ("elm-bulk-integration", "delivery-log", "notes-2025-04-17", "p-f8671693077604825e9d0089517cb7e1"),
                ("elm-bulk-integration", "delivery-log", "notes-2025-04-17", "p-d686a3f998ca265836120c01fdb30eb2"),
                ("elm-bulk-integration", "batch-adapter-notes", "adapter-2025-04-11", "p-03a4c5b29fe0071b33bc51422c10c0f2"),
            ],
            "ibis-recovery-correction-history": [
                ("ibis-verified-handover", "delivery-log", "notes-2025-05-23", "p-dfd36ef4bb4b2aff13569f7e84b7b0d5"),
                ("ibis-verified-handover", "delivery-log", "notes-2025-05-23", "p-be10ef47b2b36387937fc281e1874201"),
                ("ibis-verified-handover", "delivery-log", "notes-2025-05-23", "p-18356d39c827604af801be2658c16ea3"),
                ("ibis-verified-handover", "operator-runbook", "runbook-2025-05-21", "p-f1ee09d99d16cc6f2f3fd50ad47b58be"),
                ("ibis-verified-handover", "operator-runbook", "runbook-2025-05-21", "p-6e6e4258f362813425bc3cdf99f6b378"),
            ],
        }
        for record_id, expected in expected_evidence.items():
            self.assertEqual([
                (ref["caseId"], ref["artifactId"], ref["versionId"], ref["passageId"])
                for ref in records[record_id]["evidence"]
            ], expected)
        mutations = {
            "missing agent verifier": lambda record: record.pop("sourceVerifier"),
            "blank verifier": lambda record: record.update(sourceVerifier="  "),
            "wrong status": lambda record: record.update(reviewStatus="reviewed", reviewer="invented", reviewedAt="2026-10-18"),
            "wrong method": lambda record: record.update(sourceVerificationMethod="human_curator_review"),
            "invalid source date": lambda record: record.update(sourceVerifiedAt="2026-02-30"),
            "wrong basis": lambda record: record.update(basis="curator_interpretation"),
            "invented human reviewer": lambda record: record.update(reviewer="invented"),
            "human supersession": lambda record: record.update(supersedesId="old-record"),
            "oversized generated ID": lambda record: record.update(recordId="a" * 50),
            "missing passage": lambda record: record["evidence"][0].update(passageId="missing"),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                candidate = copy.deepcopy(manifest)
                target = next(record for case in candidate["cases"] for record in case["records"] if record["kind"] == "source_fact")
                mutate(target)
                with self.assertRaises(ValueError):
                    validate_records(candidate)

    def test_metadata_only_edition_preserves_source_and_passage_identities(self):
        root = Path(__file__).resolve().parents[1]
        built, _ = build(root / "corpus/catalog.json", root)
        published = json.loads((root / "corpus/manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(built["corpusVersion"], "fictional-onboarding-v3")
        self.assertEqual(published["corpusVersion"], built["corpusVersion"])

        def identities(manifest):
            return {
                version["versionId"]: (version["sha256"], tuple(passage["passageId"] for passage in version["passages"]))
                for case in manifest["cases"] for artifact in case["artifacts"] for version in artifact["versions"]
            }

        self.assertEqual(identities(published), identities(built))
        self.assertTrue(all(
            version["sourcePath"].startswith("corpora/fictional-onboarding-v3/originals/")
            for case in published["cases"] for artifact in case["artifacts"] for version in artifact["versions"]
        ))
        built_records = {record["recordId"]: record for case in built["cases"] for record in case["records"]}
        published_records = {record["recordId"]: record for case in published["cases"] for record in case["records"]}
        self.assertEqual(published_records, built_records)


if __name__ == "__main__":
    unittest.main()
