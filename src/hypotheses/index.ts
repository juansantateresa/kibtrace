import type {
  CodeCandidate,
  CodeReference,
  ConfidenceLevel,
  EvidenceItem,
  Hypothesis,
  PreparedEvidence
} from "../types.js";

const MAX_HYPOTHESES = 3;

/**
 * Confidence is derived from evidence quality, not category counts.
 *
 * Order of checks is fixed-most-restrictive-first to avoid the previous bug
 * where "high" was unreachable because "medium" matched first.
 */
function assessConfidence(item: EvidenceItem): ConfidenceLevel {
  const hasStack = (item.stackFrames?.length ?? 0) > 0;
  const hasCode = (item.codeCandidates?.length ?? 0) > 0;
  const hasTrace = (item.relatedTraceIds?.length ?? 0) > 0;
  const errCount = item.signals.filter((s) => /ERROR|FATAL|fail/i.test(s)).length;

  // High: error-bearing item with both stack frames AND a resolved code candidate
  // AND a backing trace, plus a high score.
  if (item.severity === "high" && hasStack && hasCode && hasTrace && errCount >= 1) {
    return "high";
  }
  if (item.severity === "high" && (hasStack || hasCode)) {
    return "medium";
  }
  if (item.severity === "medium" && hasStack && hasCode) {
    return "medium";
  }
  if (item.severity === "medium") {
    return "low";
  }
  return "low";
}

function codeCandidateToReference(c: CodeCandidate): CodeReference {
  return {
    path: c.path,
    reason: c.reason,
    ...(c.symbol ? { symbol: c.symbol } : {}),
    ...(c.line !== undefined ? { line: c.line } : {})
  };
}

function buildSummary(item: EvidenceItem): string {
  switch (item.kind) {
    case "error-cluster":
      return `Repeated failure: ${item.title}`;
    case "trace-timeline":
      return `Causal chain observed: ${item.title}`;
    case "stack-group":
      return `Errors converging in code: ${item.title}`;
    case "retry-chain":
      return `Retry pattern with no recovery: ${item.title}`;
    case "code-candidate":
      return `Suspect code area: ${item.title}`;
  }
}

function buildSignals(item: EvidenceItem): string[] {
  const out = [...item.signals];
  if (item.codeCandidates && item.codeCandidates.length > 0) {
    const top = item.codeCandidates[0]!;
    out.push(`code candidate: ${top.path}${top.line ? `:${top.line}` : ""} (${top.reason})`);
  }
  if (item.relatedTraceIds && item.relatedTraceIds.length > 0) {
    out.push(`trace evidence: ${item.relatedTraceIds.length} affected trace(s)`);
  }
  if (item.stackFrames && item.stackFrames.length > 0) {
    out.push(`stack-frame depth: ${item.stackFrames.length}`);
  }
  return out;
}

function buildCounter(item: EvidenceItem): string[] {
  const counter: string[] = [];
  if (!item.stackFrames || item.stackFrames.length === 0) {
    counter.push("no stack trace attached — root cause inference is weaker");
  }
  if (!item.codeCandidates || item.codeCandidates.length === 0) {
    counter.push("no resolved code candidate — repo correlation did not match");
  }
  if (!item.relatedTraceIds || item.relatedTraceIds.length === 0) {
    counter.push("no trace ID — failure not tied to a request lifecycle");
  }
  if (counter.length === 0) {
    counter.push("no significant counter-evidence identified");
  }
  return counter;
}

export function buildHypotheses(evidence: PreparedEvidence): Hypothesis[] {
  if (!evidence.items || evidence.items.length === 0) {
    return [
      {
        id: "hypothesis-1",
        summary: "Insufficient evidence — no ranked items produced.",
        confidence: "low",
        supportingSignals: ["No evidence items extracted from the input."],
        counterEvidence: ["Logs may be empty, schema-incompatible, or missing failures."],
        suggestedOwners: [],
        probableCodeAreas: []
      }
    ];
  }

  const top = evidence.items.slice(0, MAX_HYPOTHESES);
  const hypotheses: Hypothesis[] = [];

  for (let i = 0; i < top.length; i++) {
    const item = top[i]!;
    const confidence = assessConfidence(item);

    const probableAreas: CodeReference[] = (item.codeCandidates ?? [])
      .slice(0, 5)
      .map(codeCandidateToReference);

    // Fall back to top global code candidates if the item has none of its own.
    if (probableAreas.length === 0) {
      for (const c of evidence.topCodeCandidates.slice(0, 3)) {
        probableAreas.push(codeCandidateToReference(c));
      }
    }

    hypotheses.push({
      id: `hypothesis-${i + 1}`,
      summary: buildSummary(item),
      confidence,
      supportingSignals: buildSignals(item),
      counterEvidence: buildCounter(item),
      suggestedOwners: [],
      probableCodeAreas: probableAreas,
      backedByEvidenceIds: [item.id]
    });
  }

  return hypotheses;
}
