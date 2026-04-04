"""
Artifact: agent_service/app/services/pdf_text_service.py
Purpose: Decodes uploaded PDF binaries and extracts combined plain text for agent context.
Author: Ansuman Sharma
Created: 2026-02-27
Revised:
- 2026-02-27: Extracted PDF decode/text processing from main API module into a service. (Ansuman Sharma)
- 2026-02-28: Added page-aware extraction with native-text classification, selective OCR fallback, and text normalization. (Ansuman Sharma)
Preconditions:
- Request payload uses RunAgentRequest schema; PDF attachments are base64-encoded strings.
Inputs:
- Acceptable: Valid base64 PDF data and optional legacy `pdf_text` strings.
- Unacceptable: Corrupted base64 strings or non-PDF binary payloads.
Postconditions:
- Returns a combined text corpus from all available PDF sources and optional legacy text.
Returns:
- Concatenated string of extracted PDF text and legacy pdf_text input.
Errors/Exceptions:
- ImportError for missing PyMuPDF is handled with warning and empty extraction result.
- Decode/extraction errors are logged and skipped per file.
"""

import base64
import io
import math
import os
import re
import shutil
import tempfile
import urllib.error
import urllib.request
import uuid
from collections import Counter
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Optional

from ..core.logging import get_logger
from ..schemas.requests import RunAgentRequest

logger = get_logger("headstart.main")

MIN_NATIVE_TEXT_CHARS = 48
MIN_NATIVE_WORDS = 8
MIN_ALNUM_RATIO = 0.45
MAX_SYMBOL_RATIO = 0.40

OCR_RENDER_DPI = 240
OCR_TESSERACT_CONFIG = "--oem 3 --psm 6"
OCR_TESSERACT_FALLBACK_CONFIG = "--oem 3 --psm 11"
OCR_SUCCESS_SCORE = 0.72

HEADER_FOOTER_SAMPLE_LINES = 2
HEADER_FOOTER_REPEAT_RATIO = 0.60
HEADER_FOOTER_MIN_PAGES = 3

MAX_VISUAL_SIGNALS_PER_FILE = 40
MAX_VISUAL_SIGNAL_TEXT_LEN = 140
MIN_RECT_WORD_OVERLAP = 0.20
MIN_USABLE_TEXT_SCORE = 0.28
MIN_FALLBACK_NATIVE_SCORE = 0.12
TEXT_SCORE_OCR_ADVANTAGE = 0.08


def _env_float(name: str, fallback: float) -> float:
    try:
        value = float(os.getenv(name, str(fallback)))
    except Exception:
        return fallback
    if value <= 0:
        return fallback
    return value


def _env_int(name: str, fallback: int) -> int:
    try:
        value = int(float(os.getenv(name, str(fallback))))
    except Exception:
        return fallback
    if value <= 0:
        return fallback
    return value


PDF_FETCH_TIMEOUT_SECONDS = _env_float("PDF_FETCH_TIMEOUT_SECONDS", 15.0)
PDF_FETCH_MAX_BYTES = _env_int("PDF_FETCH_MAX_BYTES", 25 * 1024 * 1024)

SIGNAL_BASE_SCORES = {
    "highlight": 1.00,
    "underline": 0.90,
    "strikeout": 0.60,
    "squiggly": 0.70,
    "bold": 0.45,
    "colored_text": 0.35,
}

QUESTION_TOKEN_RE = re.compile(r"^(?:q(?:uestion)?\s*)?\d+[.)]?$", re.IGNORECASE)


@dataclass
class ExtractedPage:
    number: int
    method: str
    text: str


def _visual_signals_enabled() -> bool:
    """Feature-flag gate to disable visual-signal extraction if needed."""
    raw = os.getenv("ENABLE_VISUAL_SIGNALS", "true").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def _normalize_visual_text(text: str) -> str:
    clean = re.sub(r"\s+", " ", (text or "")).strip()
    if len(clean) > MAX_VISUAL_SIGNAL_TEXT_LEN:
        clean = clean[: MAX_VISUAL_SIGNAL_TEXT_LEN - 1].rstrip() + "…"
    return clean


