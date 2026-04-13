CREATE TABLE IF NOT EXISTS detection_events (
  id SERIAL PRIMARY KEY,
  trace_id TEXT NOT NULL,
  camera_id TEXT NOT NULL,
  person_count INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
