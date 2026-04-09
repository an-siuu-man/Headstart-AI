"""
Artifact: agent_service/app/services/pdf_extraction_service.py
Purpose: Build structured PDF extractions using a Docling-first, OCR-enabled pipeline.
Author: Codex
Created: 2026-04-04
"""

from __future__ import annotations

import io
import json
import re
from collections import defaultdict
from functools import lru_cache
from typing import Any, Iterable, Optional

from ..core.logging import get_logger
from ..schemas.requests import RunAgentRequest
from ..schemas.shared import (
    PdfExtraction,
    PdfExtractionQuality,
    PdfPageExtraction,
    PdfTextBlock,
    PdfTextStyle,
    PdfVisualSignal,
)
from .pdf_text_service import (
    MAX_VISUAL_SIGNALS_PER_FILE,
    _build_signal,
    _merge_text_variants,
    _merge_visual_signals,
    _normalize_page_text,
    _score_text_quality,
    _text_token_overlap_ratio,
    _decode_pdf_base64,
    _download_pdf_from_storage_url,
    extract_pdf_context_from_pdf_bytes,
    format_attachment_block,
)

logger = get_logger("headstart.main")

PAGE_HEADER_RE = re.compile(r"^--- Page (\d+) \(([^)]+)\) ---$")
MIN_DOCLING_TEXT_LEN = 2


