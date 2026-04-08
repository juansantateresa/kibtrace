---
name: kibtrace-investigator
description: Use this skill when investigating Kibana or OpenSearch log exports against the local codebase to find the likely code origin, likely owner, or a concise team-facing incident report.
---

# Kibtrace Investigator

Use this skill when the user wants to investigate a large log export against the current repository.

## Workflow

1. Confirm the location of the log input and the repo context.
2. Run `./scripts/kibtrace prepare --logs <path> --repo <path>`.
3. Inspect the generated session artifact and reports.
4. If needed, run:
   - `./scripts/kibtrace inspect --session <session.json>`
   - `./scripts/kibtrace correlate --session <session.json>`
   - `./scripts/kibtrace report --session <session.json>`
5. Read the most relevant source files before making code-origin claims.
6. Keep confidence conservative. Prefer "most likely" over false certainty.

## Current Limits

- The current package is scaffold-level and does not yet perform deep domain-specific analysis.
- Treat the generated artifacts as structured placeholders until the evidence pipeline is implemented.

