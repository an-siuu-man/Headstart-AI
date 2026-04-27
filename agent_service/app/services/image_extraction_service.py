"""
Artifact: agent_service/app/services/image_extraction_service.py
Purpose: Describe uploaded image attachments via the VLM so the orchestrator can
         reason about visual content in user messages.
"""

import base64
from dataclasses import dataclass, field
from typing import List, Optional

from ..core.logging import get_logger
from ..schemas.shared import ImageFile
from .pdf_text_service import (
    VLM_MAX_RETRIES,
    _build_vlm_client,
    _download_pdf_from_storage_url as _download_bytes_from_storage_url,
)

logger = get_logger("headstart.main")

IMAGE_DESCRIPTION_PROMPT = (
    "You are an expert visual assistant helping a student understand their coursework. "
    "Examine this image carefully and respond with EXACTLY two labeled sections:\n\n"
    "EXTRACTED TEXT:\n"
    "Transcribe every word of text visible in the image, exactly as written, preserving "
    "paragraph structure, bullet points, numbered lists, table layouts, and mathematical "
    "expressions (use plain-text approximations for math). Include handwriting. "
    "If the image contains no readable text, write: None\n\n"
    "CONTEXT:\n"
    "Describe any non-text visual content: diagrams, charts, graphs, figures, photos, "
    "drawings, UI screenshots, or other objects. Identify what each visual element shows, "
    "label key parts, and note the type of image (e.g. circuit diagram, bar chart, "
    "lecture slide, photo of handwritten notes, screenshot of code). "
    "If the image contains only text and no visual elements worth describing, write: None\n\n"
    "Output only these two labeled sections — no preamble, no closing remarks."
)


@dataclass
class ImageExtractionResult:
    filename: str
    mime_type: str
    file_sha256: Optional[str]
    description: str
    status: str  # "success" | "empty" | "failed" | "fetch_failed"


def _describe_image_bytes(image_bytes: bytes, mime_type: str, filename: str) -> tuple[str, str]:
    """Send image bytes to the VLM and return (description, status)."""
    from langchain_core.messages import HumanMessage

    b64 = base64.b64encode(image_bytes).decode("utf-8")
    message = HumanMessage(
        content=[
            {"type": "text", "text": IMAGE_DESCRIPTION_PROMPT},
            {"type": "image_url", "image_url": {"url": f"data:{mime_type};base64,{b64}"}},
        ]
    )

    client = _build_vlm_client()
    last_error = None
    for attempt in range(VLM_MAX_RETRIES):
        try:
            response = client.invoke([message])
            description = (response.content or "").strip()
            break
        except Exception as exc:
            last_error = exc
            logger.warning(
                "Image VLM attempt %d/%d failed for %r: %s",
                attempt + 1,
                VLM_MAX_RETRIES,
                filename,
                exc,
            )
    else:
        logger.warning("Image VLM exhausted retries for %r: %s", filename, last_error)
        return "", "failed"

    if not description:
        return "", "empty"

    return description, "success"


def extract_image_from_file(image_file: ImageFile) -> ImageExtractionResult:
    """Fetch and describe a single uploaded image via the VLM."""
    filename = image_file.filename
    mime_type = image_file.mime_type or "image/png"

    image_bytes: Optional[bytes] = None

    if image_file.storage_url:
        raw = _download_bytes_from_storage_url(image_file.storage_url, filename)
        if raw:
            image_bytes = raw
        else:
            logger.warning("Failed to download image %r from storage URL", filename)
            return ImageExtractionResult(
                filename=filename,
                mime_type=mime_type,
                file_sha256=image_file.file_sha256,
                description="",
                status="fetch_failed",
            )
    elif image_file.base64_data:
        try:
            image_bytes = base64.b64decode(image_file.base64_data)
        except Exception as exc:
            logger.warning("Failed to decode base64 for image %r: %s", filename, exc)
            return ImageExtractionResult(
                filename=filename,
                mime_type=mime_type,
                file_sha256=image_file.file_sha256,
                description="",
                status="failed",
            )
    else:
        logger.warning("Image %r has neither storage_url nor base64_data", filename)
        return ImageExtractionResult(
            filename=filename,
            mime_type=mime_type,
            file_sha256=image_file.file_sha256,
            description="",
            status="failed",
        )

    description, status = _describe_image_bytes(image_bytes, mime_type, filename)
    logger.info(
        "[image-extraction] %r | bytes=%d | status=%s | description_len=%d\n--- extracted text ---\n%s\n--- end ---",
        filename,
        len(image_bytes),
        status,
        len(description),
        description or "(empty)",
    )
    return ImageExtractionResult(
        filename=filename,
        mime_type=mime_type,
        file_sha256=image_file.file_sha256,
        description=description,
        status=status,
    )


def extract_images_deduped(image_files: List[ImageFile]) -> List[ImageExtractionResult]:
    """Describe user-uploaded images, skipping duplicates by SHA256."""
    seen_sha256: set[str] = set()
    results: List[ImageExtractionResult] = []

    for image_file in image_files:
        sha256 = image_file.file_sha256
        if sha256 and sha256 in seen_sha256:
            logger.info("Skipping duplicate image %r (sha256=%s)", image_file.filename, sha256)
            continue
        if sha256:
            seen_sha256.add(sha256)
        result = extract_image_from_file(image_file)
        results.append(result)
        logger.info(
            "Image extraction: %r status=%s description_len=%d",
            image_file.filename,
            result.status,
            len(result.description),
        )

    return results