def _obj_to_dict(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    if isinstance(value, dict):
        return value
    if hasattr(value, "model_dump"):
        try:
            dumped = value.model_dump()
            if isinstance(dumped, dict):
                return dumped
        except Exception:
            return {}
    return {}


def _iter_dict_nodes(value: Any) -> Iterable[dict[str, Any]]:
    if isinstance(value, dict):
        yield value
        for item in value.values():
            yield from _iter_dict_nodes(item)
    elif isinstance(value, list):
        for item in value:
            yield from _iter_dict_nodes(item)


def _dedupe_lines(lines: Iterable[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for line in lines:
        clean = _normalize_page_text(line)
        if not clean:
            continue
        key = re.sub(r"\s+", " ", clean.lower()).strip()
        if key in seen:
            continue
        seen.add(key)
        out.append(clean)
    return out


def _parse_native_page_sections(native_text: str) -> list[tuple[int, str, str]]:
    pages: list[tuple[int, str, str]] = []
    current_page = 0
    current_method = "native"
    current_lines: list[str] = []

    for raw in (native_text or "").splitlines():
        line = raw.strip()
        match = PAGE_HEADER_RE.match(line)
        if match:
            if current_page > 0:
                pages.append(
                    (
                        current_page,
                        current_method,
                        _normalize_page_text("\n".join(current_lines)),
                    )
                )
            current_page = int(match.group(1))
            current_method = match.group(2)
            current_lines = []
            continue
        current_lines.append(raw)

    if current_page > 0:
        pages.append(
            (
                current_page,
                current_method,
                _normalize_page_text("\n".join(current_lines)),
            )
        )
    return pages


def _extract_docling_page_number(node: dict[str, Any]) -> int:
    prov = node.get("prov")
    if isinstance(prov, list) and prov:
        first = _obj_to_dict(prov[0])
        for key in ("page_no", "page", "page_number", "page_num"):
            raw = first.get(key)
            if isinstance(raw, int) and raw > 0:
                return raw
            if isinstance(raw, str) and raw.isdigit():
                return int(raw)

    for key in ("page_no", "page", "page_number", "page_num"):
        raw = node.get(key)
        if isinstance(raw, int) and raw > 0:
            return raw
        if isinstance(raw, str) and raw.isdigit():
            return int(raw)

    return 1


def _extract_docling_bbox(node: dict[str, Any]) -> Optional[list[float]]:
    prov = node.get("prov")
    if isinstance(prov, list) and prov:
        first = _obj_to_dict(prov[0])
        bbox = first.get("bbox")
        if isinstance(bbox, list) and len(bbox) >= 4:
            try:
                return [float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])]
            except Exception:
                return None
        if isinstance(bbox, dict):
            keys = ("l", "t", "r", "b")
            if all(k in bbox for k in keys):
                try:
                    return [float(bbox["l"]), float(bbox["t"]), float(bbox["r"]), float(bbox["b"])]
                except Exception:
                    return None
    return None


def _extract_docling_formatting(node: dict[str, Any]) -> Optional[PdfTextStyle]:
    raw_fmt = node.get("formatting")
    fmt = _obj_to_dict(raw_fmt)
    if not fmt and raw_fmt is not None and hasattr(raw_fmt, "__dict__"):
        try:
            fmt = dict(raw_fmt.__dict__)
        except Exception:
            fmt = {}

    if not fmt:
        return None

    def _flag(*keys: str) -> bool:
        for key in keys:
            value = fmt.get(key)
            if isinstance(value, bool):
                if value:
                    return True
            elif isinstance(value, (int, float)) and value != 0:
                return True
        return False

    style = PdfTextStyle(
        bold=_flag("bold", "is_bold"),
        italic=_flag("italic", "is_italic"),
        underline=_flag("underline", "is_underline"),
        strikethrough=_flag("strikethrough", "strike", "is_strikethrough"),
    )
    if not (style.bold or style.italic or style.underline or style.strikethrough):
        return None
    return style


def _extract_docling_text(node: dict[str, Any]) -> str:
    for key in ("text", "orig"):
        value = node.get(key)
        if isinstance(value, str):
            text = _normalize_page_text(value)
            if len(text) >= MIN_DOCLING_TEXT_LEN:
                return text
    return ""


def _extract_docling_blocks_and_signals(
    doc_json: dict[str, Any],
    filename: str,
) -> tuple[list[PdfTextBlock], list[dict], dict[int, str]]:
    blocks: list[PdfTextBlock] = []
    signals: list[dict] = []
    page_lines: dict[int, list[str]] = defaultdict(list)
    seen: set[tuple[int, str]] = set()
    reading_order = 0

    for node in _iter_dict_nodes(doc_json):
        text = _extract_docling_text(node)
        if not text:
            continue

        page = _extract_docling_page_number(node)
        dedupe_key = (page, re.sub(r"\s+", " ", text.lower()).strip())
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)

        style = _extract_docling_formatting(node)
        bbox = _extract_docling_bbox(node)
        reading_order += 1

        block = PdfTextBlock(
            block_id=str(node.get("self_ref") or f"docling-{page}-{reading_order}"),
            text=text,
            role=str(node.get("label") or "text"),
            page_number=page,
            source="docling",
            reading_order=reading_order,
            confidence=1.0,
            bbox=bbox,
            formatting=style,
        )
        blocks.append(block)
        page_lines[page].append(text)

        signal_types: list[str] = []
        if style and style.bold:
            signal_types.append("bold")
        if style and style.underline:
            signal_types.append("underline")
        if style and style.strikethrough:
            signal_types.append("strikeout")
        if signal_types:
            signal = _build_signal(
                filename=filename,
                page_number=page,
                text=text,
                signal_types=signal_types,
                source="docling_style",
            )
            if signal:
                signals.append(signal)

    collapsed_pages = {
        page: "\n".join(_dedupe_lines(lines)) for page, lines in page_lines.items()
    }
    return blocks, signals, collapsed_pages


