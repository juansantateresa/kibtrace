# CV DB Failure App

This seed project will simulate the flagship incident for `kibtrace`.

Target behavior:

- a synthetic CV pipeline detects people
- the app attempts to persist a detection event
- the persistence path fails in a noisy but non-fatal way

This project is a validation asset only.

The app writes ECS-style NDJSON logs to a shared log directory so Filebeat can ship them into Elasticsearch.

Current seeded incident mode:

- person detection succeeds
- writes are attempted against the wrong table name
- Postgres is healthy, but persistence fails

That keeps the incident focused on post-detection persistence rather than CV inference failure.
