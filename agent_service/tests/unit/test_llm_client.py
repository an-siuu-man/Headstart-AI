import os
import unittest
from unittest.mock import patch

from app.clients import llm_client


class TestLlmClient(unittest.TestCase):
    def test_registers_strict_model_when_missing(self):
        with patch.dict(os.environ, {"NVIDIA_API_KEY": "test-key"}, clear=False), patch.dict(
            llm_client.MODEL_TABLE,
            {},
            clear=True,
        ), patch("app.clients.llm_client.register_model") as mock_register, patch(
            "app.clients.llm_client.ChatNVIDIA"
        ) as mock_chat:
            sentinel = object()
            mock_chat.return_value = sentinel

            result = llm_client.build_nvidia_chat_client(
                model_name=llm_client.STRICT_GUIDE_MODEL_ID,
                temperature=0.2,
                max_tokens=512,
                top_p=0.9,
            )

        self.assertIs(result, sentinel)
        mock_register.assert_called_once()
        registered = mock_register.call_args.args[0]
        self.assertEqual(registered.id, llm_client.STRICT_GUIDE_MODEL_ID)
        self.assertEqual(registered.client, "ChatNVIDIA")
        self.assertEqual(registered.model_type, "chat")

    def test_does_not_register_model_when_already_known(self):
        with patch.dict(os.environ, {"NVIDIA_API_KEY": "test-key"}, clear=False), patch.dict(
            llm_client.MODEL_TABLE,
            {llm_client.STRICT_GUIDE_MODEL_ID: object()},
            clear=True,
        ), patch("app.clients.llm_client.register_model") as mock_register, patch(
            "app.clients.llm_client.ChatNVIDIA"
        ) as mock_chat:
            llm_client.build_nvidia_chat_client(
                model_name=llm_client.STRICT_GUIDE_MODEL_ID,
                temperature=0.2,
                max_tokens=512,
                top_p=0.9,
            )

        mock_register.assert_not_called()
        mock_chat.assert_called_once()

    def test_passes_expected_chatnvidia_kwargs(self):
        with patch.dict(os.environ, {"NVIDIA_API_KEY": "test-key"}, clear=False), patch.dict(
            llm_client.MODEL_TABLE,
            {llm_client.STRICT_GUIDE_MODEL_ID: object()},
            clear=True,
        ), patch("app.clients.llm_client.ChatNVIDIA") as mock_chat:
            llm_client.build_nvidia_chat_client(
                model_name=llm_client.STRICT_GUIDE_MODEL_ID,
                temperature=0.7,
                max_tokens=2048,
                top_p=0.95,
                reasoning_budget=8192,
                enable_thinking=True,
            )

        kwargs = mock_chat.call_args.kwargs
        self.assertEqual(kwargs["model"], llm_client.STRICT_GUIDE_MODEL_ID)
        self.assertEqual(kwargs["base_url"], llm_client.NVIDIA_NIM_BASE_URL)
        self.assertEqual(kwargs["api_key"], "test-key")
        self.assertEqual(kwargs["temperature"], 0.7)
        self.assertEqual(kwargs["max_completion_tokens"], 2048)
        self.assertEqual(kwargs["top_p"], 0.95)
        self.assertIn("model_kwargs", kwargs)
        self.assertEqual(kwargs["model_kwargs"]["reasoning_budget"], 8192)
        self.assertEqual(
            kwargs["model_kwargs"]["chat_template_kwargs"],
            {"enable_thinking": True},
        )

    def test_wraps_duplicate_candidate_error_as_strict_runtime_error(self):
        duplicate_error = (
            "Multiple candidates for nvidia/nemotron-3-super-120b-a12b "
            "in `available_models`: [Model(...), Model(...)]"
        )

        with patch.dict(os.environ, {"NVIDIA_API_KEY": "test-key"}, clear=False), patch.dict(
            llm_client.MODEL_TABLE,
            {llm_client.STRICT_GUIDE_MODEL_ID: object()},
            clear=True,
        ), patch(
            "app.clients.llm_client.ChatNVIDIA",
            side_effect=AssertionError(duplicate_error),
        ):
            with self.assertRaises(RuntimeError) as raised:
                llm_client.build_nvidia_chat_client(
                    model_name=llm_client.STRICT_GUIDE_MODEL_ID,
                    temperature=0.2,
                    max_tokens=512,
                    top_p=0.9,
                )

        message = str(raised.exception)
        self.assertIn("strict guide model", message)
        self.assertIn("will not fall back", message)
        self.assertIn("duplicate model candidates", message)

    def test_wraps_auth_or_listing_errors_as_strict_runtime_error(self):
        with patch.dict(os.environ, {"NVIDIA_API_KEY": "test-key"}, clear=False), patch.dict(
            llm_client.MODEL_TABLE,
            {llm_client.STRICT_GUIDE_MODEL_ID: object()},
            clear=True,
        ), patch(
            "app.clients.llm_client.ChatNVIDIA",
            side_effect=RuntimeError("401 Unauthorized while loading /v1/models"),
        ):
            with self.assertRaises(RuntimeError) as raised:
                llm_client.build_nvidia_chat_client(
                    model_name=llm_client.STRICT_GUIDE_MODEL_ID,
                    temperature=0.2,
                    max_tokens=512,
                    top_p=0.9,
                )

        message = str(raised.exception)
        self.assertIn("strict guide model", message)
        self.assertIn("authentication/authorization error", message)
        self.assertIn("will not fall back", message)


if __name__ == "__main__":
    unittest.main()