@lru_cache(maxsize=1)
def _build_docling_converter() -> tuple[Any, list[str]]:
    notes: list[str] = []
    try:
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import (
            PdfPipelineOptions,
            TableStructureOptions,
            TesseractCliOcrOptions,
        )
        from docling.document_converter import DocumentConverter, PdfFormatOption
    except ImportError as exc:
        raise RuntimeError("docling_not_installed") from exc

    pipeline_options = PdfPipelineOptions()
    pipeline_options.do_ocr = True
    pipeline_options.do_table_structure = True
    notes.append("docling_ocr=enabled")

    try:
        pipeline_options.table_structure_options = TableStructureOptions(do_cell_matching=True)
        notes.append("table_structure=enabled")
    except Exception:
        notes.append("table_structure=default")

    try:
        from docling.datamodel.pipeline_options import TableFormerMode

        pipeline_options.table_structure_options.mode = TableFormerMode.ACCURATE
        notes.append("tableformer=accurate")
    except Exception:
        notes.append("tableformer=default")

    try:
        ocr_options = TesseractCliOcrOptions(force_full_page_ocr=False)
        pipeline_options.ocr_options = ocr_options
        notes.append("ocr_backend=tesseract_cli")
    except Exception:
        notes.append("ocr_backend=default")

    converter = DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options),
        }
    )
    return converter, notes


def _extract_with_docling(pdf_bytes: bytes, filename: str) -> tuple[str, list[PdfTextBlock], list[dict], dict[int, str], bool, list[str]]:
    try:
        converter, notes = _build_docling_converter()
    except RuntimeError:
        return "", [], [], {}, False, ["docling_unavailable"]

    try:
        from docling.datamodel.base_models import DocumentStream

        source = DocumentStream(name=filename, stream=io.BytesIO(pdf_bytes))
        result = converter.convert(source)
        document = getattr(result, "document", None)
        if document is None:
            raise RuntimeError("docling returned no document")

        markdown = ""
        if hasattr(document, "export_to_markdown"):
            markdown = _normalize_page_text(document.export_to_markdown() or "")

        doc_json: dict[str, Any] = {}
        if hasattr(document, "export_to_dict"):
            exported = document.export_to_dict()
            if isinstance(exported, dict):
                doc_json = exported
        elif hasattr(document, "model_dump"):
            dumped = document.model_dump()
            if isinstance(dumped, dict):
                doc_json = dumped
        elif hasattr(document, "export_to_json"):
            raw = document.export_to_json()
            if isinstance(raw, str) and raw.strip():
                parsed = json.loads(raw)
                if isinstance(parsed, dict):
                    doc_json = parsed

        blocks, signals, page_map = _extract_docling_blocks_and_signals(doc_json, filename)
        if not blocks and markdown:
            blocks = [
                PdfTextBlock(
                    block_id=f"docling-{filename}-root",
                    text=markdown,
                    role="document",
                    page_number=1,
                    source="docling",
                    reading_order=1,
                    confidence=1.0,
                )
            ]
            page_map = {1: markdown}

        return markdown, blocks, signals, page_map, True, notes
    except Exception as exc:
        logger.warning("Docling extraction failed for %r: %s", filename, exc)
        return "", [], [], {}, False, ["docling_failed"]


def _reconcile_full_text(docling_text: str, native_text: str) -> str:
    if docling_text and native_text:
        overlap = _text_token_overlap_ratio(docling_text, native_text)
        if overlap < 0.65:
            return _merge_text_variants(docling_text, native_text)

        docling_score = _score_text_quality(docling_text)
        native_score = _score_text_quality(native_text)
        if docling_score >= native_score - 0.02:
            return docling_text
        return _merge_text_variants(native_text, docling_text)
    return docling_text or native_text


def _to_visual_signal_models(signals: list[dict]) -> list[PdfVisualSignal]:
    out: list[PdfVisualSignal] = []
    for sig in signals:
        try:
            out.append(PdfVisualSignal.model_validate(sig))
        except Exception:
            continue
    return out


