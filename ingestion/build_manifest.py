#!/usr/bin/env python3
"""Build the runtime corpus manifest from authored and independently source-verified catalog records."""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import importlib
import re
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
MAX_SOURCE = 50 * 1024 * 1024
MAX_MEMBERS = 2000
MAX_MEMBER = 20 * 1024 * 1024
MAX_UNCOMPRESSED = 100 * 1024 * 1024
MAX_CELLS = 100_000


class Incomplete(Exception):
    pass


def safe_source(root: Path, relative: str) -> Path:
    posix = PurePosixPath(relative)
    if posix.is_absolute() or not relative or ".." in posix.parts or "\\" in relative:
        raise ValueError(f"unsafe sourcePath: {relative!r}")
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError(f"sourcePath escapes repository: {relative!r}")
    return path

def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def valid_location(value):
    if not isinstance(value, dict):
        return False
    fields = {
        "text": {"type", "startLine", "endLine"},
        "pdf": {"type", "page", "regionId"},
        "docx": {"type", "section", "paragraph", "table", "row", "column"},
        "pptx": {"type", "slide", "element", "notes"},
        "xlsx": {"type", "worksheet", "cellRange", "headers"},
        "image": {"type", "regionId"},
        "csv": {"type", "row", "columns", "headers"},
    }
    kind = value.get("type")
    if kind not in fields or set(value) != fields[kind]:
        return False
    if kind == "text":
        return all(type(value[k]) is int and value[k] >= 1 for k in ("startLine", "endLine")) and value["endLine"] >= value["startLine"]
    if kind == "pdf":
        return type(value["page"]) is int and value["page"] >= 1 and (value["regionId"] is None or isinstance(value["regionId"], str))
    if kind == "image":
        return isinstance(value["regionId"], str) and bool(value["regionId"])
    if kind == "docx":
        return all(value[k] is None or type(value[k]) is int and value[k] >= 1 for k in ("paragraph", "table", "row", "column")) and (value["section"] is None or isinstance(value["section"], str)) and (value["paragraph"] is not None or value["table"] is not None or value["section"] is not None)
    if kind == "pptx":
        return type(value["slide"]) is int and value["slide"] >= 1 and (value["element"] is None or isinstance(value["element"], str)) and isinstance(value["notes"], bool)
    if kind == "xlsx":
        return isinstance(value["worksheet"], str) and bool(value["worksheet"]) and isinstance(value["cellRange"], str) and bool(value["cellRange"]) and isinstance(value["headers"], list) and all(isinstance(h, str) for h in value["headers"])
    return type(value["row"]) is int and value["row"] >= 1 and isinstance(value["columns"], list) and all(isinstance(v, str) for v in value["columns"]) and isinstance(value["headers"], list) and all(isinstance(v, str) for v in value["headers"])


def zip_members(data: bytes) -> dict[str, bytes]:
    out = {}
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            infos = zf.infolist()
            if len(infos) > MAX_MEMBERS or sum(i.file_size for i in infos) > MAX_UNCOMPRESSED:
                raise Incomplete("archive exceeds member or decompression limit")
            for info in infos:
                p = PurePosixPath(info.filename)
                if p.is_absolute() or ".." in p.parts or info.file_size > MAX_MEMBER:
                    raise Incomplete(f"unsafe or oversized archive member: {info.filename}")
                if info.is_dir():
                    continue
                out[info.filename] = zf.read(info)
    except Incomplete:
        raise
    except Exception as exc:
        raise Incomplete(f"invalid or unreadable ZIP archive: {exc}") from exc
    return out



def text_passages(text: str):
    passages = []
    for line_no, line in enumerate(text.splitlines(), 1):
        if line.strip():
            passages.append((line.strip(), {"type": "text", "startLine": line_no, "endLine": line_no}))
    return passages



