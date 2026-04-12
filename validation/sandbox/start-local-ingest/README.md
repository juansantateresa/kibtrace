# start-local Authenticated Ingest Scaffold

Validation scaffold that ships fake app logs into an external,
authenticated Elastic start-local instance. This is **not** production
runtime code.

## Prerequisites

- Docker and Docker Compose
- Elastic start-local already running (`http://localhost:9200` with security enabled)
- kibtrace built (`npm run build` from repo root)

## Setup

1. Copy the example env and fill in the API key:

   ```sh
   cp .env.example .env
   ```

2. Open `.env` and set `ELASTICSEARCH_API_KEY` to the **decoded** `id:key`
   form of your start-local API key. Filebeat requires this format.

   To decode the base64 key from `elastic-start-local/.env`:

   ```sh
   echo '<ES_LOCAL_API_KEY value>' | base64 -d
   ```

   Paste the resulting `id:key` string into `ELASTICSEARCH_API_KEY`.

3. Start the ingest scaffold:

   ```sh
   docker compose up --build -d
   ```

4. Wait ~10 seconds for logs to start flowing, then verify docs landed.
   Use the **base64** key for curl (the `Authorization: ApiKey` header
   expects base64):

   ```sh
   curl -s -H "Authorization: ApiKey <ES_LOCAL_API_KEY base64>" \
     "http://127.0.0.1:9200/kibtrace-auth-sandbox-*/_count" | jq .
   ```

   You should see `"count"` > 0.

## Running kibtrace against the authenticated index

From the repo root, export the **base64** key (kibtrace sends it as
`Authorization: ApiKey <base64>`):

```sh
export KIBTRACE_ES_API_KEY='<ES_LOCAL_API_KEY base64>'

./scripts/kibtrace fetch \
  --es-url http://127.0.0.1:9200 \
  --index 'kibtrace-auth-sandbox-*' \
  --since 2026-04-11T00:00:00Z \
  --until 2026-04-12T23:59:59Z \
  --service cv-db-failure-app \
  --max-hits 100

./scripts/kibtrace prepare --latest --repo validation/seed-projects/cv-db-failure-app
./scripts/kibtrace query --latest --view incident-summary
./scripts/kibtrace report --latest
```

## Teardown

```sh
docker compose down -v
```
