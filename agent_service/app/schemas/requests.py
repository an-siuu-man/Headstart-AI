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

from typing import Any, Dict, List, Optional

from pydantic import BaseModel

from .shared import PdfFile


class RunAgentRequest(BaseModel):
    assignment_uuid: Optional[str] = None
    payload: Dict[str, Any]
    pdf_text: Optional[str] = ""
    pdf_files: Optional[List[PdfFile]] = []


class ChatHistoryMessage(BaseModel):
    role: str
    content: str


class RetrievalChunk(BaseModel):
    chunk_id: str
    source: str
    text: str
    score: float = 0.0


class ChatStreamRequest(BaseModel):
    assignment_payload: Dict[str, Any]
    guide_markdown: str = ""
    chat_history: List[ChatHistoryMessage] = []
    retrieval_context: List[RetrievalChunk] = []
    user_message: str
    thinking_mode: bool = False
