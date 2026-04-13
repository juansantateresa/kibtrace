# Variant B Rollout Sandbox

This sandbox reproduces a rollout/schema-drift incident for `kibtrace`.

The demo application is a small multi-service computer-vision pipeline:

- frames enter the system normally
- inference succeeds
- detections are found
- only one persistence version fails
- the failing version writes to `detection_events_v2`
- the matching migration file exists in the repo but is not applied

Logs are emitted as structured JSON to container stdout and shipped to Elasticsearch with Filebeat.

## What this scenario is for

Use this sandbox to test the main `kibtrace` promise:

- reduce a noisy multi-service log stream into ranked evidence
- show whether the issue is version-specific
- point to the likely code origin
- give Claude enough structured context to connect the logs to the repo

## Requirements

- Docker and Docker Compose
- a running Elasticsearch instance
- an Elasticsearch API key

This repo is easiest to use with a local `elastic-start-local` installation, but any reachable Elasticsearch endpoint works if you wire the sandbox env manually.

## Quick Start

From the repo root:

```bash
npm run test:variant-b
```

That command:

- builds `kibtrace`
- starts this sandbox
- waits for logs to land in Elasticsearch
- runs `fetch`
- runs `prepare`
- prints `pack`
- prints `code-origin`
- prints the Claude prompt to use next

Stop the sandbox with:

```bash
npm run test:variant-b:down
```

If your local `elastic-start-local` env file is not under `~/elastic-start-local/.env`, set:

```bash
export KIBTRACE_START_LOCAL_ENV=/full/path/to/elastic-start-local/.env
```

## Manual Setup

If you want to run the sandbox without the helper script:

1. Copy `.env.example` to `.env`.
2. Set `ELASTICSEARCH_HOST` to the Elasticsearch host reachable from inside Docker.
3. Set `ELASTICSEARCH_API_KEY` to the decoded `id:key` form expected by Filebeat.
4. Start the stack.

```bash
cp validation/sandbox/variant-b-rollout/.env.example \
  validation/sandbox/variant-b-rollout/.env

cd validation/sandbox/variant-b-rollout
docker compose up --build -d
```

Verify that logs are landing:

```bash
curl -s -H "Authorization: ApiKey <base64-api-key>" \
  'http://127.0.0.1:9200/kibtrace-auth-variant-b-*/_count'
```

## Running kibtrace Manually

From the repo root:

```bash
./scripts/kibtrace fetch \
  --es-url http://127.0.0.1:9200 \
  --index 'kibtrace-auth-variant-b-*' \
  --since 2026-04-13T00:00:00Z \
  --until 2026-04-13T23:59:59Z \
  --api-key '<base64-api-key>'

./scripts/kibtrace prepare --latest \
  --repo validation/seed-projects/cv-rollout-schema-drift

./scripts/kibtrace pack --latest
./scripts/kibtrace evidence --latest --id <evidence-id>
./scripts/kibtrace code-origin --latest
```

## Authentication Notes

- `kibtrace fetch` expects the base64 API key form used by the Elastic HTTP API
- Filebeat expects the decoded `id:key` form inside the sandbox `.env`
- the helper script handles that conversion automatically when it reads from `elastic-start-local`

## Expected Outcome

The expected shape of the investigation is:

- top incident around `relation "detection_events_v2" does not exist`
- likely code origin under `services/event-persistor-v2/index.js`
- trace evidence showing healthy upstream stages followed by persistence failure
- evidence that the issue is specific to the broken persistence version, not the whole pipeline

## Files

- sandbox config: [docker-compose.yml](/Users/juansantateresagomez/kibanaskill/validation/sandbox/variant-b-rollout/docker-compose.yml)
- Filebeat config: [filebeat/filebeat.yml](/Users/juansantateresagomez/kibanaskill/validation/sandbox/variant-b-rollout/filebeat/filebeat.yml)
- seed project: [validation/seed-projects/cv-rollout-schema-drift/](/Users/juansantateresagomez/kibanaskill/validation/seed-projects/cv-rollout-schema-drift)
- expected outputs: [validation/fixtures/expected/variant-b-rollout/](/Users/juansantateresagomez/kibanaskill/validation/fixtures/expected/variant-b-rollout)
