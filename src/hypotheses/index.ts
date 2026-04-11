import type { ClusterSummary, ConfidenceLevel, Hypothesis, ReducedEvidence, RepoCorrelation } from "../types.js";

/**
 * Categorize a cluster by its dominant pattern.
 */
function categorizeCluster(cluster: ClusterSummary): string {
  const fp = cluster.fingerprint;
  const summary = cluster.summary.toLowerCase();

  if (/exception|error|fatal|panic|crash/i.test(summary)) return "error";
  if (/timeout|timed?\s*out|deadline/i.test(summary)) return "timeout";
  if (/connect|connection|refused|unreachable|ECONNREFUSED/i.test(summary)) return "connectivity";
  if (/database|sql|query|insert|update|delete|transaction|commit|rollback/i.test(summary)) return "database";
  if (/auth|permission|denied|forbidden|unauthorized|401|403/i.test(summary)) return "auth";
  if (/null|nil|undefined|NoneType|NullPointer/i.test(summary)) return "null-reference";
  if (fp.includes("stacktrace") || fp.includes("at <")) return "stacktrace";
  return "general";
}

/**
 * Determine confidence from signal strength.
 * Conservative: only "high" if we have both cluster evidence AND code correlation.
 */
function assessConfidence(
  errorClusters: number,
  totalClusters: number,
  codeHits: number
): ConfidenceLevel {
  if (errorClusters > 0 && codeHits > 0) return "medium";
  if (errorClusters > 2 && codeHits > 2) return "high";
  return "low";
}

interface ClusterGroup {
  category: string;
  clusters: ClusterSummary[];
  totalCount: number;
}

export function buildHypotheses(
  evidence: ReducedEvidence,
  correlation: RepoCorrelation
): Hypothesis[] {
  if (evidence.clusters.length === 0) {
    return [{
      id: "hypothesis-1",
      summary: "No log clusters found — insufficient data for analysis.",
      confidence: "low",
      supportingSignals: ["No normalized events produced any clusters."],
      counterEvidence: ["Input may be empty or in an unsupported format."],
      suggestedOwners: ["unassigned"],
      probableCodeAreas: []
    }];
  }

  // Group clusters by category
  const groups = new Map<string, ClusterGroup>();
  for (const cluster of evidence.clusters) {
    const cat = categorizeCluster(cluster);
    let group = groups.get(cat);
    if (!group) {
      group = { category: cat, clusters: [], totalCount: 0 };
      groups.set(cat, group);
    }
    group.clusters.push(cluster);
    group.totalCount += cluster.count;
  }

  // Sort groups by total event count descending
  const sortedGroups = [...groups.values()].sort((a, b) => b.totalCount - a.totalCount);

  const hypotheses: Hypothesis[] = [];
  let idCounter = 0;

  for (const group of sortedGroups) {
    idCounter += 1;

    const errorClusterCount = group.clusters.filter(
      (c) => (c.levels["ERROR"] ?? 0) + (c.levels["FATAL"] ?? 0) > 0
    ).length;

    const confidence = assessConfidence(
      errorClusterCount,
      evidence.clusters.length,
      correlation.probableCodeAreas.length
    );

    const signals: string[] = [];
    const counter: string[] = [];

    // Build signals
    signals.push(
      `${group.totalCount} event(s) across ${group.clusters.length} cluster(s) categorized as "${group.category}".`
    );

    if (errorClusterCount > 0) {
      signals.push(`${errorClusterCount} cluster(s) contain ERROR/FATAL-level entries.`);
    }

    // Check for stacktraces
    const withStack = group.clusters.filter((c) =>
      c.representativeExcerpts.some((e) => /^\s+at\s+/.test(e) || /Caused by:/.test(e))
    );
    if (withStack.length > 0) {
      signals.push(`${withStack.length} cluster(s) include stacktrace evidence.`);
    }

    // Code correlation signals
    if (correlation.probableCodeAreas.length > 0) {
      const topAreas = correlation.probableCodeAreas.slice(0, 3);
      signals.push(
        `Code correlation found ${correlation.probableCodeAreas.length} probable area(s): ${topAreas.map((a) => a.path).join(", ")}.`
      );
    }

    // Counter-evidence
    if (correlation.probableCodeAreas.length === 0) {
      counter.push("No code correlation found — keyword search yielded no matches in the repo.");
    }
    if (evidence.clusters.length === 1) {
      counter.push("Only one cluster found — pattern may be noise rather than a distinct failure mode.");
    }
    if (group.totalCount < 3) {
      counter.push(`Low occurrence count (${group.totalCount}) — may be transient.`);
    }

    // Build summary
    const topCluster = group.clusters[0]!;
    let summary: string;
    switch (group.category) {
      case "database":
        summary = `Database-related failure: ${topCluster.summary}`;
        break;
      case "timeout":
        summary = `Timeout pattern detected: ${topCluster.summary}`;
        break;
      case "connectivity":
        summary = `Connectivity issue: ${topCluster.summary}`;
        break;
      case "null-reference":
        summary = `Null/undefined reference: ${topCluster.summary}`;
        break;
      case "auth":
        summary = `Authentication/authorization failure: ${topCluster.summary}`;
        break;
      case "error":
        summary = `Error pattern: ${topCluster.summary}`;
        break;
      default:
        summary = `Log pattern: ${topCluster.summary}`;
    }

    if (summary.length > 200) {
      summary = summary.slice(0, 197) + "...";
    }

    hypotheses.push({
      id: `hypothesis-${idCounter}`,
      summary,
      confidence,
      supportingSignals: signals,
      counterEvidence: counter.length > 0 ? counter : ["No significant counter-evidence identified."],
      suggestedOwners: correlation.suggestedOwners,
      probableCodeAreas: correlation.probableCodeAreas
    });
  }

  return hypotheses;
}
