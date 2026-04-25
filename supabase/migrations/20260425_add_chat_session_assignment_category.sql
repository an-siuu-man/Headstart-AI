ALTER TABLE public.chat_sessions
  ADD COLUMN IF NOT EXISTS assignment_category text;

DO $$
BEGIN
  ALTER TABLE public.chat_sessions
    ADD CONSTRAINT chat_sessions_assignment_category_check
    CHECK (
      assignment_category IS NULL
      OR assignment_category = ANY (
        ARRAY[
          'coding'::text,
          'mathematics'::text,
          'science'::text,
          'speech'::text,
          'essay'::text,
          'general'::text
        ]
      )
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
