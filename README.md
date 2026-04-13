# kibtrace

`kibtrace` turns Elasticsearch logs into a compact investigation bundle that Claude can use together with your codebase.

Instead of exporting large log files from Kibana and pasting noisy context into an LLM, you:

1. fetch the relevant log window
2. prepare a local investigation session
3. build a compact pack of evidence
4. let Claude inspect that session and connect it to the code

`kibtrace` is the log-side reduction layer. Claude is the reasoning layer.

## What it does

- fetches logs from Elasticsearch or OpenSearch
- stores a local investigation session under `.kibtrace/sessions/`
- groups repeated failures into evidence items
- extracts stack traces, trace timelines, and retry patterns
- ranks likely code locations
- produces a compact pack for Claude instead of raw log dumps

## What it does not do

- it does not replace Kibana
- it does not click through the Kibana UI
- it does not diagnose incidents by itself
- it does not persist your credentials in session artifacts

## Install

Requirements:

- Node.js `>= 22`
- Docker if you want to run the local demo stack

```bash
npm install
npm run build
```

Optional:

```bash
npm link
kibtrace --help
```

If you do not link it globally, use `./scripts/kibtrace` from the repo root.

## Quick Start

Fetch a log slice:

```bash
./scripts/kibtrace fetch \
  --es-url https://your-elastic-host:9200 \
  --index 'logs-*' \
  --since 2026-04-13T00:00:00Z \
  --until 2026-04-13T23:59:59Z \
  --api-key '<base64-api-key>'
```

Prepare the session against the repo you want Claude to inspect:

```bash
./scripts/kibtrace prepare --latest --repo .
```

Build the compact investigation pack:

```bash
./scripts/kibtrace pack --latest
```

Inspect one evidence item or the likely code origin if needed:

```bash
./scripts/kibtrace evidence --latest --id <evidence-id>
./scripts/kibtrace code-origin --latest
```

## Using With Claude Code

Open Claude Code in the same repo after you have prepared a session.

If `kibtrace` is on your `PATH`, Claude can call it directly. If not, use `./scripts/kibtrace`.

Prompt examples:

```text
Investigate the latest kibtrace session.

Use kibtrace as the log-side source of truth. Start with:
1. kibtrace pack --latest
2. inspect the top evidence item if needed
3. inspect code origin
4. then inspect the relevant repo files

Tell me:
- the most likely incident
- the most likely code origin
- the evidence supporting it
- any uncertainty
```

```text
Investigate kibtrace session <session-id>.

Use kibtrace as the log-side source of truth.
Start with:
1. kibtrace pack --session-id <session-id>
2. inspect the top evidence item if needed
3. inspect code origin
4. then inspect the relevant repo files

Tell me:
- the most likely incident
- the most likely code origin
- the evidence supporting it
- any uncertainty
```

```text
Investigate the latest kibtrace session and write a short team-ready incident report.

Use kibtrace as the log-side source of truth. Start with:
1. kibtrace pack --latest
2. inspect the strongest evidence item
3. inspect code origin
4. inspect only the repo files needed to explain the failure

Output:
- summary
- user impact
- likely root cause
- likely fix area
- evidence
- uncertainty
```

```text
Investigate the latest kibtrace session and verify whether the incident is rollout-specific.

Use kibtrace as the log-side source of truth. Start with:
1. kibtrace pack --latest
2. inspect the top evidence item
3. inspect code origin
4. compare the implicated code path with nearby versions, services, or migrations in the repo

Tell me:
- whether the issue is version-specific
- whether there is a migration/schema mismatch
- the exact code area most likely responsible
- the evidence supporting that conclusion
```

Minimal prompt:

```text
Investigate the latest kibtrace session with kibtrace as the log-side source of truth.
```

This repo also includes an optional Claude Code plugin scaffold under `plugins/kibtrace/`.

## Authentication

`fetch` currently supports:

- API key
- basic auth
- no auth

API key example:

```bash
export KIBTRACE_ES_API_KEY='<base64-api-key>'

./scripts/kibtrace fetch \
  --es-url https://your-elastic-host:9200 \
  --index 'logs-*' \
  --since 2026-04-13T00:00:00Z \
  --until 2026-04-13T23:59:59Z
```

Notes:

- the API key belongs to your Elastic cluster, not to `kibtrace`
- `kibtrace` stores only the auth mode in the session, not the credential value
- the local Docker demo uses Filebeat, which needs the decoded `id:key` form internally

## Local Demo

The repo includes a local multi-service demo that emits ECS-style logs into Elasticsearch and reproduces a rollout/schema-drift incident.

If you already have a local authenticated Elasticsearch from `elastic-start-local`, run:

```bash
npm run test:variant-b
```

That command:

- builds `kibtrace`
- starts the demo services
- waits for logs to arrive
- runs `fetch`
- runs `prepare`
- prints `pack`
- prints `code-origin`
- prints the Claude prompt to use next

Stop the demo stack with:

```bash
npm run test:variant-b:down
```

If your local `elastic-start-local` env file is not under `~/elastic-start-local/.env`, set:

```bash
export KIBTRACE_START_LOCAL_ENV=/full/path/to/elastic-start-local/.env
```

## CLI Surface

Main commands:

- `fetch`
- `prepare`
- `pack`
- `evidence`
- `code-origin`
- `query`
- `inspect`
- `correlate`
- `report`

Session selectors:

- `--latest`
- `--session-id <id>`
- `--session <path>`

Run `./scripts/kibtrace --help` for the full command surface.

## Repository Layout

- `src/` — CLI and investigation pipeline
- `plugins/kibtrace/` — optional Claude Code plugin scaffold
- `validation/seed-projects/` — sample applications used for local demos
- `validation/sandbox/` — Docker-based demo environments
- `validation/fixtures/` — expected outputs and fixtures for validation

## Current Fit

Best fit today:

- ECS-like application logs
- incidents with stack traces or trace ids
- repos available locally to Claude
- engineering investigations where you want a compact, reviewable intermediate artifact

Still evolving:

- richer retrieval from natural-language questions
- broader field-mapping configuration for non-ECS log shapes
- automated alert-to-investigation workflows
