# Kibtrace Sandbox Plan

## Purpose

This sandbox exists to make the Elastic side of `kibtrace` realistic early.

It is not product runtime code.

It is a repo-local validation environment used to:

- generate realistic incidents
- inspect the real Elasticsearch-backed log shape
- define the first `kibtrace fetch` contract
- regenerate deterministic exported fixtures when needed

The sandbox lives in this repository because it is tightly coupled to validation, not because it is part of the published package surface.

## v0 Recommendation

Use this stack first:

- `cv-db-failure-app`
- `postgres`
- `filebeat`
- `elasticsearch`
- `kibana`

This is the best `v0` tradeoff:

- much closer to real-world Elastic usage than handwritten fixtures alone
- much lighter than Fleet-managed Elastic Agent
- avoids designing `kibtrace` around Kibana UI automation
- still simple enough to run locally

## Data Flow

1. the fake app emits ECS-formatted JSON logs
2. logs are written to a file volume
3. Filebeat tails the file with `filestream` plus `ndjson`
4. Filebeat ships the logs to Elasticsearch
5. Kibana Discover shows the data to humans
6. `kibtrace fetch` queries Elasticsearch directly
7. `kibtrace prepare` reduces and indexes the fetched evidence for Claude

Important boundary:

- Kibana is the manual observability UI
- Elasticsearch is the machine interface
- `kibtrace` must not automate Kibana clicks

## Proposed Layout

```text
validation/
  sandbox/
    README.md
    elastic-stack/
      docker-compose.yml
      .env.example
      filebeat/
        filebeat.yml
  seed-projects/
    cv-db-failure-app/
      README.md
      package.json
      src/
      logs/
```

## Services

### `cv-db-failure-app`

Purpose:

- simulate a people-detection pipeline
- emit ECS JSON logs
- seed the flagship incident

Behavior:

- ingest synthetic frames
- simulate YOLO person detection
- attempt to persist a detection event
- fail that persistence path intentionally for the incident case
- retry and log the error path
- continue producing healthy noise logs around the failure

### `postgres`

Purpose:

- make the persistence failure concrete
- produce realistic database-write error patterns

### `filebeat`

Purpose:

- ship application logs realistically
- preserve the normal file-to-Elastic ingestion path

Configuration goals:

- `filestream` input
- `ndjson` parser
- ECS-compatible JSON input
- output to Elasticsearch

### `elasticsearch`

Purpose:

- store the real investigation data
- provide the programmatic search surface for `kibtrace fetch`

### `kibana`

Purpose:

- let humans inspect the same data in Discover
- verify that the sandbox feels close to the real operator workflow

## Flagship Incident

The flagship sandbox incident is:

- person detection succeeds
- persistence or database write fails
- the service stays alive
- the log stream includes both healthy and failing events

This should force `kibtrace` to distinguish:

- CV inference succeeded
- downstream persistence failed

That is the key product promise for the flagship scenario.

## Log Shape

The fake app should emit ECS-style JSON logs with fields close to:

- `@timestamp`
- `log.level`
- `message`
- `service.name`
- `service.version`
- `event.dataset`
- `trace.id`
- `transaction.id`
- `camera.id`
- `model.version`
- `deployment.version`
- `person.detected`
- `person.count`
- `inference.ms`
- `db.operation`
- `db.statement`
- `error.message`
- `error.type`
- `error.stack_trace`

Not every field is required in every event.

The point is to make the log stream rich enough that `kibtrace` can later retrieve:

- top error clusters
- representative excerpts
- related traces
- service-scoped slices
- persistence-vs-inference evidence

## First Milestones

### Milestone 1

Create the sandbox skeleton only:

- `validation/sandbox/elastic-stack/`
- `validation/seed-projects/cv-db-failure-app/`
- service-level README notes

### Milestone 2

Bring up the local stack and verify:

- app emits logs
- Filebeat ships them
- Elasticsearch stores them
- Kibana shows them

### Milestone 3

Inspect the real stored document shape and lock:

- index or data stream name
- relevant fields
- time filtering strategy
- service filtering strategy
- pagination strategy

### Milestone 4

Implement the first `kibtrace fetch` command against that sandbox.

### Milestone 5

Export a deterministic fixture from the sandbox for CI and regression use.

## First `kibtrace fetch` Contract

The first real contract should look roughly like:

```bash
./scripts/kibtrace fetch \
  --es-url http://localhost:9200 \
  --index kibtrace-sandbox-* \
  --since 2026-04-09T09:00:00Z \
  --until 2026-04-09T09:15:00Z \
  --service cv-db-failure-app
```

Expected output:

- session directory under `.kibtrace/sessions/<id>/`
- fetch manifest
- raw page artifacts or raw hit snapshots
- normalized input handoff for `prepare`

## Out Of Scope

- Kibana UI click automation
- remote production clusters for `v0`
- Fleet-managed Elastic Agent for the first sandbox
- direct app-to-Elasticsearch logging as the primary realism path

Fleet-managed Elastic Agent can be added later as a higher-fidelity sandbox once the fetch and prepare contract is stable.
