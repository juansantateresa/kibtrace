# cv-rollout-schema-drift

Multi-service CV pipeline seed project that simulates a partial-failure rollout
caused by schema drift.

## Scenario

A new `event-persistor` rollout introduces v2, which writes to
`detection_events_v2`. The database only has `detection_events` because
migration 002 was never applied to this environment. The upstream pipeline
(frame ingestion, detection) works fine. Only v2 persistence fails.

## Services

| Service | Role | Healthy? |
|---------|------|----------|
| frame-ingestor | Simulates camera frames at steady intervals | Yes |
| detector-worker | Preprocessing, inference, detection. Routes 70% to v1, 30% to v2 | Yes |
| event-persistor-v1 | Writes to `detection_events` | Yes |
| event-persistor-v2 | Writes to `detection_events_v2` (missing table) | No |
| migration-runner | Applies migration 001 only | Yes (by design) |

## Quick start

```bash
docker compose up --build
```

Services log structured JSON to stdout. The seed project docker-compose does
not include Filebeat or Elasticsearch — use the sandbox at
`validation/sandbox/variant-b-rollout/` for the full shipping path.

## Key files for investigation

- `services/event-persistor-v2/index.js` — the failing persistence code
- `migrations/002_create_detection_events_v2.sql` — the unapplied migration
- `services/migration-runner/index.js` — only applies migration 001
