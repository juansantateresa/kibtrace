-- This migration creates the v2 table that event-persistor-v2 expects.
-- It exists in the repo but has NOT been applied to staging yet.
-- The rollout deployed v2 code before this migration was run.

CREATE TABLE IF NOT EXISTS detection_events_v2 (
  id SERIAL PRIMARY KEY,
  trace_id TEXT NOT NULL,
  camera_id TEXT NOT NULL,
  person_count INTEGER NOT NULL,
  confidence REAL,
  model_version TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
