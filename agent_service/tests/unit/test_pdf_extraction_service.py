import unittest
from unittest.mock import patch

from app.schemas.requests import RunAgentRequest
from app.schemas.shared import PdfExtraction, PdfFile, PdfVisualSignal
from app.services.pdf_extraction_service import (
    collect_visual_signals_from_extractions,
    extract_pdf_extraction_from_pdf_bytes,
    extract_pdf_extractions_with_file_map,
    format_pdf_extractions_for_prompt,
)


class TestPdfExtractionService(unittest.TestCase):
    def test_format_pdf_extractions_for_prompt_wraps_attachments(self):
        extraction = PdfExtraction(
            filename="spec.pdf",
            source="assignment",
            full_text="Assignment requirements",
            pages=[],
            visual_signals=[],
        )

        out = format_pdf_extractions_for_prompt([extraction], source="assignment")

        self.assertIn('<attachment name="spec.pdf" source="assignment">', out)
        self.assertIn("Assignment requirements", out)

    def test_collect_visual_signals_from_extractions_merges_duplicates(self):
        extraction = PdfExtraction(
            filename="spec.pdf",
            source="assignment",
            full_text="Q1",
            pages=[],
            visual_signals=[
                PdfVisualSignal(
                    file="spec.pdf",
                    page=1,
                    text="Q1",
                    signal_types=["highlight"],
                    score=1.1,
                    significance="high",
                    source="annotation",
                ),
                PdfVisualSignal(
                    file="spec.pdf",
                    page=1,
                    text="Q1",
                    signal_types=["underline"],
                    score=0.9,
                    significance="medium",
                    source="style",
                ),
            ],
        )

        merged = collect_visual_signals_from_extractions([extraction])
        self.assertEqual(len(merged), 1)
        self.assertEqual(sorted(merged[0]["signal_types"]), ["highlight", "underline"])

    def test_extract_pdf_extraction_from_pdf_bytes_uses_native_structured_output(self):
        with patch(
            "app.services.pdf_extraction_service.extract_pdf_context_from_pdf_bytes",
            return_value=(
                "--- Page 1 (native) ---\nNative text\n--- Page 2 (ocr) ---\nScanned text",
                [{"file": "spec.pdf", "page": 1, "text": "Q1", "signal_types": ["highlight"], "score": 1.2, "significance": "high", "source": "annotation"}],
            ),
        ):
            extraction = extract_pdf_extraction_from_pdf_bytes(
                b"placeholder",
                filename="spec.pdf",
                source="assignment",
                file_sha256="abc123",
            )

        self.assertEqual(extraction.filename, "spec.pdf")
        self.assertEqual(extraction.file_sha256, "abc123")
        self.assertTrue(extraction.full_text)
        self.assertEqual(len(extraction.pages), 2)
        self.assertEqual(extraction.pages[0].method, "native")
        self.assertEqual(extraction.pages[1].method, "ocr")
        self.assertGreater(len(extraction.pages[0].blocks), 0)
        self.assertEqual(len(extraction.visual_signals), 1)
        self.assertEqual(extraction.quality.strategy, "native_ocr_dual_pass")
        self.assertFalse(extraction.quality.docling_available)

    def test_extract_pdf_extractions_with_file_map_uses_pre_supplied_extractions(self):
        preloaded = PdfExtraction(
            filename="cached.pdf",
            source="assignment",
            file_sha256="sha-1",
            full_text="cached",
            pages=[],
            visual_signals=[],
        )
        req = RunAgentRequest(
            payload={"title": "HW1"},
            pdf_extractions=[preloaded],
            pdf_files=[PdfFile(filename="cached.pdf", file_sha256="sha-1")],
        )

        with patch(
            "app.services.pdf_extraction_service._load_pdf_bytes",
            return_value=None,
        ):
            extractions, by_sha = extract_pdf_extractions_with_file_map(req)

        self.assertEqual(len(extractions), 1)
        self.assertIn("sha-1", by_sha)
        self.assertEqual(by_sha["sha-1"].full_text, "cached")


if __name__ == "__main__":
    unittest.main()
