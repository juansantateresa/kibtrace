# Expected Findings — Variant B Rollout

## Top incident

The top evidence item should relate to persistence failure against
`detection_events_v2`, not inference or ingestion.

Expected error cluster summary:
- `relation "detection_events_v2" does not exist`
- Concentrated in `service.version=v2`
- All occurrences at ERROR level
- Stack traces pointing to pg client and `event-persistor-v2/index.js`

## Top code candidates

Ranked code candidates should point to:
1. `services/event-persistor-v2/index.js` — the `handlePersist` function
2. `migrations/002_create_detection_events_v2.sql` — the unapplied migration

The following should NOT appear as top candidates:
- `services/frame-ingestor/index.js`
- `services/detector-worker/index.js`

## Trace evidence

A representative failing trace should show:
1. `Frame received for inference` (frame-ingestor)
2. `Frame preprocessed for model input` (detector-worker)
3. `Inference completed` (detector-worker)
4. `People detected in frame` (detector-worker)
5. `Persisting detection event` (event-persistor, v2)
6. ERROR: `relation "detection_events_v2" does not exist`
7. `Retrying detection event persistence`
8. ERROR: `relation "detection_events_v2" does not exist` (retry)

A representative healthy trace should show steps 1-5 then:
6. `Detection event persisted` (event-persistor, v1)

## Traffic mix

- Majority of traces should be healthy (routed to v1, ~70%)
- Minority should fail (routed to v2, ~30%)
- Failure should still rank as top incident due to ERROR severity

## What Claude should conclude

- Upstream CV pipeline is healthy
- Failure begins at persistence stage
- Failing traces disproportionately involve `service.version=v2`
- Runtime schema does not match deployed v2 code path
- Investigation targets: event-persistor-v2, migration SQL, rollout config

## What Claude should NOT conclude

- YOLO/OpenCV failure
- Ingestion bug
- Random infrastructure outage
- detector-worker as the bug owner