def _overlap_ratio(rect_a, rect_b) -> float:
    """Return overlap area as ratio of rect_b area."""
    try:
        inter = rect_a & rect_b
        if inter.is_empty:
            return 0.0
        base = max(rect_b.get_area(), 1e-6)
        return inter.get_area() / base
    except Exception:
        return 0.0


def _extract_words_for_page(page) -> list[dict]:
    """Extract normalized word boxes for geometry-based annotation mapping."""
    words = []
    for item in page.get_text("words") or []:
        if len(item) < 5:
            continue
        x0, y0, x1, y1, text = item[:5]
        clean = _normalize_visual_text(text)
        if not clean:
            continue
        words.append(
            {
                "rect": page.rect.__class__(x0, y0, x1, y1),
                "text": clean,
                "sort_y": round(float(y0), 2),
                "sort_x": round(float(x0), 2),
            }
        )
    return words


def _collect_text_in_rect(page, rect, words: Optional[list[dict]] = None) -> str:
    """Map a visual region to nearby words, falling back to get_textbox."""
    words = words or []
    selected = []
    for w in words:
        if _overlap_ratio(rect, w["rect"]) >= MIN_RECT_WORD_OVERLAP:
            selected.append(w)
    if selected:
        selected.sort(key=lambda x: (x["sort_y"], x["sort_x"]))
        return _normalize_visual_text(" ".join(x["text"] for x in selected))
    return _normalize_visual_text(page.get_textbox(rect) or "")


def _score_visual_signal(text: str, signal_types: list[str]) -> float:
    score = 0.0
    for t in signal_types:
        score += SIGNAL_BASE_SCORES.get(t, 0.2)
    if len(signal_types) > 1:
        score += 0.1 * (len(signal_types) - 1)

    s = (text or "").strip()
    if QUESTION_TOKEN_RE.match(s):
        score += 0.35
    elif re.search(r"\bquestion\s+\d+\b", s, flags=re.IGNORECASE):
        score += 0.25

    if len(s) <= 12 and re.search(r"\d", s):
        score += 0.15
    return round(min(score, 1.7), 3)


def _significance_bucket(score: float) -> str:
    if score >= 1.0:
        return "high"
    if score >= 0.65:
        return "medium"
    return "low"


def _build_signal(
    filename: str,
    page_number: int,
    text: str,
    signal_types: list[str],
    source: str,
) -> Optional[dict]:
    clean = _normalize_visual_text(text)
    if not clean:
        return None
    score = _score_visual_signal(clean, signal_types)
    return {
        "file": filename,
        "page": page_number,
        "text": clean,
        "signal_types": sorted(set(signal_types)),
        "score": score,
        "significance": _significance_bucket(score),
        "source": source,
    }


def _merge_visual_signals(signals: list[dict], limit: int) -> list[dict]:
    """Deduplicate and keep the strongest signals to avoid prompt bloat."""
    by_key: dict[tuple[Any, ...], dict] = {}
    for sig in signals:
        key = (
            sig.get("file"),
            sig.get("page"),
            re.sub(r"\s+", " ", str(sig.get("text", "")).strip().lower()),
        )
        existing = by_key.get(key)
        if not existing:
            by_key[key] = sig
            continue
        merged_types = sorted(set(existing.get("signal_types", [])) | set(sig.get("signal_types", [])))
        existing["signal_types"] = merged_types
        existing["score"] = max(float(existing.get("score", 0.0)), float(sig.get("score", 0.0)))
        existing["significance"] = _significance_bucket(float(existing["score"]))
        existing["source"] = "annotation+style" if existing.get("source") != sig.get("source") else existing.get("source")

    ranked = sorted(
        by_key.values(),
        key=lambda s: (
            -float(s.get("score", 0.0)),
            int(s.get("page", 0)),
            str(s.get("text", "")),
        ),
    )
    return ranked[:limit]


