import type { SessionArtifact } from "../evidence/session.js";

export function renderReportJson(session: SessionArtifact): SessionArtifact {
  return session;
}

export function renderMarkdownReport(session: SessionArtifact): string {
  const hypothesis = session.hypotheses[0];

  return `# Kibtrace Report

## Summary

- Session: \`${session.sessionId}\`
- Logs path: \`${session.input.logsPath}\`
- Repo path: \`${session.input.repoPath}\`
- Discovered log files: ${session.evidence.discoveredLogFiles.length}
- Clusters: ${session.evidence.clusters.length}

## Top Hypothesis

- Summary: ${hypothesis?.summary ?? "No hypotheses available."}
- Confidence: ${hypothesis?.confidence ?? "low"}

## Probable Code Areas

${(hypothesis?.probableCodeAreas ?? [])
  .map((item) => `- \`${item.path}\`: ${item.reason}`)
  .join("\n")}

## Notes

This is the initial scaffold report. The deterministic package contract exists, but the investigation logic is still placeholder-level.
`;
}

