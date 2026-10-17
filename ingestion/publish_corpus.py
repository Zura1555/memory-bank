#!/usr/bin/env python3
"""Publish the checked corpus to cf local R2, or production with --production."""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from build_manifest import validate_catalog, validate_records

ROOT = Path(__file__).resolve().parents[1]
BUCKET = "memory-bank-originals"


def publish(*, production: bool = False) -> None:
    manifest_path = ROOT / "corpus/manifest.json"
    catalog_path = ROOT / "corpus/catalog.json"
    cf = ROOT / "node_modules/.bin/cf"
    if not manifest_path.is_file() or not cf.is_file():
        raise ValueError("build corpus/manifest.json and install the pinned cf dependency first")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    validate_catalog(catalog, ROOT)
    validate_records(manifest)
    if manifest["schemaVersion"] != catalog["schemaVersion"]:
        raise ValueError("manifest and catalog schemaVersion values differ")
    if {case["caseId"]: case["records"] for case in catalog["cases"]} != {case["caseId"]: case["records"] for case in manifest["cases"]}:
        raise ValueError("reviewed records changed; rebuild the manifest before publishing")
    if catalog["corpusVersion"] != manifest["corpusVersion"]:
        raise ValueError("manifest and source catalog corpusVersion values differ")
    originals_root = (ROOT / "corpus/originals").resolve()
    manifest_versions = {
        version["versionId"]: version
        for case in manifest["cases"]
        for artifact in case["artifacts"]
        for version in artifact["versions"]
    }
    uploaded = 0
    for case in catalog["cases"]:
        for artifact in case["artifacts"]:
            for local_version in artifact["versions"]:
                version = manifest_versions[local_version["versionId"]]
                local_path = (ROOT / local_version["sourcePath"]).resolve()
                suffix = local_version["sourcePath"].removeprefix("corpus/originals/")
                r2_key = f"corpora/{manifest['corpusVersion']}/originals/{suffix}"
                if not local_path.is_relative_to(originals_root) or not local_path.is_file() or version["sourcePath"] != r2_key:
                    raise ValueError(f"source-to-versioned-R2 mapping is unsafe or inconsistent: {local_version['versionId']}")
                subprocess.run(
                    [str(cf), "r2", "objects", "put", r2_key, "--bucket-name", BUCKET, "--file", str(local_path), "--content-type", local_version["mimeType"], *([] if production else ["--local", "--persist-to", str(ROOT / ".cloudflare/state")])],
                    cwd=ROOT,
                    check=True,
                )
                uploaded += 1
    subprocess.run(
        [str(cf), "r2", "objects", "put", "corpus/manifest.json", "--bucket-name", BUCKET, "--file", str(manifest_path), "--content-type", "application/json", *([] if production else ["--local", "--persist-to", str(ROOT / ".cloudflare/state")])],
        cwd=ROOT,
        check=True,
    )
    print(f"Published {uploaded} exact originals and corpus/manifest.json to {'production' if production else 'local'} cf R2.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--production", action="store_true", help="Upload to remote production R2 instead of the local simulation.")
    args = parser.parse_args()
    try:
        publish(production=args.production)
    except Exception as error:
        print(f"corpus publication failed: {error}", file=sys.stderr)
        raise SystemExit(1)