def _extract_visual_signals_from_annotations(page, filename: str, page_number: int) -> list[dict]:
    signals = []
    words = _extract_words_for_page(page)
    annots = page.annots()
    if not annots:
        return signals

    type_map = {
        "highlight": "highlight",
        "underline": "underline",
        "strikeout": "strikeout",
        "squiggly": "squiggly",
    }
    for annot in annots:
        try:
            annot_type = (annot.type[1] or "").strip().lower()
            mapped = type_map.get(annot_type)
            if not mapped:
                continue
            text = _collect_text_in_rect(page, annot.rect, words=words)
            signal = _build_signal(
                filename=filename,
                page_number=page_number,
                text=text,
                signal_types=[mapped],
                source="annotation",
            )
            if signal:
                signals.append(signal)
        except Exception as e:
            logger.debug("Skipping malformed annotation on %r page %d: %s", filename, page_number, e)
    return signals


def _extract_visual_signals_from_styles(page, filename: str, page_number: int) -> list[dict]:
    """
    Extract style-derived emphasis hints.
    This path is intentionally conservative to avoid flooding the model with noisy style signals.
    """
    signals = []
    try:
        import fitz
    except ImportError:
        return signals

    try:
        text_dict = page.get_text("dict", flags=fitz.TEXTFLAGS_DICT | fitz.TEXT_COLLECT_STYLES)
    except Exception:
        return signals

    for block in text_dict.get("blocks", []):
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                text = _normalize_visual_text(span.get("text", ""))
                if not text:
                    continue

                signal_types = []
                flags = int(span.get("flags", 0) or 0)
                color = int(span.get("color", 0) or 0)

                if flags & fitz.TEXT_FONT_BOLD:
                    signal_types.append("bold")
                if color != 0:
                    signal_types.append("colored_text")

                if not signal_types:
                    continue

                # Keep style-derived items focused on likely question markers / short emphasized tokens.
                if not (
                    QUESTION_TOKEN_RE.match(text)
                    or re.search(r"\bquestion\s+\d+\b", text, flags=re.IGNORECASE)
                    or (len(text) <= 24 and re.search(r"\d", text))
                ):
                    continue

                signal = _build_signal(
                    filename=filename,
                    page_number=page_number,
                    text=text,
                    signal_types=signal_types,
                    source="style",
                )
                if signal:
                    signals.append(signal)
    return signals


def _compute_text_quality(text: str) -> dict:
    """Return lightweight metrics used to decide native extraction quality."""
    compact = "".join(ch for ch in (text or "") if not ch.isspace())
    chars = len(compact)
    alnum = sum(ch.isalnum() for ch in compact)
    symbols = sum(not ch.isalnum() for ch in compact)
    words = re.findall(r"[A-Za-z0-9]{2,}", text or "")
    return {
        "chars": chars,
        "words": len(words),
        "alnum_ratio": (alnum / chars) if chars else 0.0,
        "symbol_ratio": (symbols / chars) if chars else 1.0,
    }


def _score_text_quality(text: str) -> float:
    """Map text-quality metrics to a simple 0-1 score for native vs OCR selection."""
    metrics = _compute_text_quality(text)
    if metrics["chars"] == 0:
        return 0.0

    char_score = min(metrics["chars"] / 180.0, 1.0) * 0.25
    word_score = min(metrics["words"] / 28.0, 1.0) * 0.25
    alnum_score = max(0.0, min(metrics["alnum_ratio"], 1.0)) * 0.30
    symbol_score = max(0.0, 1.0 - min(metrics["symbol_ratio"], 1.0)) * 0.20
    return round(char_score + word_score + alnum_score + symbol_score, 3)


def _should_ocr_page(native_text: str) -> bool:
    """Decide if a page should use OCR instead of native extraction."""
    metrics = _compute_text_quality(native_text)
    if metrics["chars"] < MIN_NATIVE_TEXT_CHARS:
        return True
    if metrics["words"] < MIN_NATIVE_WORDS:
        return True
    if metrics["alnum_ratio"] < MIN_ALNUM_RATIO:
        return True
    if metrics["symbol_ratio"] > MAX_SYMBOL_RATIO:
        return True
    return False


