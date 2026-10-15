import copy
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


if __name__ == "__main__":
    unittest.main()
