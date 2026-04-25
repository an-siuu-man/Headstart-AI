import unittest
from unittest.mock import patch

from app.services.classification_service import classify_assignment, normalize_assignment_category


class FakeClassificationClient:
    def __init__(self, response):
        self.response = response
        self.invoke_calls = []

    def invoke(self, messages):
        self.invoke_calls.append(messages)
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


class FakeMessage:
    def __init__(self, content):
        self.content = content


class TestClassificationService(unittest.TestCase):
    def test_normalize_assignment_category_accepts_known_label(self):
        self.assertEqual(normalize_assignment_category("Coding\n"), "coding")
        self.assertEqual(normalize_assignment_category("The category is mathematics."), "mathematics")

    def test_normalize_assignment_category_falls_back_for_unknown_label(self):
        self.assertEqual(normalize_assignment_category("history"), "general")
        self.assertEqual(normalize_assignment_category(""), "general")

    def test_classify_assignment_returns_valid_label(self):
        fake_client = FakeClassificationClient(FakeMessage("essay"))

        with patch(
            "app.services.classification_service.build_nvidia_chat_client",
            return_value=fake_client,
        ):
            category = classify_assignment(
                {"title": "Rhetorical Analysis", "descriptionText": "Write an essay."},
                "",
            )

        self.assertEqual(category, "essay")
        self.assertEqual(len(fake_client.invoke_calls), 1)

    def test_classify_assignment_falls_back_for_invalid_label(self):
        fake_client = FakeClassificationClient(FakeMessage("history"))

        with patch(
            "app.services.classification_service.build_nvidia_chat_client",
            return_value=fake_client,
        ):
            category = classify_assignment({"title": "Timeline project"}, "")

        self.assertEqual(category, "general")

    def test_classify_assignment_falls_back_on_exception(self):
        fake_client = FakeClassificationClient(RuntimeError("provider unavailable"))

        with patch(
            "app.services.classification_service.build_nvidia_chat_client",
            return_value=fake_client,
        ):
            category = classify_assignment({"title": "Lab"}, "experiment")

        self.assertEqual(category, "general")


if __name__ == "__main__":
    unittest.main()