def _normalize_match_line(line: str) -> str:
    """Normalize line signatures for repeated header/footer detection."""
    normalized = re.sub(r"\d+", "#", (line or "").lower())
    normalized = re.sub(r"\s+", " ", normalized).strip(" .:-|_")
    return normalized


def _remove_repeated_headers_and_footers(page_texts: list[str]) -> list[str]:
    """
    Remove top/bottom lines that repeat on most pages.
    This reduces prompt noise from boilerplate headers, footers, and page counters.
    """
    total_pages = len(page_texts)
    if total_pages < HEADER_FOOTER_MIN_PAGES:
        return page_texts

    pattern_counts: Counter = Counter()

    for text in page_texts:
        lines = [ln.strip() for ln in (text or "").splitlines() if ln.strip()]
        sampled = lines[:HEADER_FOOTER_SAMPLE_LINES] + lines[-HEADER_FOOTER_SAMPLE_LINES:]
        patterns = {
            _normalize_match_line(ln)
            for ln in sampled
            if 4 <= len(ln.strip()) <= 140
        }
        for pattern in patterns:
            if pattern:
                pattern_counts[pattern] += 1

    min_occurrences = max(HEADER_FOOTER_MIN_PAGES, math.ceil(total_pages * HEADER_FOOTER_REPEAT_RATIO))
    repeated_patterns = {
        pattern for pattern, count in pattern_counts.items() if count >= min_occurrences
    }
    if not repeated_patterns:
        return page_texts

    cleaned_pages = []
    for text in page_texts:
        kept_lines = []
        for line in (text or "").splitlines():
            if _normalize_match_line(line) in repeated_patterns:
                continue
            kept_lines.append(line.rstrip())
        cleaned_pages.append("\n".join(kept_lines).strip())
    return cleaned_pages


def _looks_like_structural_line(line: str) -> bool:
    """Preserve line breaks for headings, bullets, numbered lists, and table-ish rows."""
    s = (line or "").strip()
    if not s:
        return False
    if re.match(r"^[-*\u2022]\s+", s):
        return True
    if re.match(r"^\d+[.)]\s+", s):
        return True
    if s.endswith(":") and len(s) <= 90:
        return True
    if "|" in s:
        return True
    if re.search(r"\S\s{2,}\S", s):
        return True
    if s.isupper() and 3 <= len(s) <= 80:
        return True
    return False


def _unwrap_hard_line_breaks(text: str) -> str:
    """
    Join wrapped lines into paragraphs while preserving obvious structure.
    This is intentionally conservative to avoid damaging table/list semantics.
    """
    out_lines = []
    paragraph_buffer = []

    for raw_line in (text or "").splitlines():
        line = raw_line.strip()
        if not line:
            if paragraph_buffer:
                out_lines.append(" ".join(paragraph_buffer))
                paragraph_buffer = []
            if out_lines and out_lines[-1] != "":
                out_lines.append("")
            continue

        if _looks_like_structural_line(line):
            if paragraph_buffer:
                out_lines.append(" ".join(paragraph_buffer))
                paragraph_buffer = []
            out_lines.append(line)
            continue

        paragraph_buffer.append(line)

    if paragraph_buffer:
        out_lines.append(" ".join(paragraph_buffer))

    normalized = []
    prev_blank = False
    for line in out_lines:
        if not line:
            if not prev_blank:
                normalized.append("")
            prev_blank = True
            continue
        normalized.append(re.sub(r"[ \t]+", " ", line).strip())
        prev_blank = False

    return "\n".join(normalized).strip()


def _normalize_page_text(text: str) -> str:
    """Normalize extracted page text for better LLM readability and chunk stability."""
    if not text:
        return ""
    normalized = text.replace("\r\n", "\n").replace("\r", "\n").replace("\u00a0", " ")
    # Fix words broken by PDF line wrapping, e.g. "multi-\nline".
    normalized = re.sub(r"(?<=\w)-\n(?=\w)", "", normalized)
    normalized = _unwrap_hard_line_breaks(normalized)
    return normalized.strip()


