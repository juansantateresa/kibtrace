import type { ClusterSummary, EvidenceItem, EvidenceSeverity, NormalizedEvent } from "../types.js";

/**
 * Deterministic, weighted scoring for evidence items.
 *
 * Goal: meaningful failure signal beats raw frequency. The flagship sandbox
 * case is "DB persistence failure with stack trace" — it must outrank
 * "Frame received for inference" (high-volume INFO noise).
 */

const INCIDENT_KEYWORDS = [
  // Database / persistence
  "database", "sql", "relation", "insert", "update", "delete",
  "transaction", "rollback", "deadlock", "constraint", "duplicate key",
  "persist", "persistence", "pool exhausted", "connection refused",
  // Connectivity / runtime
  "timeout", "timed out", "deadline", "ECONNREFUSED", "ECONNRESET",
  "EPIPE", "ENOTFOUND", "unreachable", "circuit breaker",
  // Auth
  "unauthorized", "forbidden", "permission denied", "401", "403",
  // Runtime errors
  "null", "undefined", "exception", "panic", "segfault", "stack overflow",
  // Generic failure verbs
  "failed", "failure", "error:"
];

const NOISE_PATTERNS = [
  /\bframe received\b/i,
  /\bframe preprocessed\b/i,
  /\binference completed\b/i,
  /\bno people detected\b/i,
  /\bpeople detected\b/i,
  /\bhealth check (?:succeeded|ok)\b/i,
  /\bheartbeat\b/i,
  /\bping\b/i,
  /\bstartup\b/i,
  /\binitialized\b/i,
  /\bconnected to\b/i,
  /\blistening on\b/i
];

function lower(s: string): string {
  return s.toLowerCase();
}

/** + boost when the cluster has any high-severity events. */
export function severityBoost(levels: Record<string, number>): number {
  if ((levels["FATAL"] ?? 0) > 0) return 120;
  if ((levels["ERROR"] ?? 0) > 0) return 100;
  if ((levels["WARN"] ?? 0) > 0) return 25;
  return 0;
}

/** + boost when stack-trace evidence is present. */
export function stackBoost(hasStack: boolean, hasAppFrame: boolean): number {
  let boost = 0;
  if (hasStack) boost += 50;
  if (hasAppFrame) boost += 40;
  return boost;
}

/** + boost when the message looks like a known failure mode. */
export function incidentKeywordBoost(text: string): number {
  const lc = lower(text);
  let hits = 0;
  for (const kw of INCIDENT_KEYWORDS) {
    if (lc.includes(kw)) hits += 1;
  }
  return Math.min(hits * 15, 60);
}

/** - penalty for known generic INFO noise. */
export function noisePenalty(text: string, levels: Record<string, number>): number {
  let penalty = 0;
  for (const re of NOISE_PATTERNS) {
    if (re.test(text)) {
      penalty -= 60;
      break;
    }
  }
  // Pure INFO/DEBUG noise gets an extra ding
  const errors = (levels["ERROR"] ?? 0) + (levels["FATAL"] ?? 0);
  const warns = levels["WARN"] ?? 0;
  if (errors === 0 && warns === 0) {
    penalty -= 25;
  }
  return penalty;
}

/** Logarithmic frequency contribution — prevents raw count from dominating. */
export function frequencyScore(count: number): number {
  if (count <= 0) return 0;
  return Math.round(Math.log10(count + 1) * 10);
}

/**
 * Score a single error-cluster evidence item.
 * Inputs are derived from the cluster + a quick scan of its member events.
 */
export function scoreErrorCluster(
  cluster: ClusterSummary,
  members: NormalizedEvent[]
): number {
  const text = `${cluster.summary} ${cluster.fingerprint}`;

  const hasStack = members.some((m) => (m.stackTrace?.length ?? 0) > 0);
  const hasAppFrame = members.some((m) => {
    if (!m.stackTrace) return false;
    return m.stackTrace.some((line) => /\/app\/src\//.test(line));
  });

  let score = 0;
  score += frequencyScore(cluster.count);
  score += severityBoost(cluster.levels);
  score += stackBoost(hasStack, hasAppFrame);
  score += incidentKeywordBoost(text);
  score += noisePenalty(text, cluster.levels);
  return score;
}

/** Score a trace-timeline item. */
export function scoreTraceTimeline(
  errorCount: number,
  totalEvents: number,
  hasHealthyStages: boolean
): number {
  let score = 0;
  // Always meaningful since we only emit timelines for traces with errors
  score += 80;
  score += errorCount * 10;
  if (hasHealthyStages) score += 30;
  if (totalEvents >= 5) score += 10;
  return score;
}

/** Score a stack-group item. */
export function scoreStackGroup(occurrenceCount: number, hasIncidentKeyword: boolean): number {
  let score = 60; // base — stack groups are inherently meaningful
  score += Math.min(occurrenceCount * 5, 60);
  if (hasIncidentKeyword) score += 30;
  return score;
}

/** Score a retry-chain item. */
export function scoreRetryChain(retryCount: number, allFailed: boolean): number {
  let score = 70;
  score += Math.min(retryCount * 8, 40);
  if (allFailed) score += 30;
  return score;
}

/** Map a numeric score to a severity label. */
export function scoreToSeverity(score: number): EvidenceSeverity {
  if (score >= 150) return "high";
  if (score >= 70) return "medium";
  return "low";
}

/** Sort items by score descending; stable for equal scores. */
export function rankItems(items: EvidenceItem[]): EvidenceItem[] {
  return [...items].sort((a, b) => b.score - a.score);
}
