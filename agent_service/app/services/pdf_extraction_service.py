"""
Artifact: agent_service/app/services/pdf_extraction_service.py
Purpose: Build structured PDF extractions using native PyMuPDF + OCR extraction.
Author: Codex
Created: 2026-04-04
Revised:
- 2026-04-09: Removed Docling-based extraction paths and unified on native service output.
"""

from __future__ import annotations

import re
from typing import Any, Literal, Optional

from ..core.logging import get_logger
from ..schemas.requests import RunAgentRequest
from ..schemas.shared import (
    PdfExtraction,
    PdfExtractionQuality,
    PdfPageExtraction,
    PdfTextBlock,
    PdfVisualSignal,
)
from .pdf_text_service import (
    MAX_VISUAL_SIGNALS_PER_FILE,
    _decode_pdf_base64,
    _download_pdf_from_storage_url,
    _merge_visual_signals,
    _normalize_page_text,
    _score_text_quality,
    extract_pdf_context_from_pdf_bytes,
    format_attachment_block,
)

logger = get_logger("headstart.main")

PAGE_HEADER_RE = re.compile(r"^--- Page (\d+) \(([^)]+)\) ---$")
NO_TEXT_SENTINEL = "(no text extracted)"


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
            current_method = match.group(2).strip() or "native"
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


def _source_from_page_method(method: str) -> Literal["native", "reconciled"]:
    normalized = (method or "").strip().lower()
    if normalized == "hybrid":
        return "reconciled"
    return "native"


def _build_page_blocks(text: str, page_number: int, method: str) -> list[PdfTextBlock]:
    lines = [line.strip() for line in (text or "").splitlines() if line.strip()]
    blocks: list[PdfTextBlock] = []
    source = _source_from_page_method(method)

    for index, line in enumerate(lines, start=1):
        blocks.append(
            PdfTextBlock(
                block_id=f"native-{page_number}-{index}",
                text=line,
                role="text",
                page_number=page_number,
                source=source,
                reading_order=index,
                confidence=max(_score_text_quality(line), 0.0),
            )
        )
    return blocks


def _to_page_models(native_pages: list[tuple[int, str, str]]) -> list[PdfPageExtraction]:
    pages: list[PdfPageExtraction] = []
    for page_number, method, raw_text in native_pages:
        page_text = _normalize_page_text(raw_text)
        if page_text == NO_TEXT_SENTINEL:
            page_text = ""
        pages.append(
            PdfPageExtraction(
                page_number=page_number,
                text=page_text,
                method=method or "native",
                blocks=_build_page_blocks(page_text, page_number, method),
                confidence=max(_score_text_quality(page_text), 0.0),
            )
        )
    return pages


def _fallback_full_text_from_structured_text(native_text: str) -> str:
    if not native_text:
        return ""

    kept_lines: list[str] = []
    for raw in native_text.splitlines():
        line = raw.strip()
        if PAGE_HEADER_RE.match(line):
            continue
        if line == NO_TEXT_SENTINEL:
            continue
        kept_lines.append(raw)
    return _normalize_page_text("\n".join(kept_lines))


def _to_visual_signal_models(signals: list[dict]) -> list[PdfVisualSignal]:
    out: list[PdfVisualSignal] = []
    for sig in signals:
        try:
            out.append(PdfVisualSignal.model_validate(sig))
        except Exception:
            continue
    return out


def extract_pdf_extraction_from_pdf_bytes(
    pdf_bytes: bytes,
    filename: str,
    source: str = "assignment",
    file_sha256: Optional[str] = None,
) -> PdfExtraction:
    native_structured_text, native_signals = extract_pdf_context_from_pdf_bytes(pdf_bytes, filename)
    native_pages = _parse_native_page_sections(native_structured_text)
    pages = _to_page_models(native_pages)

    full_text = _normalize_page_text(
        "\n\n".join(page.text for page in pages if page.text)
    )
    if not full_text:
        full_text = _fallback_full_text_from_structured_text(native_structured_text)

    if not pages and full_text:
        pages = [
            PdfPageExtraction(
                page_number=1,
                text=full_text,
                method="native_unsegmented",
                blocks=_build_page_blocks(full_text, page_number=1, method="native"),
                confidence=max(_score_text_quality(full_text), 0.0),
            )
        ]

    all_signals = _merge_visual_signals(
        native_signals,
        limit=MAX_VISUAL_SIGNALS_PER_FILE,
    )

    quality = PdfExtractionQuality(
        strategy="native_ocr_dual_pass",
        docling_available=False,
        native_chars=len(full_text),
        docling_chars=0,
        reconciled_chars=len(full_text),
        notes=["source=native_pymupdf_ocr"],
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