def _text_token_overlap_ratio(left: str, right: str) -> float:
    left_tokens = set(re.findall(r"[A-Za-z0-9]{2,}", (left or "").lower()))
    right_tokens = set(re.findall(r"[A-Za-z0-9]{2,}", (right or "").lower()))
    if not left_tokens or not right_tokens:
        return 0.0
    return len(left_tokens & right_tokens) / min(len(left_tokens), len(right_tokens))


def _texts_substantially_overlap(left: str, right: str) -> bool:
    return _text_token_overlap_ratio(left, right) >= 0.80


def _merge_text_variants(primary_text: str, supplement_text: str) -> str:
    """Append only non-duplicate lines from a secondary extraction pass."""
    primary_lines = [ln.strip() for ln in (primary_text or "").splitlines() if ln.strip()]
    supplement_lines = [ln.strip() for ln in (supplement_text or "").splitlines() if ln.strip()]
    if not primary_lines:
        return "\n".join(supplement_lines).strip()
    if not supplement_lines:
        return "\n".join(primary_lines).strip()

    seen = {_normalize_match_line(line) for line in primary_lines if line.strip()}
    merged = list(primary_lines)
    for line in supplement_lines:
        signature = _normalize_match_line(line)
        if signature and signature in seen:
            continue
        merged.append(line)
        if signature:
            seen.add(signature)
    return "\n".join(merged).strip()


def _choose_page_text_variant(
    native_text: str,
    ocr_text: str,
    ocr_attempted: bool,
) -> tuple[str, str]:
    """Choose the best page text and extraction mode from native/OCR candidates."""
    native = _normalize_page_text(native_text)
    ocr = _normalize_page_text(ocr_text)
    native_score = _score_text_quality(native)
    ocr_score = _score_text_quality(ocr)

    if ocr:
        if native:
            if ocr_score >= native_score + TEXT_SCORE_OCR_ADVANTAGE:
                if native_score >= MIN_USABLE_TEXT_SCORE and not _texts_substantially_overlap(ocr, native):
                    return "hybrid", _merge_text_variants(ocr, native)
                return "ocr", ocr
            if (
                native_score >= MIN_USABLE_TEXT_SCORE
                and ocr_score >= MIN_USABLE_TEXT_SCORE
                and not _texts_substantially_overlap(native, ocr)
            ):
                return "hybrid", _merge_text_variants(native, ocr)
            return "native", native
        return "ocr", ocr

    if native:
        if native_score >= MIN_USABLE_TEXT_SCORE:
            return "native", native
        if not ocr_attempted or native_score >= MIN_FALLBACK_NATIVE_SCORE:
            return "native", native

    return "none", ""


@lru_cache(maxsize=1)
def _ocr_runtime_status() -> tuple[bool, str]:
    try:
        import pytesseract
        from PIL import Image  # noqa: F401
    except ImportError:
        return False, "missing_python_dependencies"

    tesseract_path = shutil.which("tesseract")
    if not tesseract_path:
        return False, "tesseract_not_found"

    try:
        pytesseract.get_tesseract_version()
    except Exception as e:
        return False, f"tesseract_unavailable: {e}"

    return True, tesseract_path


