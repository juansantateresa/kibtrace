# Expected Incident Summary — Variant B Rollout

## Summary

`relation "detection_events_v2" does not exist`

## Top evidence

- Kind: error-cluster
- Title: relation "detection_events_v2" does not exist
- Severity: high
- Signals:
  - Multiple ERROR/FATAL events
  - Stack traces present
  - Concentrated in service.version=v2

## Top code candidates

1. `services/event-persistor-v2/index.js` — persistence function referencing
   `detection_events_v2`
2. `migrations/002_create_detection_events_v2.sql` — unapplied migration

## Hypotheses

- High confidence: repeated failure writing to missing relation
  `detection_events_v2`
- Medium confidence: causal chain from healthy detection to failed persistence
  in v2 traces
- The hypothesis should NOT implicate frame-ingestor or detector-worker

## Key trace IDs

Multiple trace IDs should appear, showing both:
- Healthy end-to-end traces (v1 persistence)
- Failing traces that break at v2 persistence
