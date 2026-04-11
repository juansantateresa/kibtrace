import type { SessionArtifact } from "../evidence/session.js";
import type { CodeCandidate, EvidenceItem } from "../types.js";

export function renderReportJson(session: SessionArtifact): SessionArtifact {
  return session;
}

function severityTag(item: EvidenceItem): string {
  return `[${item.severity.toUpperCase()}]`;
}

function formatCodeCandidate(c: CodeCandidate): string {
  const loc = c.line !== undefined ? `:${c.line}` : "";
  const sym = c.symbol ? ` (${c.symbol})` : "";
  return `\`${c.path}${loc}\`${sym}`;
}

export function renderMarkdownReport(session: SessionArtifact): string {
  const lines: string[] = [];
  const evidence = session.evidence;
  const hypotheses = session.hypotheses ?? [];
  const items = evidence?.items ?? [];
  const codeCandidates = evidence?.topCodeCandidates ?? [];

  lines.push("# Kibtrace Investigation Report");
  lines.push("");

  // ---------- 1. Likely Incident ----------
  lines.push("## Likely Incident");
  lines.push("");

  const topHypothesis = hypotheses[0];
  const topItem = items[0];

  if (topHypothesis) {
    lines.push(`> **${topHypothesis.summary}**`);
    lines.push(`> _confidence: ${topHypothesis.confidence}_`);
    lines.push("");
  } else if (topItem) {
    lines.push(`> **${topItem.title}**`);
    lines.push(`> _severity: ${topItem.severity}_`);
    lines.push("");
  } else {
    lines.push("_No incident-shaped evidence found in this session._");
    lines.push("");
  }

  if (topHypothesis && topHypothesis.supportingSignals.length > 0) {
    lines.push("**Why this conclusion**");
    for (const s of topHypothesis.supportingSignals.slice(0, 4)) {
      lines.push(`- ${s}`);
    }
    lines.push("");
  }

  // ---------- 2. Top Evidence ----------
  lines.push("## Top Evidence");
  lines.push("");

  if (items.length === 0) {
    lines.push("_No evidence items extracted._");
    lines.push("");
  } else {
    for (let i = 0; i < Math.min(items.length, 5); i++) {
      const item = items[i]!;
      lines.push(`### ${i + 1}. ${item.title} ${severityTag(item)}`);
      lines.push("");
      lines.push(`- **Kind:** \`${item.kind}\``);
      lines.push(`- **Score:** ${item.score}`);
      lines.push(`- **Summary:** ${item.summary}`);
      if (item.signals.length > 0) {
        lines.push(`- **Signals:** ${item.signals.slice(0, 5).join("; ")}`);
      }
      if (item.relatedTraceIds && item.relatedTraceIds.length > 0) {
        lines.push(`- **Related traces:** ${item.relatedTraceIds.slice(0, 3).map((t) => `\`${t}\``).join(", ")}`);
      }
      if (item.codeCandidates && item.codeCandidates.length > 0) {
        const top = item.codeCandidates[0]!;
        lines.push(`- **Code candidate:** ${formatCodeCandidate(top)}`);
      }
      lines.push("");
    }
  }

  // ---------- 3. Likely Code Origin ----------
  lines.push("## Likely Code Origin");
  lines.push("");

  if (codeCandidates.length === 0) {
    lines.push("_No code candidates correlated._");
    lines.push("");
  } else {
    lines.push("| Rank | File | Score | Reason |");
    lines.push("|------|------|-------|--------|");
    for (let i = 0; i < Math.min(codeCandidates.length, 10); i++) {
      const c = codeCandidates[i]!;
      const where = c.line !== undefined ? `\`${c.path}:${c.line}\`` : `\`${c.path}\``;
      lines.push(`| ${i + 1} | ${where} | ${c.score} | ${c.reason} |`);
    }
    lines.push("");
  }

  // ---------- 4. Representative Traces ----------
  lines.push("## Representative Traces");
  lines.push("");

  const traceItems = items.filter((it) => it.kind === "trace-timeline").slice(0, 3);
  if (traceItems.length === 0) {
    lines.push("_No trace timelines extracted._");
    lines.push("");
  } else {
    for (const t of traceItems) {
      const tid = t.relatedTraceIds?.[0] ?? "(unknown)";
      lines.push(`- **\`${tid}\`** — ${t.summary}`);
    }
    lines.push("");
  }

  // ---------- 5. Supporting Citations ----------
  lines.push("## Supporting Citations");
  lines.push("");

  const citationsSeen = new Set<string>();
  let citationCount = 0;
  for (const item of items.slice(0, 5)) {
    for (const c of item.citations) {
      if (citationsSeen.has(c.eventId)) continue;
      citationsSeen.add(c.eventId);
      const ts = c.timestamp ?? "";
      const trace = c.traceId ? ` trace=\`${c.traceId.slice(0, 12)}…\`` : "";
      lines.push(`- \`${c.eventId}\` ${ts}${trace} — ${c.sourceFile}`);
      citationCount += 1;
      if (citationCount >= 10) break;
    }
    if (citationCount >= 10) break;
  }
  if (citationCount === 0) lines.push("_No citations._");
  lines.push("");

  // ---------- 6. Residual Uncertainty ----------
  lines.push("## Residual Uncertainty");
  lines.push("");

  if (topHypothesis && topHypothesis.counterEvidence.length > 0) {
    for (const c of topHypothesis.counterEvidence) {
      lines.push(`- ${c}`);
    }
  } else {
    lines.push("- No specific counter-evidence captured.");
  }
  lines.push("");

  // ---------- 7. Session Metadata ----------
  lines.push("## Session Metadata");
  lines.push("");
  lines.push(`| Field | Value |`);
  lines.push(`|-------|-------|`);
  lines.push(`| Session | \`${session.sessionId}\` |`);
  lines.push(`| Created | ${session.createdAt} |`);
  lines.push(`| Schema | ${session.schemaVersion} |`);
  lines.push(`| Source mode | \`${session.sourceMode}\` |`);
  if (session.sourceMode === "elastic" && session.fetch) {
    lines.push(`| ES URL | \`${session.fetch.esUrl}\` |`);
    lines.push(`| Index pattern | \`${session.fetch.indexPattern}\` |`);
    if (session.fetch.since) lines.push(`| Since | ${session.fetch.since} |`);
    if (session.fetch.until) lines.push(`| Until | ${session.fetch.until} |`);
    if (session.fetch.service) lines.push(`| Service | ${session.fetch.service} |`);
    lines.push(`| Fetched hits | ${session.fetch.fetchedHits} |`);
    lines.push(`| Total hits | ${session.fetch.totalHits ?? "unknown"} |`);
  } else {
    lines.push(`| Logs path | \`${session.input.logsPath ?? "-"}\` |`);
  }
  lines.push(`| Repo path | \`${session.input.repoPath ?? "-"}\` |`);
  if (evidence) {
    lines.push(`| Normalized events | ${evidence.normalizedEvents} |`);
    lines.push(`| Clusters (debug) | ${evidence.clusters.length} |`);
    lines.push(`| Evidence items | ${evidence.items.length} |`);
    lines.push(`| Code candidates | ${evidence.topCodeCandidates.length} |`);
  }
  lines.push("");

  // ---------- 8. Debug: Clusters (last) ----------
  lines.push("## Debug: Clusters");
  lines.push("");
  lines.push("_Low-level cluster data, ordered by frequency. Useful for drilldown but not the primary product output._");
  lines.push("");

  const clusters = evidence?.clusters ?? [];
  if (clusters.length === 0) {
    lines.push("_No clusters._");
  } else {
    lines.push("| Cluster | Count | Levels | Summary |");
    lines.push("|---------|-------|--------|---------|");
    for (const c of clusters.slice(0, 15)) {
      const levels = Object.entries(c.levels).map(([k, v]) => `${k}=${v}`).join(",");
      lines.push(`| \`${c.id}\` | ${c.count} | ${levels} | ${c.summary} |`);
    }
    if (clusters.length > 15) {
      lines.push(`| _(... ${clusters.length - 15} more)_ | | | |`);
    }
  }
  lines.push("");

  lines.push("---");
  lines.push("*Generated by kibtrace v0.4.0*");
  lines.push("");

  return lines.join("\n");
}
