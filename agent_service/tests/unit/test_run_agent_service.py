import unittest
from unittest.mock import patch

from app.schemas.requests import ChatStreamRequest, RunAgentRequest
from app.services.run_agent_service import (
    run_agent_workflow,
    stream_chat_workflow,
    stream_run_agent_workflow,
)

SAMPLE_RESULT = {
    "guideMarkdown": "## Assignment Overview\n\nWrite a concise draft.",
}


class TestRunAgentService(unittest.TestCase):
    def _build_request(self):
        return RunAgentRequest(
            assignment_uuid="abc-123",
            payload={"title": "HW1", "courseId": "101"},
            pdf_text="legacy",
            pdf_files=[],
        )

    def test_run_agent_workflow_orchestrates_extraction_and_agent_call(self):
        req = self._build_request()
        visual_signals = [{"file": "spec.pdf", "page": 1, "text": "Q1", "signal_types": ["highlight"]}]

        with patch(
            "app.services.run_agent_service.extract_pdf_extractions_with_file_map",
            return_value=([], {}),
        ) as mock_extract, patch(
            "app.services.run_agent_service.format_pdf_extractions_for_prompt",
            return_value="pdf context",
        ), patch(
            "app.services.run_agent_service.collect_visual_signals_from_extractions",
            return_value=visual_signals,
        ), patch(
            "app.services.run_agent_service._run_headstart_agent",
            return_value=SAMPLE_RESULT,
        ) as mock_agent:
            result = run_agent_workflow(req, route_path="/run-agent")

        self.assertEqual(result, SAMPLE_RESULT)
        mock_extract.assert_called_once_with(req)
        mock_agent.assert_called_once_with(req.payload, "pdf context", visual_signals=visual_signals)

    def test_run_agent_workflow_handles_empty_pdf_text(self):
        req = self._build_request()

        with patch(
            "app.services.run_agent_service.extract_pdf_extractions_with_file_map",
            return_value=([], {}),
        ) as mock_extract, patch(
            "app.services.run_agent_service.format_pdf_extractions_for_prompt",
            return_value="",
        ), patch(
            "app.services.run_agent_service.collect_visual_signals_from_extractions",
            return_value=[],
        ), patch(
            "app.services.run_agent_service._run_headstart_agent",
            return_value=SAMPLE_RESULT,
        ) as mock_agent:
            result = run_agent_workflow(req, route_path="/api/v1/runs")

        self.assertEqual(result, SAMPLE_RESULT)
        mock_extract.assert_called_once_with(req)
        mock_agent.assert_called_once_with(req.payload, "", visual_signals=[])

    def test_stream_run_agent_workflow_emits_reasoning_deltas_and_completion_thinking(self):
        req = self._build_request()

        with patch(
            "app.services.run_agent_service.extract_pdf_extractions_with_file_map",
            return_value=([], {}),
        ), patch(
            "app.services.run_agent_service.format_pdf_extractions_for_prompt",
            return_value="",
        ), patch(
            "app.services.run_agent_service.collect_visual_signals_from_extractions",
            return_value=[],
        ), patch(
            "app.services.run_agent_service._stream_headstart_agent_markdown",
            return_value=iter(
                [
                    {"content_delta": "", "reasoning_delta": "thinking-1"},
                    {"content_delta": "Guide body", "reasoning_delta": "thinking-2"},
                ]
            ),
        ):
            events = list(stream_run_agent_workflow(req, route_path="/api/v1/runs/stream"))

        delta_events = [event for event in events if event.get("event") == "run.delta"]
        self.assertGreaterEqual(len(delta_events), 2)
        self.assertEqual(delta_events[0]["data"]["reasoning_delta"], "thinking-1")
        self.assertEqual(delta_events[1]["data"]["delta"], "Guide body")
        self.assertEqual(delta_events[1]["data"]["reasoning_delta"], "thinking-2")

        completed_events = [event for event in events if event.get("event") == "run.completed"]
        self.assertEqual(len(completed_events), 1)
        completed = completed_events[0]["data"]
        self.assertEqual(completed["guideMarkdown"], "Guide body")
        self.assertEqual(completed["thinking_content"], "thinking-1thinking-2")

    def test_stream_chat_workflow_emits_reasoning_deltas_and_completion_thinking(self):
        req = ChatStreamRequest(
            assignment_payload={"title": "HW1"},
            guide_markdown="Guide body",
            chat_history=[],
            retrieval_context=[],
            user_message="What should I do first?",
        )

        with patch(
            "app.services.run_agent_service._stream_headstart_chat_answer",
            return_value=iter(
                [
                    {"content_delta": "", "reasoning_delta": "think-a"},
                    {"content_delta": "Start with milestone one.", "reasoning_delta": "think-b"},
                ]
            ),
        ) as mock_stream:
            events = list(stream_chat_workflow(req, route_path="/api/v1/chats/stream"))

        delta_events = [event for event in events if event.get("event") == "chat.delta"]
        self.assertGreaterEqual(len(delta_events), 2)
        self.assertEqual(delta_events[0]["data"]["reasoning_delta"], "think-a")
        self.assertEqual(delta_events[1]["data"]["delta"], "Start with milestone one.")
        self.assertEqual(delta_events[1]["data"]["reasoning_delta"], "think-b")

        completed_events = [event for event in events if event.get("event") == "chat.completed"]
        self.assertEqual(len(completed_events), 1)
        completed = completed_events[0]["data"]
        self.assertEqual(completed["assistant_message"], "Start with milestone one.")
        self.assertEqual(completed["thinking_content"], "think-athink-b")
        mock_stream.assert_called_once_with(
            assignment_payload={"title": "HW1"},
            guide_markdown="Guide body",
            chat_history=[],
            retrieval_context=[],
            user_message="What should I do first?",
            include_thinking=False,
            calendar_context=None,
            assignment_pdf_text="",
            user_attachments_context="",
        )

    def test_chat_stream_request_defaults_thinking_mode_false(self):
        req = ChatStreamRequest(
            assignment_payload={"title": "HW1"},
            guide_markdown="Guide body",
            chat_history=[],
            retrieval_context=[],
            user_message="Default mode?",
        )

        self.assertFalse(req.thinking_mode)

    def test_stream_chat_workflow_passes_thinking_mode_true(self):
        req = ChatStreamRequest(
            assignment_payload={"title": "HW1"},
            guide_markdown="Guide body",
            chat_history=[],
            retrieval_context=[],
            user_message="Use thinking mode",
            thinking_mode=True,
        )

        with patch(
            "app.services.run_agent_service._stream_headstart_chat_answer",
            return_value=iter(
                [
                    {"content_delta": "Use milestones.", "reasoning_delta": ""},
                ]
            ),
        ) as mock_stream:
            events = list(stream_chat_workflow(req, route_path="/api/v1/chats/stream"))

        completed_events = [event for event in events if event.get("event") == "chat.completed"]
        self.assertEqual(len(completed_events), 1)
        mock_stream.assert_called_once_with(
            assignment_payload={"title": "HW1"},
            guide_markdown="Guide body",
            chat_history=[],
            retrieval_context=[],
            user_message="Use thinking mode",
            include_thinking=True,
            calendar_context=None,
            assignment_pdf_text="",
            user_attachments_context="",
        )

    def test_stream_chat_workflow_passes_calendar_context_payload(self):
        req = ChatStreamRequest(
            assignment_payload={"title": "HW1"},
            guide_markdown="Guide body",
            chat_history=[],
            retrieval_context=[],
            user_message="Schedule time blocks for me",
            calendar_context={
                "assignment_id": "assign-1",
                "timezone": "America/Chicago",
                "availability_reason": "available",
                "integration": {
                    "google": {
                        "status": "connected",
                        "connected": True,
                    }
                },
                "no_slots_found": False,
                "free_slots": [
                    {
                        "start_iso": "2026-03-27T15:00:00Z",
                        "end_iso": "2026-03-27T16:00:00Z",
                        "duration_minutes": 60,
                        "score": 90,
                        "reason": "Good afternoon block",
                    }
                ],
                "recommended_sessions": [
                    {
                        "start_iso": "2026-03-27T15:00:00Z",
                        "end_iso": "2026-03-27T16:00:00Z",
                        "focus": "Deep work",
                        "priority": "high",
                    }
                ],
            },
        )

        with patch(
            "app.services.run_agent_service._stream_headstart_chat_answer",
            return_value=iter(
                [
                    {"content_delta": "Use the open afternoon block.", "reasoning_delta": ""},
                ]
            ),
        ) as mock_stream:
            events = list(stream_chat_workflow(req, route_path="/api/v1/chats/stream"))

        completed_events = [event for event in events if event.get("event") == "chat.completed"]
        self.assertEqual(len(completed_events), 1)
        mock_stream.assert_called_once_with(
            assignment_payload={"title": "HW1"},
            guide_markdown="Guide body",
            chat_history=[],
            retrieval_context=[],
            user_message="Schedule time blocks for me",
            include_thinking=False,
            calendar_context={
                "assignment_id": "assign-1",
                "timezone": "America/Chicago",
                "availability_reason": "available",
                "integration": {
                    "google": {
                        "status": "connected",
                        "connected": True,
                    }
                },
                "no_slots_found": False,
                "free_slots": [
                    {
                        "start_iso": "2026-03-27T15:00:00Z",
                        "end_iso": "2026-03-27T16:00:00Z",
                        "duration_minutes": 60,
                        "score": 90.0,
                        "reason": "Good afternoon block",
                    }
                ],
                "recommended_sessions": [
                    {
                        "start_iso": "2026-03-27T15:00:00Z",
                        "end_iso": "2026-03-27T16:00:00Z",
                        "focus": "Deep work",
                        "priority": "high",
                    }
                ],
            },
            assignment_pdf_text="",
            user_attachments_context="",
        )

    def test_chat_stream_request_accepts_review_window_reasons(self):
        available_review = ChatStreamRequest(
            assignment_payload={"title": "HW1"},
            guide_markdown="Guide body",
            chat_history=[],
            retrieval_context=[],
            user_message="Can I review this next week?",
            calendar_context={
                "assignment_id": "assign-1",
                "timezone": "America/Chicago",
                "availability_reason": "available_review_window",
                "integration": {
                    "google": {
                        "status": "connected",
                        "connected": True,
                    }
                },
                "no_slots_found": False,
                "free_slots": [
                    {
                        "start_iso": "2026-03-30T15:00:00Z",
                        "end_iso": "2026-03-30T16:00:00Z",
                        "duration_minutes": 60,
                        "score": 90,
                        "reason": "Open review window slot",
                    }
                ],
                "recommended_sessions": [
                    {
                        "start_iso": "2026-03-30T15:00:00Z",
                        "end_iso": "2026-03-30T16:00:00Z",
                        "focus": "Concept review",
                        "priority": "medium",
                    }
                ],
            },
        )
        self.assertEqual(
            available_review.calendar_context.availability_reason,  # type: ignore[union-attr]
            "available_review_window",
        )

        no_slots_review = ChatStreamRequest(
            assignment_payload={"title": "HW1"},
            guide_markdown="Guide body",
            chat_history=[],
            retrieval_context=[],
            user_message="Any time for review?",
            calendar_context={
                "assignment_id": "assign-1",
                "timezone": "America/Chicago",
                "availability_reason": "no_slots_in_review_window",
                "integration": {
                    "google": {
                        "status": "connected",
                        "connected": True,
                    }
                },
                "no_slots_found": True,
                "free_slots": [],
                "recommended_sessions": [],
            },
        )
        self.assertEqual(
            no_slots_review.calendar_context.availability_reason,  # type: ignore[union-attr]
            "no_slots_in_review_window",
        )


if __name__ == "__main__":
    unittest.main()
