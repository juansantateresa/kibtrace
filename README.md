# kibtrace

`kibtrace` helps engineers investigate production incidents from Elasticsearch logs without downloading GBs of raw data.

It fetches the relevant log slice, reduces it into ranked evidence, points to likely code locations, and gives Claude a compact context pack to reason over.

## Why it exists

Typical workflow today:

- open Kibana
- search manually
- export too many logs
- grep or script locally
- ask Claude with messy context

`kibtrace` is meant to replace that with:

1. `fetch`
2. `prepare`
3. `pack`
4. Claude investigates with code context

Kibana stays the human UI. `kibtrace` talks to Elasticsearch directly.

## What it does

- fetches logs from Elasticsearch or OpenSearch
- stores a local investigation session under `.kibtrace/sessions/`
- extracts evidence such as repeated errors, trace timelines, stack groups, and retry patterns
- correlates evidence with likely code locations
- returns a compact pack for Claude

## What it does not do

- it does not automate Kibana clicks
- it is not a generic SIEM
- it is not an LLM by itself

## Install From Source

Prerequisites:

- Node.js `>= 22`
- Docker if you want to run the local validation scenarios

```bash
npm install
npm run build
./scripts/kibtrace --help
```

Optional:

```bash
npm link
kibtrace --help
```

## Core Workflow

### 1. Fetch logs

```bash
./scripts/kibtrace fetch \
  --es-url http://127.0.0.1:9200 \
  --index 'logs-*' \
  --since 2026-04-13T00:00:00Z \
  --until 2026-04-13T23:59:59Z \
  --max-hits 1000
```

### 2. Prepare evidence

```bash
./scripts/kibtrace prepare --latest --repo .
```

### 3. Build the Claude-ready pack

```bash
./scripts/kibtrace pack --latest
```

### 4. Inspect details if needed

```bash
./scripts/kibtrace evidence --latest --id <evidence-id>
./scripts/kibtrace code-origin --latest
```

`pack` is the preferred command for Claude-facing workflows.

## Claude Workflow

Recommended prompt:

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

This repo also includes a local Claude Code plugin scaffold:

- [plugins/kibtrace/.claude-plugin/plugin.json](/Users/juansantateresagomez/kibanaskill/plugins/kibtrace/.claude-plugin/plugin.json)
- [plugins/kibtrace/skills/investigate/SKILL.md](/Users/juansantateresagomez/kibanaskill/plugins/kibtrace/skills/investigate/SKILL.md)
- [plugins/kibtrace/skills/report/SKILL.md](/Users/juansantateresagomez/kibanaskill/plugins/kibtrace/skills/report/SKILL.md)

Local plugin test:

```bash
claude --plugin-dir ./plugins/kibtrace
```

## Auth

Supported fetch auth modes:

- API key
- basic auth
- no auth

API key example:

```bash
export KIBTRACE_ES_API_KEY='your-base64-elastic-api-key'

./scripts/kibtrace fetch \
  --es-url https://your-elastic-host:9200 \
  --index 'logs-*' \
  --since 2026-04-13T00:00:00Z \
  --until 2026-04-13T23:59:59Z
```

Notes:

- the API key belongs to Elastic, not to `kibtrace`
- `kibtrace` does not persist credentials
- sessions store only `authMode`

## Local Validation

There are two validation paths in this repo, but only one should be treated as the canonical end-to-end test.

### Basic sandbox

Single-service local validation:

- [validation/sandbox/elastic-stack/](/Users/juansantateresagomez/kibanaskill/validation/sandbox/elastic-stack)
- [validation/seed-projects/cv-db-failure-app/](/Users/juansantateresagomez/kibanaskill/validation/seed-projects/cv-db-failure-app)

Use this for fast smoke testing.

### Variant B realistic scenario

Multi-service rollout/schema-drift validation:

- sandbox: [validation/sandbox/variant-b-rollout/](/Users/juansantateresagomez/kibanaskill/validation/sandbox/variant-b-rollout)
- seed repo: [validation/seed-projects/cv-rollout-schema-drift/](/Users/juansantateresagomez/kibanaskill/validation/seed-projects/cv-rollout-schema-drift)

This is the realistic test case for the actual product promise:

- healthy upstream pipeline
- only `v2` persistence fails
- rollout skew visible in logs
- Claude must connect `kibtrace` evidence with repo code and migration context

Canonical local test:

```bash
npm run test:variant-b
```

That single command:

- builds `kibtrace`
- hydrates the Variant B sandbox from your local `elastic-start-local` env
- starts the sandbox containers
- waits for logs to land in Elasticsearch
- runs `fetch`
- runs `prepare`
- prints `pack`
- prints `code-origin`
- prints the exact Claude prompt to use next

Teardown:

```bash
npm run test:variant-b:down
```

If your `elastic-start-local` installation is not under `~/elastic-start-local/.env`, set:

```bash
export KIBTRACE_START_LOCAL_ENV=/full/path/to/elastic-start-local/.env
```

## Current CLI Surface

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

Run `./scripts/kibtrace --help` for the full surface.

## Current Status

Best fit today:

- ECS-like application logs
- incidents with stack traces or trace ids
- codebases available locally to Claude
- Elastic-backed investigation workflows

Still evolving:

- retrieval by natural-language question
- richer semantic enrichment
- alert-driven auto-triage

## Development

Useful commands:

```bash
npm run build
npm run typecheck
./scripts/kibtrace --help
```
