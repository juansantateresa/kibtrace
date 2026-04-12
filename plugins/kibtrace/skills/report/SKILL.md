---
name: report
description: Produce a team-ready incident report from a prepared kibtrace session. Use when the investigation is mostly done and the user wants a clean writeup to share.
---

# Report

Write a short, team-oriented incident report from a prepared kibtrace session.
Assume the heavy investigation is already done — your job is the writeup, not
the triage.

## When to use this skill

- A kibtrace session has been prepared and the cause is roughly understood
- The user wants a one-page summary to share with a wider team
- No deep drilldown is needed; if it is, use the `investigate` skill instead

## Command resolution

Before running any command in this skill:

- Prefer `kibtrace` if it is available on `PATH`
- If it is not, use `./scripts/kibtrace` from the repo root instead

Apply this substitution to every `kibtrace ...` example below.

## Workflow

1. **Pull the summary.** This is usually all you need:
   ```sh
   kibtrace query --latest --view incident-summary
   ```

2. **Optional: pull the markdown report** for extra confirmation or section
   structure:
   ```sh
   kibtrace report --latest
   ```

That is the entire workflow. Do not run additional drilldown commands unless
the summary is missing something the user asked for.

## What to write

Produce a concise team-facing report with these sections:

- **Incident summary** — one or two sentences naming what failed and where.
- **Probable root cause** — the top hypothesis from `incident-summary`.
- **Likely code origin** — the top entry from `topCodeCandidates`, formatted as
  `path:line`.
- **Strongest evidence** — 2–3 bullets citing `signals` or trace IDs from the
  top evidence item.
- **Remaining uncertainty** — counter-evidence from the top hypothesis, or
  "none observed".

Aim for one page, no more.

## Guardrails

- **Do not over-expand into raw logs** unless the user explicitly asks for
  them. If they want deep drilldown they will use the `investigate` skill.
- **Keep it team-oriented.** Skip engineer-only debug language; this report is
  for a wider audience.
- **Prefer concise communication.** When in doubt, cut.
- **Cite kibtrace.** Every factual claim must come from a kibtrace command you
  actually ran.
