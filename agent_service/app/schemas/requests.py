"""
Artifact: agent_service/app/schemas/requests.py
Purpose: Defines transport request models accepted by the run-agent and chat-stream workflows.
Author: Ansuman Sharma
Created: 2026-02-27
Revised:
- 2026-02-27: Extracted request schemas into dedicated module. (Ansuman Sharma)
- 2026-03-02: Added follow-up chat streaming request models for RAG-enabled chat. (Codex)
Preconditions:
- Pydantic BaseModel and typing modules are available.
Inputs:
- Acceptable: JSON object containing payload and optional assignment_uuid/pdf fields, or follow-up chat request body.
- Unacceptable: Missing payload object, malformed chat history, or invalid field types.
Postconditions:
- Request data is validated into typed models used by services/routes.
Returns:
- `RunAgentRequest` and `ChatStreamRequest` model instances.
Errors/Exceptions:
- Pydantic validation errors for malformed request bodies.
"""

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field

from .shared import PdfExtraction, PdfFile


class RunAgentRequest(BaseModel):
    assignment_uuid: Optional[str] = None
    payload: Dict[str, Any]
    pdf_extractions: Optional[List[PdfExtraction]] = Field(default_factory=list)
    pdf_files: Optional[List[PdfFile]] = Field(default_factory=list)
    # Backward-compatible legacy field (deprecated, ignored when structured extractions exist).
    pdf_text: Optional[str] = ""


class ChatHistoryMessage(BaseModel):
    role: str
    content: str


class RetrievalChunk(BaseModel):
    chunk_id: str
    source: Literal["guide_markdown", "assignment_payload", "assignment_pdf"]
    text: str
    score: float = 0.0


class CalendarIntegrationState(BaseModel):
    status: Literal["connected", "disconnected", "needs_attention"]
    connected: bool


class CalendarIntegrationContext(BaseModel):
    google: CalendarIntegrationState


class CalendarFreeSlot(BaseModel):
    start_iso: str
    end_iso: str
    duration_minutes: int
    score: float
    reason: str = ""


class CalendarRecommendedSession(BaseModel):
    start_iso: str
    end_iso: str
    focus: str = ""
    priority: Literal["high", "medium", "low"]


class CalendarContext(BaseModel):
    assignment_id: Optional[str] = None
    timezone: str = "UTC"
    availability_reason: Literal[
        "available",
        "available_review_window",
        "no_slots_before_deadline",
        "no_slots_in_review_window",
        "calendar_disconnected",
        "calendar_needs_attention",
        "calendar_fetch_failed",
        "assignment_missing_due_date",
        "assignment_past_due",
        "assignment_unresolved",
    ] = "available"
    integration: CalendarIntegrationContext
    no_slots_found: bool = False
    free_slots: List[CalendarFreeSlot] = Field(default_factory=list)
    recommended_sessions: List[CalendarRecommendedSession] = Field(default_factory=list)


class ChatStreamRequest(BaseModel):
    assignment_payload: Dict[str, Any]
    guide_markdown: str = ""
    chat_history: List[ChatHistoryMessage] = Field(default_factory=list)
    retrieval_context: List[RetrievalChunk] = Field(default_factory=list)
    user_message: str
    thinking_mode: bool = False
    calendar_context: Optional[CalendarContext] = None
    assignment_pdf_extractions: Optional[List[PdfExtraction]] = Field(default_factory=list)
    assignment_pdf_text: Optional[str] = ""
    user_pdf_files: Optional[List[PdfFile]] = Field(default_factory=list)
