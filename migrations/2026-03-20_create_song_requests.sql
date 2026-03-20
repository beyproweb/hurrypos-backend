DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type
    WHERE typname = 'song_request_status'
  ) THEN
    CREATE TYPE public.song_request_status AS ENUM ('pending', 'approved', 'cancelled');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.song_requests (
  id BIGSERIAL PRIMARY KEY,
  restaurant_id BIGINT NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  table_number INTEGER NOT NULL,
  song_name TEXT NOT NULL,
  status public.song_request_status NOT NULL DEFAULT 'pending',
  queue_number INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_song_requests_restaurant_queue
  ON public.song_requests (restaurant_id, queue_number);

CREATE INDEX IF NOT EXISTS idx_song_requests_restaurant_table
  ON public.song_requests (restaurant_id, table_number);

CREATE INDEX IF NOT EXISTS idx_song_requests_restaurant_status
  ON public.song_requests (restaurant_id, status);
