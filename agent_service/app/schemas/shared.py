"""
Artifact: agent_service/app/schemas/shared.py
Purpose: Defines reusable shared schema objects used across requests and responses.
Author: Ansuman Sharma
Created: 2026-02-27
Revised:
- 2026-02-27: Split shared schema models into dedicated module. (Ansuman Sharma)
Preconditions:
- Pydantic BaseModel is installed and importable.
Inputs:
- Acceptable: JSON-compatible values matching declared field types.
- Unacceptable: Missing required fields or incompatible value types.
Postconditions:
- Shared Pydantic models validate and serialize contract-compatible data.
Returns:
- Typed model instances for PDF files, milestones, and study blocks.
Errors/Exceptions:
- Pydantic validation errors for invalid payload data.
"""

from typing import List, Literal, Optional

from pydantic import BaseModel, Field


class PdfFile(BaseModel):
    filename: str
    base64_data: Optional[str] = None
    storage_url: Optional[str] = None
    file_sha256: Optional[str] = None


class PdfTextStyle(BaseModel):
    bold: bool = False
    italic: bool = False
    underline: bool = False
    strikethrough: bool = False


class PdfTextBlock(BaseModel):
    block_id: str
    text: str
    role: str = "text"
    page_number: int = 1
    source: Literal["docling", "native", "reconciled"] = "native"
    reading_order: int = 0
    confidence: float = 0.0
    bbox: Optional[List[float]] = None
    formatting: Optional[PdfTextStyle] = None


class PdfVisualSignal(BaseModel):
    file: str
    page: int
    text: str
    signal_types: List[str] = Field(default_factory=list)
    score: float = 0.0
    significance: Literal["high", "medium", "low"] = "low"
    source: str = ""


class PdfPageExtraction(BaseModel):
    page_number: int
    text: str = ""
    method: str = "native"
    blocks: List[PdfTextBlock] = Field(default_factory=list)
    confidence: float = 0.0


class PdfExtractionQuality(BaseModel):
    strategy: str = "native_ocr_dual_pass"
    docling_available: bool = False
    native_chars: int = 0
    docling_chars: int = 0
    reconciled_chars: int = 0
    notes: List[str] = Field(default_factory=list)


class PdfExtraction(BaseModel):
    filename: str
    source: Literal["assignment", "user_upload"] = "assignment"
    file_sha256: Optional[str] = None
    full_text: str = ""
    pages: List[PdfPageExtraction] = Field(default_factory=list)
    visual_signals: List[PdfVisualSignal] = Field(default_factory=list)
    quality: Optional[PdfExtractionQuality] = None


class Milestone(BaseModel):
    date: str
    task: str


class StudyBlock(BaseModel):
    durationMin: int
    focus: str
