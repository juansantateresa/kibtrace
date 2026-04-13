# kibtrace

`kibtrace` is an Elastic-to-code incident investigation CLI for Claude Code workflows.

It fetches logs from Elasticsearch or OpenSearch, reduces them into ranked evidence, correlates that evidence with source code, and returns a compact investigation surface that Claude can actually use.

## What it does

- fetches logs directly from Elasticsearch or OpenSearch
- prepares a local investigation session under `.kibtrace/sessions/`
- extracts ranked evidence such as error clusters, trace timelines, stack groups, and retry chains
- correlates evidence with likely code locations
- exposes Claude-friendly query views like `incident-summary`, `evidence`, and `code-candidates`
- renders a markdown investigation report

## What it is not

- not a Kibana UI automation tool
- not a generic SIEM or dashboard product
- not an LLM by itself

Kibana remains the human UI. `kibtrace` uses Elasticsearch as the machine interface.

## Status

Current repo version: `0.4.0`

Best fit today:

- application and service logs
- ECS-like structured logs
- stack traces
- trace-oriented failures
- incidents where source code is available locally

Current flagship scenario:

- a CV pipeline detects people successfully
- persistence fails downstream
- logs prove the failure and `kibtrace` maps it back to code

See [validation/sandbox/README.md](/Users/juansantateresagomez/kibanaskill/validation/sandbox/README.md) for the local validation environment.

## Install From Source

Prerequisites:

- Node.js `>= 22`
- Docker Desktop if you want the local Elastic sandbox

Build the CLI:

```bash
npm install
npm run build
./scripts/kibtrace --help
```

If you want a bare `kibtrace` command on your machine while developing:

```bash
npm link
kibtrace --help
```

## Quick Start

### 1. Start the local sandbox

```bash
cp validation/sandbox/elastic-stack/.env.example validation/sandbox/elastic-stack/.env
cd validation/sandbox/elastic-stack
docker compose up --build -d
cd ../../..
```

This starts:

- Elasticsearch
- Kibana
- Filebeat
- Postgres
- `cv-db-failure-app`

The fake app writes ECS-style NDJSON logs, Filebeat ships them, and `kibtrace` fetches from Elasticsearch directly.

### 2. Fetch a session

```bash
./scripts/kibtrace fetch \
  --es-url http://127.0.0.1:9200 \
  --index 'kibtrace-sandbox-*' \
  --since 2026-04-11T00:00:00Z \
  --until 2026-04-11T23:59:59Z \
  --service cv-db-failure-app \
  --max-hits 100
```

### 3. Prepare the latest session

```bash
./scripts/kibtrace prepare --latest \
  --repo validation/seed-projects/cv-db-failure-app
```

### 4. Inspect the investigation surface

```bash
./scripts/kibtrace query --latest --view incident-summary
./scripts/kibtrace query --latest --view code-candidates
./scripts/kibtrace report --latest
```

Expected outcome in the sandbox:

- top incident: `relation "detection_events_v2" does not exist`
- top code candidate: `src/index.js:155`

## CLI Workflow

Main commands:

- `fetch`
- `prepare`
- `query`
- `inspect`
- `correlate`
- `report`

Session selectors:

- `--latest`
- `--session-id <id>`
- `--session <path>`

Useful query views:

- `incident-summary`
  Best first call for Claude or a human. Returns the top evidence, top code candidates, key traces, and ranked hypotheses.
- `top-evidence`
  Ranked evidence headers only.
- `evidence --id <evidence-id>`
  Full detail for one evidence item.
- `code-candidates`
  Ranked file and line candidates.
- `clusters`
  Low-level debug view.
- `trace --trace <id>`
  Single trace lifecycle.

Run `./scripts/kibtrace --help` for the full surface.

## Claude Code Workflow

`kibtrace` is meant to prepare evidence for Claude, not to replace Claude.

Recommended manual prompt:

```text
Investigate the latest kibtrace session using kibtrace commands.
Start with incident-summary, then inspect the top evidence item and code candidates.
Write a concise incident report with likely failure, code origin, strongest evidence, and residual uncertainty.
```

This repo also includes a thin Claude Code plugin scaffold:

- [plugins/kibtrace/.claude-plugin/plugin.json](/Users/juansantateresagomez/kibanaskill/plugins/kibtrace/.claude-plugin/plugin.json)
- [plugins/kibtrace/skills/investigate/SKILL.md](/Users/juansantateresagomez/kibanaskill/plugins/kibtrace/skills/investigate/SKILL.md)
- [plugins/kibtrace/skills/report/SKILL.md](/Users/juansantateresagomez/kibanaskill/plugins/kibtrace/skills/report/SKILL.md)

Local test:

```bash
claude --plugin-dir ./plugins/kibtrace
```

Then inside Claude Code:

```text
/help
/kibtrace:investigate
/kibtrace:report
```

If `kibtrace` is not on `PATH`, the plugin skills fall back to `./scripts/kibtrace`.

## Auth For Secured Elastic Clusters

The local sandbox runs with security disabled, so it does not need credentials.

For a real secured Elastic deployment, use an Elasticsearch API key:

```bash
export KIBTRACE_ES_API_KEY='your-elastic-api-key'

./scripts/kibtrace fetch \
  --es-url https://your-elastic-host:9200 \
  --index 'logs-*' \
  --since 2026-04-11T00:00:00Z \
  --until 2026-04-11T23:59:59Z
```

Notes:

- the API key belongs to Elastic, not to `kibtrace`
- `kibtrace` does not persist the secret
- sessions only record `authMode`, not the key value

## Validation Assets

This repo includes:

- a realistic local Elastic sandbox under [validation/sandbox/](/Users/juansantateresagomez/kibanaskill/validation/sandbox)
- seed app code under [validation/seed-projects/cv-db-failure-app/](/Users/juansantateresagomez/kibanaskill/validation/seed-projects/cv-db-failure-app)
- file fixtures under [validation/fixtures/logs/](/Users/juansantateresagomez/kibanaskill/validation/fixtures/logs)

A multi-service rollout schema drift scenario is also available:

- seed project: [validation/seed-projects/cv-rollout-schema-drift/](/Users/juansantateresagomez/kibanaskill/validation/seed-projects/cv-rollout-schema-drift)
- sandbox: [validation/sandbox/variant-b-rollout/](/Users/juansantateresagomez/kibanaskill/validation/sandbox/variant-b-rollout)

This scenario runs five services where a v2 persistor fails due to an unapplied migration, while v1 traffic succeeds. It validates that `kibtrace` correctly surfaces partial-failure rollout incidents.

These are for validation and regression testing. They are not part of the published runtime surface.

## Current Limitations

- local sandbox validates the no-auth Elastic flow, not API-key auth
- best results come from structured ECS-like application logs
- code correlation is strongest when stack traces include app frames
- `--latest` is cwd-relative, so it resolves sessions under the current project directory

## Development

Useful commands:

```bash
npm run build
npm run typecheck
./scripts/kibtrace --help
```

The wrapper script uses the local build in `dist/`. Rebuild after TypeScript changes.