def extract(path: Path, data: bytes):
    suffix = path.suffix.lower()
    passages = []
    reasons = []
    if suffix in (".txt", ".md", ".markdown", ".csv"):
        try:
            text = data.decode("utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise Incomplete(f"source is not strict UTF-8: {exc}") from exc
        if suffix == ".csv":
            try:
                rows = list(csv.reader(io.StringIO(text, newline=""), strict=True))
            except csv.Error as exc:
                raise Incomplete(f"invalid CSV: {exc}") from exc
            headers = rows[0] if rows else []
            for rownum, row in enumerate(rows[1:], 2):
                excerpt = " | ".join(f"{headers[i] if i < len(headers) else 'column '+str(i+1)}: {v}" for i, v in enumerate(row))
                if excerpt.strip(" |:"):
                    passages.append((excerpt, {"type": "csv", "row": rownum, "columns": row, "headers": headers}))
        else:
            if suffix in (".md", ".markdown") and re.search(r"!\[|<img\b", text, re.IGNORECASE):
                reasons.append("Markdown embeds image content requiring curator visual audit")
            passages.extend(text_passages(text))
    elif suffix == ".docx":
        members = zip_members(data)
        required = {"word/document.xml"}
        if not required <= members.keys():
            raise Incomplete("DOCX main document is missing")
        # Conservative: only the main document is extracted. Any other content-bearing
        # part makes the entire source unusable until explicitly supported/audited.
        unsupported = [n for n in members if
            (n.startswith("word/") and n not in {
                "word/document.xml", "word/styles.xml", "word/settings.xml", "word/fontTable.xml",
                "word/theme/theme1.xml", "word/webSettings.xml", "word/numbering.xml",
                "word/_rels/document.xml.rels",
            }) or n.startswith("customXml/") or n == "docProps/custom.xml"]
        if unsupported:
            reasons.append("DOCX has unprocessed content parts: " + ", ".join(unsupported[:8]))
        try:
            Document = importlib.import_module("docx").Document
            doc = Document(io.BytesIO(data))
            for i, para in enumerate(doc.paragraphs, 1):
                if para.text.strip():
                    passages.append((para.text, {"type":"docx","section":None,"paragraph":i,"table":None,"row":None,"column":None}))
            for ti, table in enumerate(doc.tables, 1):
                for ri, row in enumerate(table.rows, 1):
                    for ci, cell in enumerate(row.cells, 1):
                        if cell.text.strip():
                            passages.append((cell.text, {"type":"docx","section":None,"paragraph":None,"table":ti,"row":ri,"column":ci}))
        except Exception as exc:
            raise Incomplete(f"DOCX extraction unavailable: {exc}") from exc
    elif suffix == ".pdf":
        try:
            PdfReader = importlib.import_module("pypdf").PdfReader
            reader = PdfReader(io.BytesIO(data), strict=True)
            if reader.is_encrypted:
                raise Incomplete("encrypted PDF cannot be read")
            for page_no, page in enumerate(reader.pages, 1):
                resources = page.get("/Resources") or {}
                if resources.get("/XObject", {}):
                    reasons.append(f"PDF page {page_no} contains images or XObjects requiring audit")
                if page.get("/Annots"):
                    reasons.append(f"PDF page {page_no} contains annotations or form content not represented")
                text = page.extract_text() or ""
                for excerpt, _ in text_passages(text):
                    passages.append((excerpt, {"type":"pdf","page":page_no,"regionId":None}))
                if not text.strip():
                    reasons.append(f"PDF page {page_no} has no native text; local OCR/transcription and audit are required")
        except Incomplete:
            raise
        except Exception as exc:
            raise Incomplete(f"PDF extraction unavailable: {exc}") from exc
    elif suffix == ".pptx":
        members = zip_members(data)
        try:
            Presentation = importlib.import_module("pptx").Presentation
            deck = Presentation(io.BytesIO(data))
            if any(n.startswith(("ppt/media/", "ppt/diagrams/", "ppt/embeddings/")) for n in members):
                reasons.append("presentation contains media, diagrams, or embedded objects requiring curator audit")
            for si, slide in enumerate(deck.slides, 1):
                if slide.has_notes_slide:
                    reasons.append(f"slide {si} has notes not represented by this extractor")
                for ei, shape in enumerate(slide.shapes, 1):
                    if shape.has_text_frame and shape.text.strip():
                        passages.append((shape.text, {"type":"pptx","slide":si,"element":str(ei),"notes":False}))
                    if shape.has_table:
                        for ri, row in enumerate(shape.table.rows, 1):
                            for ci, cell in enumerate(row.cells, 1):
                                if cell.text.strip():
                                    passages.append((cell.text, {"type":"pptx","slide":si,"element":f"{ei}-r{ri}-c{ci}","notes":False}))
                    if shape.shape_type == 6:
                        reasons.append(f"slide {si} contains a group shape with unprocessed children")
                    if shape.shape_type == 13:
                        reasons.append(f"slide {si} contains an image requiring visual/OCR audit")
                    if getattr(shape, "has_chart", False):
                        reasons.append(f"slide {si} contains a chart not represented as source data")
            # Macros are not run; macro-enabled archives are not accepted as PPTX.
            if any(n.endswith("vbaProject.bin") for n in members):
                reasons.append("embedded VBA is inert and not represented")
        except Exception as exc:
            raise Incomplete(f"PPTX extraction unavailable: {exc}") from exc
    elif suffix == ".xlsx":
        members = zip_members(data)
        if any(n.startswith("xl/externalLinks/") for n in members):
            reasons.append("external workbook links are not followed")
        if any(n.endswith("vbaProject.bin") for n in members):
            reasons.append("embedded VBA is inert and not represented")
        if any(n.startswith("xl/drawings/") for n in members):
            reasons.append("workbook drawings/charts require visual audit and are not represented")
        try:
            load_workbook = importlib.import_module("openpyxl").load_workbook
            book = load_workbook(io.BytesIO(data), read_only=True, data_only=False, keep_links=False)
            if getattr(book, "_external_links", []):
                reasons.append("external workbook links are not followed")
            for sheet in book.worksheets:
                if (sheet.max_row or 0) * (sheet.max_column or 0) > MAX_CELLS:
                    reasons.append(f"worksheet {sheet.title} exceeds the cell extraction limit")
                    continue
                for row in sheet.iter_rows():
                    populated = [c for c in row if c.value is not None]
                    if not populated:
                        continue
                    if any(c.data_type == "f" for c in populated):
                        reasons.append(f"worksheet {sheet.title} contains formulas; formula results are not evaluated")
                    first, last = populated[0].coordinate, populated[-1].coordinate
                    headers = [str(c.value) for c in next(sheet.iter_rows(min_row=1, max_row=1), []) if c.value is not None]
                    excerpt = " | ".join(f"{c.coordinate}: {c.value}" for c in populated)
                    passages.append((excerpt, {"type":"xlsx","worksheet":sheet.title,"cellRange":f"{first}:{last}","headers":headers}))
            book.close()
        except Exception as exc:
            raise Incomplete(f"XLSX extraction unavailable: {exc}") from exc
    elif suffix in (".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp", ".bmp", ".gif"):
        try:
            Image = importlib.import_module("PIL.Image")
            with Image.open(io.BytesIO(data)) as image:
                expected = {".png":"PNG", ".jpg":"JPEG", ".jpeg":"JPEG", ".tif":"TIFF", ".tiff":"TIFF", ".webp":"WEBP", ".bmp":"BMP", ".gif":"GIF"}[suffix]
                if image.format != expected:
                    raise Incomplete(f"image extension {suffix} does not match detected {image.format} format")
                image.verify()
        except Exception as exc:
            raise Incomplete(f"image is unreadable: {exc}") from exc
        reasons.append("image content requires curator visual observation/transcription; OCR is not configured")
    else:
        reasons.append(f"unsupported source format: {suffix or 'no extension'}")
    return passages, reasons


def validate_catalog(catalog, root):
    id_pattern = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
    if not isinstance(catalog, dict) or set(catalog) != {"schemaVersion", "corpusVersion", "cases"} or catalog.get("schemaVersion") != 2 or not isinstance(catalog.get("corpusVersion"), str) or not re.fullmatch(r"^[a-z0-9][a-z0-9-]{0,63}$", catalog["corpusVersion"]):
        raise ValueError("invalid catalog identity or schemaVersion")
    cases = catalog.get("cases")
    if not isinstance(cases, list) or len(cases) != 8:
        raise ValueError("catalog must contain exactly 8 cases")
    ids = set()
    for case in cases:
        if not isinstance(case, dict) or set(case) != {"caseId", "title", "fictional", "artifacts", "records"} or not (isinstance(case.get("fictional"), bool) and case["fictional"]) or not isinstance(case.get("caseId"), str) or not id_pattern.fullmatch(case["caseId"]) or case["caseId"] in ids or not isinstance(case.get("title"), str) or not case["title"]:
            raise ValueError("invalid or duplicate case identity; all cases must be fictional")
        ids.add(case["caseId"])
        artifacts = case.get("artifacts")
        if not isinstance(artifacts, list) or not 3 <= len(artifacts) <= 5:
            raise ValueError(f"case {case['caseId']} must contain 3–5 artifacts")
        artifact_ids = set()
        for artifact in artifacts:
            if not isinstance(artifact, dict) or set(artifact) != {"artifactId", "title", "fictional", "versions"} or not (isinstance(artifact.get("fictional"), bool) and artifact["fictional"]) or not isinstance(artifact.get("artifactId"), str) or not id_pattern.fullmatch(artifact["artifactId"]) or artifact["artifactId"] in artifact_ids or not isinstance(artifact.get("title"), str) or not artifact["title"]:
                raise ValueError(f"invalid or duplicate artifact identity in {case['caseId']}")
            artifact_ids.add(artifact["artifactId"])
            versions = artifact.get("versions")
            if not isinstance(versions, list) or not versions:
                raise ValueError(f"artifact {artifact['artifactId']} has no versions")
            version_ids = set()
            for version in versions:
                if (not isinstance(version, dict) or set(version) != {"versionId", "sourcePath", "mimeType", "statedDate"}
                    or not isinstance(version.get("versionId"), str)
                    or not id_pattern.fullmatch(version["versionId"]) or version["versionId"] in version_ids
                    or not isinstance(version.get("sourcePath"), str)
                    or not isinstance(version.get("mimeType"), str) or not re.fullmatch(r"^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$", version["mimeType"])
                    or (version.get("statedDate") is not None and not isinstance(version.get("statedDate"), str))):
                    raise ValueError(f"invalid source identity in artifact {artifact['artifactId']}")
                if not version["sourcePath"].startswith("corpus/originals/"):
                    raise ValueError("sourcePath must be inside corpus/originals")
                safe_source(root, version["sourcePath"])
                version_ids.add(version["versionId"])


def validate_records(manifest):
    """Validate human-reviewed and source-verified records against exact source identities."""
    human_common = {"kind", "recordId", "caseId", "basis", "applicability", "evidence", "reviewStatus", "reviewer", "reviewedAt"}
    agent_common = {"kind", "recordId", "caseId", "basis", "applicability", "evidence", "reviewStatus", "sourceVerifier", "sourceVerifiedAt", "sourceVerificationMethod"}
    fields = {
        "decision": {"context", "choice"},
        "lesson": {"observation", "recommendedFutureAction", "outcomeLimitations"},
        "source_fact": {"assertion"},
    }
    id_pattern = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
    records = {}
    evidence = {
        (case["caseId"], artifact["artifactId"], version["versionId"], passage["passageId"])
        for case in manifest["cases"] for artifact in case["artifacts"]
        for version in artifact["versions"] if version["extractionStatus"] == "complete"
        for passage in version["passages"]
    }
    for case in manifest["cases"]:
        if not isinstance(case["records"], list) or len(case["records"]) > 32:
            raise ValueError("invalid knowledge record list")
        for record in case["records"]:
            if not isinstance(record, dict) or record.get("kind") not in fields:
                raise ValueError("invalid knowledge record kind")
            kind = record["kind"]
            base = agent_common if kind == "source_fact" else human_common
            required = base | fields[kind]
            optional = ({"supersedesId"} if kind != "source_fact" else set()) | ({"recordedRationale", "recordedRejectedAlternatives"} if kind == "decision" else set())
            if not required <= set(record) or set(record) - required - optional:
                raise ValueError("invalid knowledge record fields")
            text_fields = (required - {"evidence"}) | (set(record) & {"recordedRationale", "supersedesId"})
            if any(not isinstance(record[key], str) or not record[key].strip() or len(record[key]) > 4000 for key in text_fields):
                raise ValueError("invalid knowledge record text")
            if (not id_pattern.fullmatch(record["recordId"]) or (kind == "source_fact" and len(record["recordId"]) > 49)
                or record["caseId"] != case["caseId"]):
                raise ValueError("invalid knowledge record identity")
            if record["recordId"] in records:
                raise ValueError("duplicate knowledge record ID")
            if kind == "source_fact":
                if (record["reviewStatus"] != "source_verified" or record["basis"] != "source_fact"
                    or record["sourceVerificationMethod"] != "independent_read_only_agent_review"):
                    raise ValueError("source facts require explicit independent source verification")
                review_date = record["sourceVerifiedAt"]
            else:
                if record["reviewStatus"] != "reviewed" or record["basis"] not in {"source_fact", "curator_interpretation"}:
                    raise ValueError("knowledge records require human review and an explicit assertion basis")
                review_date = record["reviewedAt"]
            try:
                if datetime.strptime(review_date, "%Y-%m-%d").date().isoformat() != review_date:
                    raise ValueError()
            except ValueError as exc:
                raise ValueError("invalid knowledge review date") from exc
            alternatives = record.get("recordedRejectedAlternatives")
            if alternatives is not None and (not isinstance(alternatives, list) or not 1 <= len(alternatives) <= 16 or any(not isinstance(value, str) or not value.strip() or len(value) > 4000 for value in alternatives)):
                raise ValueError("invalid recorded rejected alternatives")
            refs = record["evidence"]
            if not isinstance(refs, list) or not 1 <= len(refs) <= 16:
                raise ValueError("knowledge records require exact evidence")
            for ref in refs:
                if (not isinstance(ref, dict) or set(ref) != {"caseId", "artifactId", "versionId", "passageId"}
                    or any(not isinstance(value, str) or not id_pattern.fullmatch(value) for value in ref.values())
                    or ref["caseId"] != case["caseId"]
                    or (ref["caseId"], ref["artifactId"], ref["versionId"], ref["passageId"]) not in evidence):
                    raise ValueError("invalid knowledge evidence identity or incomplete source")
            records[record["recordId"]] = record
    superseded = set()
    for record in records.values():
        target_id = record.get("supersedesId")
        if target_id is None:
            continue
        target = records.get(target_id)
        if not target or target["caseId"] != record["caseId"] or target["kind"] != record["kind"] or target_id in superseded:
            raise ValueError("invalid or ambiguous knowledge supersession link")
        superseded.add(target_id)
        seen = {record["recordId"]}
        while target:
            if target["recordId"] in seen:
                raise ValueError("knowledge supersession cycle")
            seen.add(target["recordId"])
            target = records.get(target.get("supersedesId"))

def build(catalog_path: Path, root: Path):
    try:
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot read valid UTF-8 catalog JSON: {exc}") from exc
    validate_catalog(catalog, root)
    manifest = {"schemaVersion": 2, "corpusVersion": catalog["corpusVersion"], "cases": []}
    audit = {"corpusVersion":catalog["corpusVersion"],"generatedAt":datetime.now(timezone.utc).isoformat(),"sources":[]}
    seen_versions = set()
    for case in catalog["cases"]:
        out_case = {k:case[k] for k in ("caseId","title")}
        out_case["fictional"] = True
        out_case["records"] = case["records"]
        out_case["artifacts"] = []
        for artifact in case["artifacts"]:
            out_artifact = {k:artifact[k] for k in ("artifactId","title")}
            out_artifact["fictional"] = True
            out_artifact["versions"] = []
            for version in artifact["versions"]:
                vid = version.get("versionId")
                rel = version.get("sourcePath")
                if not vid or vid in seen_versions or not isinstance(rel, str):
                    raise ValueError(f"invalid or duplicate version identity for {artifact['artifactId']}")
                seen_versions.add(vid)
                path = safe_source(root, rel)
                mime = version.get("mimeType")
                stated_date = version.get("statedDate")
                if not path.is_file():
                    raise ValueError(f"source file does not exist or is not a regular file: {rel}")
                reasons, passages, data, sha = [], [], b"", None
                try:
                    size = path.stat().st_size
                    if size > MAX_SOURCE:
                        sha = sha256_file(path)
                        raise Incomplete("source exceeds size limit")
                    data = path.read_bytes()
                    sha = hashlib.sha256(data).hexdigest()
                    extracted, reasons = extract(path, data)
                    passages = extracted
                except OSError as exc:
                    raise ValueError(f"cannot read source bytes for exact SHA-256: {rel}: {exc}") from exc
                except Incomplete as exc:
                    reasons = [str(exc)]
                if sha is None:
                    raise ValueError(f"cannot compute source SHA-256: {rel}")
                sidecar_path = safe_source(root, rel + ".audit.json")
                audited = None
                if sidecar_path.is_file():
                    try:
                        audited = json.loads(sidecar_path.read_text(encoding="utf-8"))
                    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
                        reasons.append(f"cannot read curator sidecar: {exc}")
                passage_kinds = ["native"] * len(passages)
                if audited is not None:
                    if (not isinstance(audited, dict) or set(audited) != {"sourceSha256", "reviewedAt", "reviewer", "regions"}
                        or audited.get("sourceSha256") != sha
                        or not isinstance(audited.get("reviewer"), str) or not audited["reviewer"].strip()
                        or not isinstance(audited.get("reviewedAt"), str)
                        or not isinstance(audited.get("regions"), list)):
                        reasons.append("curator sidecar is invalid or bound to a different source SHA-256")
                    else:
                        additions = []
                        try:
                            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})", audited["reviewedAt"]):
                                raise ValueError("reviewedAt must be an ISO date-time with timezone")
                            reviewed_at = datetime.fromisoformat(audited["reviewedAt"].replace("Z", "+00:00"))
                            if reviewed_at.tzinfo is None:
                                raise ValueError("reviewedAt requires timezone")
                            region_ids = set()
                            for item in audited["regions"]:
                                if not isinstance(item, dict) or set(item) != {"regionId", "excerpt", "sourceKind", "location", "verified"}:
                                    raise ValueError("invalid region entry")
                                kind, location = item["sourceKind"], item["location"]
                                region_id = item["regionId"]
                                if (not (isinstance(item.get("verified"), bool) and item["verified"]) or not isinstance(region_id, str)
                                    or not region_id or region_id in region_ids
                                    or not isinstance(item.get("excerpt"), str) or not item["excerpt"].strip()
                                    or kind not in {"ocr_transcription", "visual_observation", "visual_interpretation"}
                                    or not valid_location(location)
                                    or (location.get("type") in {"image", "pdf"} and location.get("regionId") != region_id)):
                                    raise ValueError("unverified or invalid region")
                                region_ids.add(region_id)
                                additions.append((item["excerpt"], kind, location))
                            if not additions:
                                raise ValueError("no reviewed regions")
                        except (KeyError, TypeError, ValueError):
                            reasons.append("curator sidecar contains an invalid or unverified region")
                        else:
                            passages.extend((excerpt, location) for excerpt, _, location in additions)
                            passage_kinds.extend(kind for _, kind, _ in additions)
                            reasons = []
                status = "complete" if data and not reasons else "incomplete"
                out_version = {"versionId":vid,"sourcePath":f"corpora/{catalog['corpusVersion']}/{rel.removeprefix('corpus/')}","mimeType":mime,"sha256":sha,"statedDate":stated_date,"importedAt":datetime.now(timezone.utc).isoformat(),"extractionStatus":status,"exclusionReasons":reasons,"passages":[]}
                if status == "complete":
                    passage_occurrences = {}
                    for i, (excerpt, location) in enumerate(passages):
                        if excerpt.strip():
                            source_kind = passage_kinds[i]
                            identity = json.dumps([vid, sha, excerpt, source_kind, location], ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                            occurrence = passage_occurrences.get(identity, 0) + 1
                            passage_occurrences[identity] = occurrence
                            passage_id = f"p-{hashlib.sha256(f'{identity}:{occurrence}'.encode('utf-8')).hexdigest()[:32]}"
                            out_version["passages"].append({"passageId":passage_id,"excerpt":excerpt,"sourceKind":source_kind,"location":location})
                audit["sources"].append({"versionId":vid,"sourcePath":rel,"sha256":sha,"extractionStatus":status,"reasons":reasons,"curatorAudit":audited})
                out_artifact["versions"].append(out_version)
            out_case["artifacts"].append(out_artifact)
        manifest["cases"].append(out_case)
    validate_records(manifest)
    return manifest, audit


def main():
    parser = argparse.ArgumentParser(description="Offline curator corpus importer and manifest builder")
    parser.add_argument("--root", type=Path, default=ROOT, help="repository root (default: detected from this script)")
    parser.add_argument("--catalog", type=Path, help="catalog path (default: <root>/corpus/catalog.json)")
    parser.add_argument("--manifest", type=Path, help="output manifest (default: <root>/corpus/manifest.json)")
    args = parser.parse_args()
    root = args.root.resolve()
    catalog_path = args.catalog or Path("corpus/catalog.json")
    manifest_path = args.manifest or Path("corpus/manifest.json")
    catalog_path = catalog_path if catalog_path.is_absolute() else root / catalog_path
    manifest_path = manifest_path if manifest_path.is_absolute() else root / manifest_path
    audit_path = root / "ingestion/audit.json"
    try:
        manifest, audit = build(catalog_path, root)
        if manifest_path.is_file():
            previous = json.loads(manifest_path.read_text(encoding="utf-8"))
            previous_sha = {
                version["versionId"]: version["sha256"]
                for case in previous["cases"]
                for artifact in case["artifacts"]
                for version in artifact["versions"]
            }
            current_sha = {
                version["versionId"]: version["sha256"]
                for case in manifest["cases"]
                for artifact in case["artifacts"]
                for version in artifact["versions"]
            }
            if any(previous_sha.get(version_id) != source_sha for version_id, source_sha in current_sha.items() if version_id in previous_sha):
                raise ValueError("source bytes changed under an existing versionId; assign a new source version")
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        audit_path.parent.mkdir(parents=True, exist_ok=True)
        audit_path.write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except Exception as exc:
        print(f"ingestion failed: {exc}", file=sys.stderr)
        return 1
    print(f"Wrote {manifest_path} and curator audit {audit_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