def _extract_ocr_text_from_page(page, filename: str, page_number: int) -> tuple[str, str]:
    """OCR fallback for image-heavy pages. Returns normalized text and OCR status."""
    runtime_ready, runtime_detail = _ocr_runtime_status()
    if not runtime_ready:
        logger.warning(
            "OCR unavailable for %r page %d: %s",
            filename,
            page_number,
            runtime_detail,
        )
        return "", "unavailable"

    try:
        import pytesseract
        from PIL import Image, ImageOps

        pix = page.get_pixmap(dpi=OCR_RENDER_DPI, alpha=False)
        image = Image.open(io.BytesIO(pix.tobytes("png")))
        processed = ImageOps.autocontrast(image.convert("L"))

        best_text = ""
        best_score = -1.0

        for config in (OCR_TESSERACT_CONFIG, OCR_TESSERACT_FALLBACK_CONFIG):
            try:
                candidate = _normalize_page_text(
                    pytesseract.image_to_string(processed, config=config)
                )
            except Exception as e:
                logger.warning(
                    "OCR failed for %r page %d with config %r: %s",
                    filename,
                    page_number,
                    config,
                    e,
                )
                continue

            score = _score_text_quality(candidate)
            if candidate and score > best_score:
                best_text = candidate
                best_score = score

            if score >= OCR_SUCCESS_SCORE:
                break

        if best_text:
            return best_text, "success"

        logger.warning("OCR produced no usable text for %r page %d", filename, page_number)
        return "", "failed"
    except Exception as e:
        logger.warning("OCR failed for %r page %d: %s", filename, page_number, e)
        return "", "failed"


def _extract_pages_and_visual_signals(pdf_bytes: bytes, filename: str) -> tuple[list[ExtractedPage], list[dict]]:
    """Extract per-page text and optional visual-emphasis signals."""
    try:
        import fitz
    except ImportError:
        logger.warning(
            "pymupdf not installed – cannot extract PDF text. Run: pip install pymupdf"
        )
        return [], []

    pages: list[ExtractedPage] = []
    visual_signals: list[dict] = []
    collect_visual = _visual_signals_enabled()

    try:
        with fitz.open(stream=pdf_bytes, filetype="pdf") as doc:
            for idx, page in enumerate(doc, start=1):
                native_text = page.get_text("text") or ""
                should_try_ocr = _should_ocr_page(native_text)
                ocr_text = ""
                ocr_status = "not_attempted"
                if should_try_ocr:
                    ocr_text, ocr_status = _extract_ocr_text_from_page(
                        page,
                        filename=filename,
                        page_number=idx,
                    )

                method, page_text = _choose_page_text_variant(
                    native_text=native_text,
                    ocr_text=ocr_text,
                    ocr_attempted=should_try_ocr,
                )

                pages.append(
                    ExtractedPage(
                        number=idx,
                        method=method,
                        text=page_text,
                    )
                )
                logger.debug(
                    "Page extraction %r page %d | method=%s | ocr_candidate=%s | ocr_status=%s | native_score=%.3f | ocr_score=%.3f",
                    filename,
                    idx,
                    method,
                    should_try_ocr,
                    ocr_status,
                    _score_text_quality(_normalize_page_text(native_text)),
                    _score_text_quality(ocr_text),
                )

                if collect_visual:
                    visual_signals.extend(_extract_visual_signals_from_annotations(page, filename, idx))
                    visual_signals.extend(_extract_visual_signals_from_styles(page, filename, idx))

        visual_signals = _merge_visual_signals(visual_signals, limit=MAX_VISUAL_SIGNALS_PER_FILE)
        return pages, visual_signals
    except Exception as e:
        logger.warning("Failed to extract text from PDF %r: %s", filename, e)
        return [], []


def _extract_pages(pdf_bytes: bytes, filename: str) -> list[ExtractedPage]:
    """Backward-compatible wrapper returning only extracted pages."""
    pages, _ = _extract_pages_and_visual_signals(pdf_bytes=pdf_bytes, filename=filename)
    return pages


def extract_pdf_context_from_pdf_bytes(pdf_bytes: bytes, filename: str) -> tuple[str, list[dict]]:
    """Extract normalized text plus ranked visual-emphasis signals from one PDF."""
    pages, visual_signals = _extract_pages_and_visual_signals(pdf_bytes=pdf_bytes, filename=filename)
    if not pages:
        return "", []

    normalized_pages = _remove_repeated_headers_and_footers([p.text for p in pages])
    merged_parts = []
    for page, page_text in zip(pages, normalized_pages):
        merged_parts.append(f"--- Page {page.number} ({page.method}) ---")
        if page_text:
            merged_parts.append(page_text)
        else:
            merged_parts.append("(no text extracted)")

    output = "\n".join(merged_parts).strip()
    logger.info(
        "Extracted %d chars from PDF %r (%d pages, %d visual signals)",
        len(output),
        filename,
        len(pages),
        len(visual_signals),
    )
    return output, visual_signals


