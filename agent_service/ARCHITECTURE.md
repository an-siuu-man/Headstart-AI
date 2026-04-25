# Agent Service Architecture

## Purpose

The FastAPI agent service receives normalized assignment payloads (plus optional PDF content), orchestrates LLM generation, and returns a structured study guide response. In the current architecture, the preferred PDF path is object-storage URLs (`storage_url`) with optional legacy base64 fallback.

## Runtime Components

- `app/main.py`: FastAPI entrypoint, route registration, legacy compatibility endpoints.
- `app/api/v1/routes/runs.py`: Request handler wrapper for run execution.
- `app/services/run_agent_service.py`: Request-level workflow orchestration.
- `app/services/classification_service.py`: Best-effort assignment category classifier used after streamed guide generation.
- `app/services/pdf_text_service.py`: Page-aware PDF extraction (native-first classification, selective OCR fallback, normalization, visual-significance extraction).
- `app/orchestrators/headstart_orchestrator.py`: LLM prompting, structured parsing, and streaming guide/chat generation.
- `app/clients/llm_client.py`: LLM client factory for NVIDIA-hosted `openai/gpt-oss-120b` via LangChain.
- `app/schemas/*`: Pydantic request/response and shared models.

## API Surface

- `GET /health` (legacy)
- `POST /run-agent` (legacy)
- `GET /api/v1/health`
- `POST /api/v1/runs`

Both run endpoints share the same internal handler path through `handle_run_agent_request()`.

## Module Boundaries

- `api/v1/routes/*`: HTTP transport and error mapping only.
- `services/*`: Workflow orchestration and cross-module coordination.
- `orchestrators/*`: LLM-specific behavior and output shaping.
- `schemas/*`: Input/output contract definitions.
- `clients/*`: External provider initialization only.

## Request Contract

`RunAgentRequest`:

- `assignment_uuid?: string`
- `payload: Dict[str, Any]` (required)
- `pdf_text?: string`
- `pdf_files?: List[{ filename, storage_url?, base64_data?, file_sha256? }]`

`pdf_files` behavior:

- Preferred input: `storage_url` for each file (signed URL produced by webapp).
- Compatibility fallback: `base64_data` remains accepted.
- `file_sha256` is optional metadata and is not required for extraction.

## Response Contract

`RunAgentResponse`:

- `guideMarkdown: string` (single markdown body with all guide sections/headings in-text)

## End-to-End Call Flow

1. Web app forwards request to `POST /run-agent` (or v1 route). Upstream, webapp stores binary PDFs in object storage and deduplicates by hash before generating signed URLs.
2. Route calls `run_agent_workflow()` from `services/run_agent_service.py`.
3. Service logs request metadata and calls `extract_pdf_context()`.
4. PDF service fetches `pdf_files[*].storage_url` when present, otherwise decodes `pdf_files[*].base64_data` (raw base64 and data-URL payloads).
5. For each page, PDF service extracts native text via PyMuPDF (`fitz`).
6. A page-quality heuristic classifies each page as either:
   - `native` (good text layer)
   - `ocr` candidate (empty/short/symbol-heavy native extraction)
7. Only classified pages use OCR fallback:
   - render page image via PyMuPDF
   - preprocess with Pillow (grayscale + autocontrast)
   - OCR via pytesseract
8. Extracted text is normalized for LLM readability:
   - de-hyphenate line-break splits
   - unwrap hard line breaks into paragraphs
   - normalize whitespace
   - remove repeated headers/footers across pages
9. PDF service extracts visual-significance markers:
   - annotation-derived emphasis (`highlight`, `underline`, `strikeout`, `squiggly`)
   - conservative style-derived emphasis (`bold`, `colored_text`) for likely question markers
   - geometry mapping to nearest text + significance scoring (`high` / `medium` / `low`)
   - deduplication/ranking with capped prompt footprint
10. Service assembles text output with stable separators:
   - `--- File: <filename> ---`
   - `--- Page N (native|ocr) ---`
11. Service merges extracted text with legacy `pdf_text`, writes debug dump to `agent_service/pdf_extracted_text.txt`, then calls `run_headstart_agent(payload, pdf_text, visual_signals)`.
12. Orchestrator injects visual emphasis context into the prompt and attempts structured output mode (`with_structured_output(RunAgentResponse)`).
13. If needed, orchestrator falls back to prompt-based generation with JSON repair/parsing heuristics.
14. Service returns structured dictionary back through route layer.

For streamed guide generation, the service extracts assignment context, emits a `classifying_assignment` stage, then calls the lightweight classifier before guide generation begins. The final `run.completed` SSE payload includes `assignment_category` as structured metadata. Classification is fail-open and returns `general` if provider setup, output parsing, or the LLM call fails.

## PDF Extraction Strategy

- Native text extraction is the default path for highest fidelity when a text layer exists.
- OCR is selective and page-scoped to reduce latency/cost compared to OCR-ing whole documents.
- Normalization preserves structure where useful (headings, bullets, table-like rows) while removing common PDF artifacts that confuse LLM prompts.
- Visual emphasis extraction captures likely-important marked text and sends ranked signal metadata to the orchestrator.
- `ENABLE_VISUAL_SIGNALS` feature flag controls visual-signal extraction (enabled by default).
- External API contract remains unchanged; visual signals are an internal service/orchestrator contract.

## LLM Orchestration Strategy

- Preferred streaming mode: NVIDIA-hosted `openai/gpt-oss-120b` through LangChain `ChatNVIDIA.stream`.
- Streaming mode emits provider chunks directly for long-lived guide and chat responses.
- Initial streamed runs perform a short post-guide classification call with the same hosted model to produce one of `coding`, `mathematics`, `science`, `speech`, `essay`, or `general`.
- Follow-up chat prompts append an internal category-specific system prompt addendum when a recognized category is supplied by the webapp. The category is metadata and is not rendered into assistant chat responses.
- Legacy non-stream primary mode: schema-bound structured output for reliable contract adherence.
- Legacy non-stream fallback mode: strict JSON prompt with retries (`MAX_RETRIES`) and parser repair.
- Parsing safeguards: markdown fence stripping, quote normalization, trailing comma cleanup, control-character cleanup, key quoting heuristics.

## Configuration and Dependencies

- Required env var: `NVIDIA_API_KEY`.
- Optional env vars for storage URL ingestion safeguards:
  - `PDF_FETCH_TIMEOUT_SECONDS` (default `15`)
  - `PDF_FETCH_MAX_BYTES` (default `26214400`, 25MB)
- Core dependencies: FastAPI, Pydantic, LangChain, NVIDIA LangChain endpoint client.
- Required for PDF extraction: PyMuPDF (`pymupdf`).
- Optional OCR dependencies: `pytesseract`, `pillow`, and a system Tesseract binary available on `PATH`.
- OCR path requires native `tesseract` executable installed and discoverable in environment `PATH`.

## Failure Behavior

- Missing `NVIDIA_API_KEY` raises runtime error.
- PDF decode/extract failures are logged and skipped per file.
- Storage URL fetch failures (HTTP/network/timeout/oversize) are logged and skipped per file.
- OCR dependency/runtime failures are logged and only affect OCR-candidate pages; pipeline continues with native extraction output when available.
- Visual-signal extraction failures are logged and skipped per page/file; text extraction and run generation continue.
- Route wrapper catches unhandled workflow exceptions and returns HTTP 500.
- Parsing failures after all retries raise explicit runtime errors with diagnostics.
- Assignment classification failures do not fail guide generation; the service emits `general` and keeps the chat prompt on the base behavior.