def _to_page_models(
    docling_blocks: list[PdfTextBlock],
    docling_pages: dict[int, str],
    native_pages: list[tuple[int, str, str]],
) -> list[PdfPageExtraction]:
    pages: list[PdfPageExtraction] = []
    docling_blocks_by_page: dict[int, list[PdfTextBlock]] = defaultdict(list)
    for block in docling_blocks:
        docling_blocks_by_page[int(block.page_number)].append(block)

    page_numbers = sorted(set(docling_pages.keys()) | {p[0] for p in native_pages})
    for page_number in page_numbers:
        docling_text = _normalize_page_text(docling_pages.get(page_number, ""))
        native_entry = next((p for p in native_pages if p[0] == page_number), None)
        native_text = _normalize_page_text(native_entry[2] if native_entry else "")
        page_text = _reconcile_full_text(docling_text, native_text)
        method = "docling+native_verify" if docling_text and native_text else ("docling" if docling_text else (native_entry[1] if native_entry else "native"))

        pages.append(
            PdfPageExtraction(
                page_number=page_number,
                text=page_text,
                method=method,
                blocks=docling_blocks_by_page.get(page_number, []),
                confidence=max(_score_text_quality(page_text), 0.0),
            )
        )

    if pages:
        return pages

    # Last-resort fallback for malformed documents with no page segmentation.
    if docling_blocks:
        text = _normalize_page_text("\n".join(block.text for block in docling_blocks))
        return [
            PdfPageExtraction(
                page_number=1,
                text=text,
                method="docling",
                blocks=docling_blocks,
                confidence=max(_score_text_quality(text), 0.0),
            )
        ]

    return []


def extract_pdf_extraction_from_pdf_bytes(
    pdf_bytes: bytes,
    filename: str,
    source: str = "assignment",
    file_sha256: Optional[str] = None,
) -> PdfExtraction:
    docling_text, docling_blocks, docling_signals, docling_pages, docling_ok, docling_notes = _extract_with_docling(
        pdf_bytes, filename
    )

    native_structured_text, native_signals = extract_pdf_context_from_pdf_bytes(pdf_bytes, filename)
    native_pages = _parse_native_page_sections(native_structured_text)
    native_plain_text = _normalize_page_text(
        "\n\n".join(page_text for _, _, page_text in native_pages)
    )
    full_text = _reconcile_full_text(docling_text, native_plain_text)

    all_signals = _merge_visual_signals(
        [*native_signals, *docling_signals],
        limit=MAX_VISUAL_SIGNALS_PER_FILE,
    )
    pages = _to_page_models(docling_blocks, docling_pages, native_pages)
    if not pages and full_text:
        pages = [
            PdfPageExtraction(
                page_number=1,
                text=full_text,
                method="docling" if docling_ok else "native",
                blocks=docling_blocks,
                confidence=max(_score_text_quality(full_text), 0.0),
            )
        ]

    quality = PdfExtractionQuality(
        strategy="docling_dual_pass_verify",
        docling_available=docling_ok,
        native_chars=len(native_plain_text),
        docling_chars=len(docling_text),
        reconciled_chars=len(full_text),
        notes=docling_notes,
    )

    return PdfExtraction(
        filename=filename,
        source="user_upload" if source == "user_upload" else "assignment",
        file_sha256=file_sha256,
        full_text=full_text,
        pages=pages,
        visual_signals=_to_visual_signal_models(all_signals),
        quality=quality,
    )


def _load_pdf_bytes(pdf_file: Any) -> Optional[bytes]:
    pdf_bytes = None
    storage_url = getattr(pdf_file, "storage_url", None)
    if storage_url:
        pdf_bytes = _download_pdf_from_storage_url(storage_url, getattr(pdf_file, "filename", "unknown.pdf"))

    if pdf_bytes is None:
        base64_data = getattr(pdf_file, "base64_data", None)
        if base64_data:
            try:
                pdf_bytes = _decode_pdf_base64(base64_data)
            except Exception:
                return None
    return pdf_bytes


