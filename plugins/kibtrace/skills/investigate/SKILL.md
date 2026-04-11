---
name: investigate
description: Investigate the latest kibtrace session and produce a concise incident report. Use when the user wants root-cause triage from Elastic/Kibana logs through kibtrace.
---

# Investigate

Use kibtrace as the source of truth for incident triage. The CLI produces ranked
evidence; your job is to interpret it and write a tight incident report.

## When to use this skill

- The user asks to triage an incident, debug a failure, or find the root cause
  of something visible in logs
- A kibtrace session has already been prepared, or the user is willing to run
  `kibtrace fetch` and `kibtrace prepare`
- The user wants a code-aware answer, not just a raw log dump

## Command resolution

Before running any command in this skill:

- Prefer `kibtrace` if it is available on `PATH`
- If it is not, use `./scripts/kibtrace` from the repo root instead

Apply this substitution to every `kibtrace ...` example below.

## Workflow

Run these in order. Stop earlier if the answer is already obvious.

1. **Start with the one-call summary.** This is the primary entrypoint:
   ```sh
   kibtrace query --latest --view incident-summary
   ```
   It returns the top 3 evidence items, top code candidates, key trace IDs,
   and ranked hypotheses. In most cases this is enough to draft the report.

2. **Drill into the top evidence item:**
   ```sh
   kibtrace query --latest --view evidence --id <top-evidence-id>
   ```
   Use the `id` of the first item from `topEvidence` in step 1. This returns
   full citations, stack frames, and code candidates for that item.

3. **Confirm the code origin:**
   ```sh
   kibtrace query --latest --view code-candidates
   ```
   Reads the ranked list of `path:line` locations. The top entry is usually
   the exact failing function.

4. **Optional: pull the full markdown report** for narrative confirmation:
   ```sh
   kibtrace report --latest
   ```

## Session selectors

Always prefer `--latest`. Use `--session-id <id>` or `--session <path>` only if
the user explicitly names a session.

If `--latest` errors with "No sessions found", tell the user to run
`kibtrace fetch` followed by `kibtrace prepare --latest --repo .`. Do not guess
at the cause.

## What to write

After the workflow, produce a concise incident report with these sections:

- **Likely failure** — one sentence, derived from `incident-summary.summary` or
  the top evidence item's title.
- **Likely code origin** — the top entry from `topCodeCandidates`, formatted as
  `path:line`.
- **Strongest evidence** — 2–4 bullets quoting `signals` from the top evidence
  item.
- **Residual uncertainty** — counter-evidence from the top hypothesis, or
  "none observed" if there is none.

Aim for under 200 words total. The user can always ask for more.

## Guardrails

- **Prefer `incident-summary` over low-level cluster views.** Use `clusters`,
  `cluster`, `trace`, `latest-errors`, and `service` only when you need to
  drill into a specific anomaly that the high-level views did not explain.
- **Do not guess.** Every claim in the report must be backed by output from a
  kibtrace command you actually ran. If kibtrace says nothing about something,
  say so explicitly.
- **The CLI output is the source of truth.** Do not invent file paths, scores,
  trace IDs, or stack frames that were not in the kibtrace response.
- **Stay concise and actionable.** This report is for engineers on call, not a
  blog post.
