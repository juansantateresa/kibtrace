# Scenario 01: OpenCV/YOLO Detection with Database Persistence Failure

## Description

A security camera system uses YOLO for person detection and OpenCV for tracking.
Detection works correctly (persons detected with high confidence), but the persistence
layer fails to write detection records to PostgreSQL because the connection pool is
exhausted.

## Expected Behavior from kibtrace

1. **Distinguish CV from persistence failure**: The report should clearly show that
   the detection pipeline (YOLO + OpenCV) is healthy while the persistence layer is
   failing. The hypothesis should NOT blame the CV components.

2. **Cluster separation**: Expect at least two distinct clusters:
   - Detection/tracking events (INFO level, healthy)
   - Database connection/write failures (ERROR level)

3. **Root cause signal**: The PostgreSQL pool exhaustion messages should cluster
   together and be identified as a database-category hypothesis.

4. **Conservative confidence**: With no repo code to correlate against (the fixture
   references external services), confidence should remain low-to-medium.

## Fixture

- File: `validation/fixtures/logs/opencv-yolo-db-failure.ndjson`
- Format: NDJSON (structured Elasticsearch-style export)
- Events: 25 log entries across two services (detection-service, persistence-service)

## Success Criteria

- [ ] NDJSON parsed correctly (all 25 entries ingested)
- [ ] At least 3 clusters produced
- [ ] ERROR-level events clustered separately from INFO events
- [ ] Hypothesis mentions database/persistence failure, not CV failure
- [ ] Report distinguishes healthy detection from failing persistence
