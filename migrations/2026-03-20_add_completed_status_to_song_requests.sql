DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_type
    WHERE typname = 'song_request_status'
  ) THEN
    BEGIN
      ALTER TYPE public.song_request_status ADD VALUE IF NOT EXISTS 'completed';
    EXCEPTION
      WHEN duplicate_object THEN
        NULL;
    END;
  END IF;
END
$$;
