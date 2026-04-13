# Variant B Rollout Sandbox

Ships logs from the cv-rollout-schema-drift seed project to an external
Elasticsearch instance via Filebeat.

## Prerequisites

- Docker and Docker Compose
- A running Elasticsearch instance (e.g. from `elastic-start-local`)
- An API key for Elasticsearch

## Setup

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

## Running kibtrace

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

# Investigate
./scripts/kibtrace query --latest --view incident-summary
./scripts/kibtrace query --latest --view evidence --id <top-evidence-id>
./scripts/kibtrace query --latest --view code-candidates
```

## Teardown

```bash
docker compose down -v
```

## Index prefix

- Authenticated: `kibtrace-auth-variant-b-*`
- No-auth fallback: change `ELASTICSEARCH_INDEX_PREFIX` to `kibtrace-variant-b`
  and remove `api_key` from `.env`
