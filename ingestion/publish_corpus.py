#!/usr/bin/env python3
"""Publish the generated manifest and retained originals to Wrangler's local R2 only."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUCKET = "memory-bank-originals"


def publish() -> None:
    manifest_path = ROOT / "corpus/manifest.json"
    catalog_path = ROOT / "corpus/catalog.json"
    wrangler = ROOT / "node_modules/.bin/wrangler"
    if not manifest_path.is_file() or not wrangler.is_file():
        raise ValueError("build corpus/manifest.json and install the pinned Wrangler dependency first")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
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
                    [str(wrangler), "r2", "object", "put", f"{BUCKET}/{r2_key}", "--file", str(local_path), "--local", "--content-type", local_version["mimeType"]],
                    cwd=ROOT,
                    check=True,
                )
                uploaded += 1
    subprocess.run(
        [str(wrangler), "r2", "object", "put", f"{BUCKET}/corpus/manifest.json", "--file", str(manifest_path), "--local", "--content-type", "application/json"],
        cwd=ROOT,
        check=True,
    )
    print(f"Published {uploaded} exact originals and corpus/manifest.json to local Wrangler R2.")


if __name__ == "__main__":
    try:
        publish()
    except Exception as error:
        print(f"corpus publication failed: {error}", file=sys.stderr)
        raise SystemExit(1)
