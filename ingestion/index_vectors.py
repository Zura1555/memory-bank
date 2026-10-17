#!/usr/bin/env python3
"""Index verified manifest passages in the selected Cloudflare Vectorize index."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from build_manifest import safe_source, sha256_file, validate_catalog, validate_records

ROOT = Path(__file__).resolve().parents[1]
MODEL = "@cf/baai/bge-base-en-v1.5"
DIMENSIONS = 768
MODEL_BATCH_SIZE = 100
UPSERT_BATCH_SIZE = 1000
INDEXES = {
    "development": "memory-bank-search-development",
    "production": "memory-bank-search-production",
}
ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
MAX_EXCERPT_CHARS = 512  # Conservative guard for the model's 512-token input ceiling.


def read_json(path: Path, label: str):
    try:
        return json.loads(path.read_bytes().decode("utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f"cannot read valid UTF-8 {label}: {error}") from error


def load_passages() -> tuple[str, list[dict[str, str]]]:
    manifest_path = ROOT / "corpus/manifest.json"
    manifest_bytes = manifest_path.read_bytes()
    try:
        manifest = json.loads(manifest_bytes.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f"cannot read valid UTF-8 corpus/manifest.json: {error}") from error
    catalog = read_json(ROOT / "corpus/catalog.json", "corpus/catalog.json")
    validate_catalog(catalog, ROOT)
    validate_records(manifest)
    if manifest["schemaVersion"] != catalog["schemaVersion"] or manifest["corpusVersion"] != catalog["corpusVersion"]:
        raise ValueError("manifest and catalog schemaVersion or corpusVersion differ")
    if {case["caseId"]: case["records"] for case in catalog["cases"]} != {case["caseId"]: case["records"] for case in manifest["cases"]}:
        raise ValueError("reviewed records changed; rebuild the manifest before indexing")

    catalog_versions = {}
    for case in catalog["cases"]:
        for artifact in case["artifacts"]:
            for version in artifact["versions"]:
                version_id = version["versionId"]
                if version_id in catalog_versions:
                    raise ValueError(f"duplicate catalog versionId: {version_id}")
                catalog_versions[version_id] = (case["caseId"], artifact["artifactId"], version)

    versions = {}
    for case in manifest["cases"]:
        for artifact in case["artifacts"]:
            for version in artifact["versions"]:
                version_id = version["versionId"]
                if version_id in versions:
                    raise ValueError(f"duplicate manifest versionId: {version_id}")
                versions[version_id] = (case["caseId"], artifact["artifactId"], version)
    if versions.keys() != catalog_versions.keys():
        raise ValueError("manifest and catalog source version IDs differ")

    passages = []
    passage_ids = set()
    for version_id, (case_id, artifact_id, version) in versions.items():
        catalog_case, catalog_artifact, local_version = catalog_versions[version_id]
        if (case_id, artifact_id) != (catalog_case, catalog_artifact):
            raise ValueError(f"manifest and catalog source identities differ: {version_id}")
        source_path = local_version["sourcePath"]
        expected_key = f"corpora/{manifest['corpusVersion']}/{source_path.removeprefix('corpus/')}"
        if version["sourcePath"] != expected_key or version["mimeType"] != local_version["mimeType"]:
            raise ValueError(f"manifest and catalog source metadata differ: {version_id}")
        if version["extractionStatus"] not in {"complete", "incomplete"}:
            raise ValueError(f"invalid extractionStatus: {version_id}")
        if version["extractionStatus"] != "complete":
            continue
        expected_sha = version["sha256"]
        if not isinstance(expected_sha, str) or not re.fullmatch(r"[a-f0-9]{64}", expected_sha):
            raise ValueError(f"invalid manifest SHA-256: {version_id}")
        local_path = safe_source(ROOT, source_path)
        if not local_path.is_file() or sha256_file(local_path) != expected_sha:
            raise ValueError(f"local source is missing or SHA-256 does not match manifest: {version_id}")
        if not isinstance(version["passages"], list):
            raise ValueError(f"invalid manifest passage list: {version_id}")
        for passage in version["passages"]:
            passage_id = passage.get("passageId")
            excerpt = passage.get("excerpt")
            if (not isinstance(passage_id, str) or not ID_PATTERN.fullmatch(passage_id)
                or len(passage_id.encode("utf-8")) > 64 or passage_id in passage_ids
                or not isinstance(excerpt, str) or not excerpt.strip() or len(excerpt) > MAX_EXCERPT_CHARS):
                raise ValueError(f"invalid or duplicate passage identity/excerpt in {version_id}; excerpts must fit the model input limit")
            passage_ids.add(passage_id)
            passages.append({"id": passage_id, "text": excerpt, "caseId": case_id, "mimeType": version["mimeType"]})
    if not passages:
        raise ValueError("the checked manifest has no passages from complete, hash-verified sources")
    return hashlib.sha256(manifest_bytes).hexdigest(), passages


def cf_call(cf: Path, args: list[str], label: str) -> str:
    result = subprocess.run([str(cf), *args], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode:
        details = (result.stderr or result.stdout).strip()
        raise RuntimeError(f"{label} failed (cf exit {result.returncode}): {details or 'no provider details returned'}")
    return result.stdout


def embed(cf: Path, input_path: Path, texts: list[str]) -> list[list[float]]:
    input_path.write_text(json.dumps({"text": texts}, ensure_ascii=False), encoding="utf-8")
    raw = cf_call(cf, ["ai", "run", MODEL, "--body", f"@{input_path}"], "Workers AI embedding")
    try:
        response = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ValueError(f"cf ai run returned invalid JSON: {error}") from error
    result = response.get("result", response) if isinstance(response, dict) else None
    if not isinstance(result, dict):
        raise ValueError("cf ai run response is missing embedding data")
    shape = result.get("shape")
    if (not isinstance(shape, list) or len(shape) != 2
        or any(type(dimension) is not int for dimension in shape)
        or shape != [len(texts), DIMENSIONS]):
        raise ValueError(f"Workers AI embedding shape mismatch: expected [{len(texts)}, {DIMENSIONS}], received {shape!r}")
    vectors = result.get("data")
    if not isinstance(vectors, list) or len(vectors) != len(texts):
        raise ValueError("Workers AI embedding count does not match the input batch")
    for vector in vectors:
        if not isinstance(vector, list) or len(vector) != DIMENSIONS or any(
            type(value) not in (int, float) or not math.isfinite(value) for value in vector
        ):
            raise ValueError(f"Workers AI returned a malformed {DIMENSIONS}-dimension embedding")
    return vectors


def upsert(cf: Path, index: str, namespace: str, path: Path, vectors: list[dict]) -> None:
    with path.open("w", encoding="utf-8") as output:
        for vector in vectors:
            output.write(json.dumps(vector, ensure_ascii=False, separators=(",", ":"), allow_nan=False))
            output.write("\n")
    cf_call(cf, ["vectorize", "upsert", index, "--file", str(path), "--unparsable-behavior", "error"], "Vectorize upsert")


def index(environment: str) -> None:
    namespace, passages = load_passages()
    cf = ROOT / "node_modules/.bin/cf"
    if not cf.is_file():
        raise ValueError("install the pinned cf dependency before indexing")
    target = INDEXES[environment]
    completed = 0
    with tempfile.TemporaryDirectory(prefix="memory-bank-vector-index-") as temporary:
        temp = Path(temporary)
        input_path = temp / "embedding-input.json"
        vector_path = temp / "vectors.ndjson"
        pending = []
        for start in range(0, len(passages), MODEL_BATCH_SIZE):
            batch = passages[start:start + MODEL_BATCH_SIZE]
            vectors = embed(cf, input_path, [passage["text"] for passage in batch])
            pending.extend(
                {
                    "id": passage["id"],
                    "values": vector,
                    "namespace": namespace,
                    "metadata": {"caseId": passage["caseId"], "mimeType": passage["mimeType"]},
                }
                for passage, vector in zip(batch, vectors, strict=True)
            )
            if len(pending) >= UPSERT_BATCH_SIZE:
                upsert(cf, target, namespace, vector_path, pending)
                completed += len(pending)
                pending.clear()
        if pending:
            upsert(cf, target, namespace, vector_path, pending)
            completed += len(pending)
    print(f"Upserted {completed} exact passages into {target} (manifest namespace {namespace}).")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--environment", choices=INDEXES, required=True, help="Select the development or production index")
    args = parser.parse_args()
    try:
        index(args.environment)
    except Exception as error:
        print(f"vector indexing failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
