# Variant B Rollout Sandbox

Ships logs from the cv-rollout-schema-drift seed project to an external
Elasticsearch instance via Filebeat.

## Canonical path

Run this from the repo root:

```bash
npm run test:variant-b
```

That is the canonical local test for this scenario. It builds `kibtrace`,
hydrates this sandbox's `.env`, starts the containers, waits for logs,
fetches the log slice, prepares the session, prints `pack`, prints
`code-origin`, and gives you the next Claude prompt.

Teardown:

```bash
npm run test:variant-b:down
```

## Prerequisites

- Docker and Docker Compose
- A running Elasticsearch instance (e.g. from `elastic-start-local`)
- An API key for Elasticsearch

## Manual setup

1. Copy `.env.example` to `.env` and fill in your Elasticsearch API key:

```bash
cp .env.example .env
# Edit .env — set ELASTICSEARCH_API_KEY to your decoded id:key
```

**Auth note:** Filebeat uses the decoded `id:key` format. `kibtrace fetch`
uses the base64-encoded form via `KIBTRACE_ES_API_KEY` env var or `--api-key`.

2. Start the stack:

```bash
docker compose up --build -d
```

3. Wait ~2 minutes for all frames to be emitted (500 frames at 200ms each).

4. Verify logs landed in Elasticsearch:

```bash
curl -s -H "Authorization: ApiKey $(echo -n 'YOUR_DECODED_ID:KEY' | base64)" \
  'http://127.0.0.1:9200/kibtrace-auth-variant-b-*/_count' | jq .
```

## Manual kibtrace flow

```bash
# Fetch logs
./scripts/kibtrace fetch \
  --es-url http://127.0.0.1:9200 \
  --index 'kibtrace-auth-variant-b-*' \
  --since 2026-04-12T00:00:00Z \
  --until 2026-04-12T23:59:59Z \
  --api-key "$KIBTRACE_ES_API_KEY"

# Prepare session
./scripts/kibtrace prepare --latest --repo validation/seed-projects/cv-rollout-schema-drift

# Claude-facing summary
./scripts/kibtrace pack --latest

# Drill down if needed
./scripts/kibtrace evidence --latest --id <top-evidence-id>
./scripts/kibtrace code-origin --latest
```

## Teardown

```bash
docker compose down -v
```

## Index prefix

- Authenticated: `kibtrace-auth-variant-b-*`
- No-auth fallback: change `ELASTICSEARCH_INDEX_PREFIX` to `kibtrace-variant-b`
  and remove `api_key` from `.env`