def extract_text_from_pdf_bytes(pdf_bytes: bytes, filename: str) -> str:
    """Extract and normalize page-aware PDF text with selective OCR fallback."""
    output, _ = extract_pdf_context_from_pdf_bytes(pdf_bytes=pdf_bytes, filename=filename)
    return output


def _decode_pdf_base64(base64_data: str) -> bytes:
    """Decode raw base64 or data-URL style PDF payloads."""
    data = base64_data.strip()
    if "," in data and data.lower().startswith("data:"):
        data = data.split(",", 1)[1]
    return base64.b64decode(data)


def _download_pdf_from_storage_url(storage_url: str, filename: str) -> Optional[bytes]:
    url = (storage_url or "").strip()
    if not url:
        return None

    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/pdf,application/octet-stream,*/*",
            "User-Agent": "headstart-agent/1.0",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=PDF_FETCH_TIMEOUT_SECONDS) as resp:
            content_length_raw = resp.headers.get("Content-Length")
            if content_length_raw:
                try:
                    content_length = int(content_length_raw)
                    if content_length > PDF_FETCH_MAX_BYTES:
                        logger.warning(
                            "Skipping %r from storage_url (Content-Length=%d exceeds max=%d)",
                            filename,
                            content_length,
                            PDF_FETCH_MAX_BYTES,
                        )
                        return None
                except Exception:
                    pass

            total = 0
            chunks = []
            while True:
                chunk = resp.read(64 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > PDF_FETCH_MAX_BYTES:
                    logger.warning(
                        "Skipping %r from storage_url (downloaded %d bytes exceeds max=%d)",
                        filename,
                        total,
                        PDF_FETCH_MAX_BYTES,
                    )
                    return None
                chunks.append(chunk)

            payload = b"".join(chunks)
            logger.debug(
                "Downloaded PDF %r from storage_url – %d bytes",
                filename,
                len(payload),
            )
            return payload
    except urllib.error.HTTPError as e:
        logger.warning("Failed to fetch %r from storage_url – HTTP %s", filename, e.code)
    except urllib.error.URLError as e:
        logger.warning("Failed to fetch %r from storage_url – %s", filename, e.reason)
    except TimeoutError:
        logger.warning("Timed out fetching %r from storage_url", filename)
    except Exception as e:
        logger.warning("Failed to fetch %r from storage_url: %s", filename, e)

    return None


def _pdf_debug_dump_enabled() -> bool:
    raw = os.getenv("ENABLE_PDF_DEBUG_DUMP", "false").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def _maybe_dump_pdf_text(parts: list[str]) -> None:
    if not parts or not _pdf_debug_dump_enabled():
        return

    dump_dir = (os.getenv("PDF_DEBUG_DUMP_DIR") or tempfile.gettempdir()).strip()
    try:
        os.makedirs(dump_dir, exist_ok=True)
        dump_filename = f"headstart-pdf-extracted-{os.getpid()}-{uuid.uuid4().hex[:12]}.txt"
        dump_path = os.path.join(dump_dir, dump_filename)
        with open(dump_path, "w", encoding="utf-8") as f:
            f.write("\n\n\n".join(parts))
        logger.info("PDF text dumped to %s", dump_path)
    except Exception as e:
        logger.warning("Failed to write PDF debug dump to %r: %s", dump_dir, e)


def format_attachment_block(filename: str, source: str, text: str) -> str:
    """
    Wrap extracted PDF text in a structured block so the LLM can identify
    each file by name and distinguish assignment files from user uploads.

    Format:
        <attachment name="filename.pdf" source="assignment|user_upload">
        ...extracted text...
        </attachment>
    """
    safe_name = filename.replace('"', "'")
    safe_source = source.replace('"', "'")
    return f'<attachment name="{safe_name}" source="{safe_source}">\n{text}\n</attachment>'


def extract_pdf_context(req: RunAgentRequest) -> tuple[str, list[dict]]:
    """
    Build combined PDF text and visual-emphasis signals from request attachments.
    """
    combined_text, visual_signals, _ = extract_pdf_context_with_file_texts(req)
    return combined_text, visual_signals


def extract_pdf_context_with_file_texts(
    req: RunAgentRequest,
) -> tuple[str, list[dict], dict[str, str]]:
    """
    Build combined PDF text and visual-emphasis signals from request attachments,
    and also return a per-file mapping of file_sha256 → extracted_text for
    persistence back to the database.

    Returns:
        (combined_pdf_text, visual_signals, {file_sha256: extracted_text})
        The third value only contains entries where file_sha256 is non-empty and
        extraction produced usable text.
    """
    parts = []
    visual_signals = []
    file_texts_by_sha256: dict[str, str] = {}

    if req.pdf_text:
        parts.append(req.pdf_text)

    for pdf_file in req.pdf_files or []:
        pdf_bytes = None

        if pdf_file.storage_url:
            pdf_bytes = _download_pdf_from_storage_url(pdf_file.storage_url, pdf_file.filename)

        if pdf_bytes is None and pdf_file.base64_data:
            try:
                pdf_bytes = _decode_pdf_base64(pdf_file.base64_data)
                logger.debug("Decoding PDF %r – %d bytes", pdf_file.filename, len(pdf_bytes))
            except Exception as e:
                logger.warning("Failed to decode base64 for %r: %s", pdf_file.filename, e)
                continue

        if pdf_bytes is None:
            logger.warning(
                "Skipping %r: missing usable storage_url/base64_data input",
                pdf_file.filename,
            )
            continue

        text, file_signals = extract_pdf_context_from_pdf_bytes(pdf_bytes, pdf_file.filename)
        if text:
            logger.info("PDF %r preview: %r", pdf_file.filename, text[:200])
            parts.append(format_attachment_block(pdf_file.filename, "assignment", text))
            if pdf_file.file_sha256:
                file_texts_by_sha256[pdf_file.file_sha256] = text
        if file_signals:
            visual_signals.extend(file_signals)

    visual_signals = _merge_visual_signals(visual_signals, limit=MAX_VISUAL_SIGNALS_PER_FILE)

    _maybe_dump_pdf_text(parts)

    return "\n\n".join(parts), visual_signals, file_texts_by_sha256


def extract_all_pdf_text(req: RunAgentRequest) -> str:
    """
    Build combined pdf_text from direct text and decoded PDF attachments.
    """
    text, _ = extract_pdf_context(req)
    return text


def extract_text_from_pdf_files(pdf_files) -> str:
    """
    Download and extract plain text from a list of PdfFile objects.

    Tries storage_url first, falls back to base64_data. Files that fail to
    download or have no usable source are skipped with a warning log.

    Returns a single string with each file's text separated by a header line.
    """
    if not pdf_files:
        return ""

    parts = []
    for pdf_file in pdf_files:
        pdf_bytes = None

        if pdf_file.storage_url:
            pdf_bytes = _download_pdf_from_storage_url(pdf_file.storage_url, pdf_file.filename)

        if pdf_bytes is None and pdf_file.base64_data:
            try:
                pdf_bytes = _decode_pdf_base64(pdf_file.base64_data)
            except Exception as exc:
                logger.warning(
                    "Failed to decode base64 for user attachment %r: %s",
                    pdf_file.filename,
                    exc,
                )
                continue

        if pdf_bytes is None:
            logger.warning(
                "Skipping user attachment %r: no usable storage_url or base64_data",
                pdf_file.filename,
            )
            continue

        text, _ = extract_pdf_context_from_pdf_bytes(pdf_bytes, pdf_file.filename)
        if text:
            parts.append(format_attachment_block(pdf_file.filename, "user_upload", text))

    return "\n\n".join(parts)
