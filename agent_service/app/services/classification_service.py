"""
Artifact: agent_service/app/services/classification_service.py
Purpose: Classifies assignments into broad follow-up chat prompt categories.
"""

import json
import re
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage

from ..clients.llm_client import STRICT_GUIDE_MODEL_ID, build_nvidia_chat_client
from ..core.logging import get_logger

logger = get_logger("headstart.classification")

ASSIGNMENT_CATEGORIES = {"coding", "mathematics", "science", "speech", "essay", "general"}
CLASSIFIER_TEMPERATURE = 0.2
CLASSIFIER_TOP_P = 1
CLASSIFIER_MAX_TOKENS = 64
MAX_CLASSIFICATION_PAYLOAD_CHARS = 5000
MAX_CLASSIFICATION_PDF_CHARS = 5000

CLASSIFICATION_SYSTEM_PROMPT = """\
You classify Canvas assignments for an academic support application.

Return exactly one lowercase label from this list:
coding, mathematics, science, speech, essay, general

Use the best fit:
- coding: programming, software, data structures, algorithms, notebooks, scripts, debugging.
- mathematics: calculations, proofs, problem sets, statistics theory, symbolic reasoning.
- science: lab reports, experiments, scientific concepts, data analysis, research summaries.
- speech: presentations, speeches, slide talks, oral delivery, debate speaking.
- essay: essays, papers, reflections, literary analysis, argument-driven writing.
- general: anything that does not clearly fit one category.

Do not explain your choice. Do not output JSON.\
"""


def _to_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(_to_text(item) for item in value)
    content = getattr(value, "content", None)
    if content is not None:
        return _to_text(content)
    return str(value)


def _truncate(value: str, max_chars: int) -> str:
    text = (value or "").strip()
    if len(text) <= max_chars:
        return text
    return f"{text[:max_chars]}\n...[truncated {len(text) - max_chars} chars]"


def normalize_assignment_category(raw: str) -> str:
    text = (raw or "").strip().lower()
    if not text:
        return "general"
    match = re.search(r"\b(coding|mathematics|science|speech|essay|general)\b", text)
    if not match:
        return "general"
    category = match.group(1)
    return category if category in ASSIGNMENT_CATEGORIES else "general"


def classify_assignment(payload: dict, pdf_text: str = "") -> str:
    """
    Return an assignment category label.

    Classification is intentionally fail-open: guide generation and follow-up chat
    must continue even if provider setup, auth, networking, or output parsing fails.
    """
    try:
        payload_str = _truncate(
            json.dumps(payload or {}, ensure_ascii=False, default=str),
            MAX_CLASSIFICATION_PAYLOAD_CHARS,
        )
        pdf_text_str = _truncate(pdf_text or "", MAX_CLASSIFICATION_PDF_CHARS)
        llm = build_nvidia_chat_client(
            model_name=STRICT_GUIDE_MODEL_ID,
            temperature=CLASSIFIER_TEMPERATURE,
            max_tokens=CLASSIFIER_MAX_TOKENS,
            top_p=CLASSIFIER_TOP_P,
        )
        response = llm.invoke(
            [
                SystemMessage(content=CLASSIFICATION_SYSTEM_PROMPT),
                HumanMessage(
                    content=(
                        "Assignment payload:\n"
                        f"{payload_str}\n\n"
                        "Extracted assignment file text:\n"
                        f"{pdf_text_str or '(none)'}"
                    )
                ),
            ]
        )
        category = normalize_assignment_category(_to_text(response))
        if category == "general":
            logger.info("Assignment classification returned general/fallback")
        else:
            logger.info("Assignment classified | category=%s", category)
        return category
    except Exception as exc:
        logger.warning("Assignment classification failed; using general category: %s", repr(exc))
        return "general"