def extract_pdf_extractions_with_file_map(
    req: RunAgentRequest,
) -> tuple[list[PdfExtraction], dict[str, PdfExtraction]]:
    extractions: list[PdfExtraction] = list(req.pdf_extractions or [])
    by_sha: dict[str, PdfExtraction] = {}
    for ext in extractions:
        if ext.file_sha256:
            by_sha[ext.file_sha256] = ext

    for pdf_file in req.pdf_files or []:
        filename = getattr(pdf_file, "filename", "attachment.pdf")
        file_sha256 = getattr(pdf_file, "file_sha256", None)
        if file_sha256 and file_sha256 in by_sha:
            continue

        pdf_bytes = _load_pdf_bytes(pdf_file)
        if pdf_bytes is None:
            logger.warning("Skipping %r: missing usable storage_url/base64_data input", filename)
            continue

        extraction = extract_pdf_extraction_from_pdf_bytes(
            pdf_bytes=pdf_bytes,
            filename=filename,
            source="assignment",
            file_sha256=file_sha256,
        )
        extractions.append(extraction)
        if file_sha256:
            by_sha[file_sha256] = extraction

    # Last-resort backward compatibility for legacy inline text payloads.
    legacy_text = (req.pdf_text or "").strip()
    if legacy_text and not extractions:
        extractions.append(
            PdfExtraction(
                filename="legacy-inline-context.txt",
                source="assignment",
                full_text=_normalize_page_text(legacy_text),
                pages=[
                    PdfPageExtraction(
                        page_number=1,
                        text=_normalize_page_text(legacy_text),
                        method="legacy-inline",
                        confidence=max(_score_text_quality(legacy_text), 0.0),
                    )
                ],
                visual_signals=[],
                quality=PdfExtractionQuality(
                    strategy="legacy_inline_text",
                    docling_available=False,
                    native_chars=len(legacy_text),
                    docling_chars=0,
                    reconciled_chars=len(legacy_text),
                    notes=["legacy_pdf_text_field"],
                ),
            )
        )

    return extractions, by_sha


def extract_pdf_extractions_from_pdf_files(
    pdf_files: list[Any],
    source: str,
) -> list[PdfExtraction]:
    extractions: list[PdfExtraction] = []
    for pdf_file in pdf_files or []:
        filename = getattr(pdf_file, "filename", "attachment.pdf")
        file_sha256 = getattr(pdf_file, "file_sha256", None)
        pdf_bytes = _load_pdf_bytes(pdf_file)
        if pdf_bytes is None:
            logger.warning("Skipping %r: missing usable storage_url/base64_data input", filename)
            continue

        extractions.append(
            extract_pdf_extraction_from_pdf_bytes(
                pdf_bytes=pdf_bytes,
                filename=filename,
                source=source,
                file_sha256=file_sha256,
            )
        )
    return extractions


def format_pdf_extractions_for_prompt(
    extractions: list[PdfExtraction],
    source: Optional[str] = None,
) -> str:
    blocks: list[str] = []
    for extraction in extractions or []:
        if source and extraction.source != source:
            continue
        text = (extraction.full_text or "").strip()
        if not text:
            text = _normalize_page_text(
                "\n\n".join(page.text for page in extraction.pages if page.text)
            )
        if not text:
            continue
        blocks.append(format_attachment_block(extraction.filename, extraction.source, text))
    return "\n\n".join(blocks)


def collect_visual_signals_from_extractions(extractions: list[PdfExtraction]) -> list[dict]:
    signals: list[dict] = []
    for extraction in extractions or []:
        for signal in extraction.visual_signals:
            try:
                signals.append(signal.model_dump())
            except Exception:
                continue
    return _merge_visual_signals(signals, limit=MAX_VISUAL_SIGNALS_PER_FILE)


def build_pdf_file_extraction_payload(
    extractions_by_sha: dict[str, PdfExtraction],
) -> list[dict]:
    payload: list[dict] = []
    for file_sha256, extraction in extractions_by_sha.items():
        if not file_sha256:
            continue
        payload.append(
            {
                "file_sha256": file_sha256,
                "full_text": extraction.full_text,
                "extraction": extraction.model_dump(),
            }
        )
    return payload
