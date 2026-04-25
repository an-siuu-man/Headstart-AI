import unittest

from app.orchestrators.headstart_orchestrator import (
    CATEGORY_PROMPT_ADDENDA,
    _build_followup_chat_prompt,
)


PROMPT_VARS = {
    "payload": "{}",
    "guide_markdown": "Guide",
    "retrieval_context": "(none)",
    "assignment_pdf_text": "(none)",
    "user_attachments_context": "(none)",
    "chat_history": "(none)",
    "calendar_context": "(not provided)",
    "user_message": "What next?",
}


def system_prompt_text(category: str = "") -> str:
    prompt = _build_followup_chat_prompt(category)
    messages = prompt.format_messages(**PROMPT_VARS)
    return str(messages[0].content)


class TestHeadstartOrchestratorCategoryPrompts(unittest.TestCase):
    def test_empty_category_uses_base_prompt(self):
        base_text = system_prompt_text("")
        self.assertEqual(system_prompt_text("general"), base_text)
        self.assertEqual(system_prompt_text("unknown"), base_text)

    def test_each_category_appends_addendum(self):
        base_text = system_prompt_text("")
        for category, addendum in CATEGORY_PROMPT_ADDENDA.items():
            with self.subTest(category=category):
                text = system_prompt_text(category)
                self.assertTrue(text.startswith(base_text))
                self.assertIn(addendum, text)

    def test_category_addenda_do_not_instruct_visible_label_output(self):
        for category in CATEGORY_PROMPT_ADDENDA:
            with self.subTest(category=category):
                text = system_prompt_text(category).lower()
                self.assertNotIn("tell the student this category", text)
                self.assertNotIn("mention the category", text)


if __name__ == "__main__":
    unittest.main()
