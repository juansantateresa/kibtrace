import type { SessionArtifact } from "../evidence/session.js";

export function renderReportJson(session: SessionArtifact): SessionArtifact {
  return session;
}

export function renderMarkdownReport(session: SessionArtifact): string {
  const lines: string[] = [];
  const evidence = session.evidence;
  const correlation = session.correlation;
  const hypotheses = session.hypotheses ?? [];

  lines.push("# Kibtrace Investigation Report");
  lines.push("");

  // --- Summary ---
  lines.push("## Summary");
  lines.push("");
  lines.push(`| Field | Value |`);
  lines.push(`|-------|-------|`);
  lines.push(`| Session | \`${session.sessionId}\` |`);
  lines.push(`| Created | ${session.createdAt} |`);
  lines.push(`| Source mode | \`${session.sourceMode}\` |`);

  if (session.sourceMode === "elastic" && session.fetch) {
    lines.push(`| ES URL | \`${session.fetch.esUrl}\` |`);
    lines.push(`| Index pattern | \`${session.fetch.indexPattern}\` |`);
    if (session.fetch.since) lines.push(`| Since | ${session.fetch.since} |`);
    if (session.fetch.until) lines.push(`| Until | ${session.fetch.until} |`);
    if (session.fetch.service) lines.push(`| Service | ${session.fetch.service} |`);
    lines.push(`| Fetched hits | ${session.fetch.fetchedHits} |`);
    lines.push(`| Total hits | ${session.fetch.totalHits ?? "unknown"} |`);
    lines.push(`| Pages | ${session.fetch.pageCount} |`);
  } else {
    lines.push(`| Logs path | \`${session.input.logsPath ?? "-"}\` |`);
  }

  lines.push(`| Repo path | \`${session.input.repoPath ?? "-"}\` |`);
  if (evidence) {
    lines.push(`| Source artifacts | ${evidence.discoveredArtifacts.length} |`);
    lines.push(`| Normalized events | ${evidence.normalizedEvents} |`);
    lines.push(`| Clusters | ${evidence.clusters.length} |`);
  }
  lines.push(`| Hypotheses | ${hypotheses.length} |`);
  lines.push("");

  // --- Clusters ---
  lines.push("## Clusters");
  lines.push("");

  const clusters = evidence?.clusters ?? [];
  if (clusters.length === 0) {
    lines.push("No clusters found.");
  } else {
    for (const cluster of clusters) {
      lines.push(`### ${cluster.id}: ${cluster.summary}`);
      lines.push("");
      lines.push(`- **Fingerprint:** \`${cluster.fingerprint}\``);
      lines.push(`- **Count:** ${cluster.count}`);
      const fileList = cluster.sourceFiles.slice(0, 5).map((f) => `\`${f}\``).join(", ");
      lines.push(`- **Sources (top):** ${fileList}`);

      const levelEntries = Object.entries(cluster.levels);
      if (levelEntries.length > 0) {
        lines.push(`- **Level breakdown:** ${levelEntries.map(([l, c]) => `${l}=${c}`).join(", ")}`);
      }

      if (cluster.representativeExcerpts.length > 0) {
        lines.push("");
        lines.push("**Representative excerpts:**");
        lines.push("");
        lines.push("```");
        for (const excerpt of cluster.representativeExcerpts) {
          lines.push(excerpt);
        }
        lines.push("```");
      }
      lines.push("");
    }
  }

  // --- Hypotheses ---
  lines.push("## Hypotheses");
  lines.push("");

  if (hypotheses.length === 0) {
    lines.push("No hypotheses generated.");
  } else {
    for (const hyp of hypotheses) {
      lines.push(`### ${hyp.id} [${hyp.confidence.toUpperCase()}]`);
      lines.push("");
      lines.push(`> ${hyp.summary}`);
      lines.push("");

      if (hyp.supportingSignals.length > 0) {
        lines.push("**Supporting signals:**");
        for (const s of hyp.supportingSignals) {
          lines.push(`- ${s}`);
        }
        lines.push("");
      }

      if (hyp.counterEvidence.length > 0) {
        lines.push("**Counter-evidence:**");
        for (const c of hyp.counterEvidence) {
          lines.push(`- ${c}`);
        }
        lines.push("");
      }
    }
  }

  // --- Code Correlation ---
  lines.push("## Code Correlation");
  lines.push("");

  const codeAreas = correlation?.probableCodeAreas ?? [];
  if (codeAreas.length === 0) {
    lines.push("No code areas correlated.");
  } else {
    lines.push("| File | Reason | Symbol | Line |");
    lines.push("|------|--------|--------|------|");
    for (const area of codeAreas) {
      const symbol = area.symbol ?? "-";
      const line = area.line != null ? String(area.line) : "-";
      lines.push(`| \`${area.path}\` | ${area.reason} | ${symbol} | ${line} |`);
    }
    lines.push("");
  }

  // --- Suggested Owners ---
  lines.push("## Suggested Owners");
  lines.push("");
  const owners = correlation?.suggestedOwners ?? [];
  lines.push(owners.length > 0 ? owners.map((o) => `- ${o}`).join("\n") : "_(none)_");
  lines.push("");

  // --- Source Artifacts ---
  lines.push("## Source Artifacts");
  lines.push("");
  const artifacts = evidence?.discoveredArtifacts ?? [];
  if (artifacts.length === 0) {
    lines.push("_(none)_");
  } else {
    for (const f of artifacts.slice(0, 20)) {
      lines.push(`- \`${f}\``);
    }
    if (artifacts.length > 20) {
      lines.push(`- _(... ${artifacts.length - 20} more)_`);
    }
  }
  lines.push("");

  lines.push("---");
  lines.push("*Generated by kibtrace v0.3.0*");
  lines.push("");

  return lines.join("\n");
}
