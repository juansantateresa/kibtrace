import type { Hypothesis, ReducedEvidence, RepoCorrelation } from "../types.js";

export function buildHypotheses(
  evidence: ReducedEvidence,
  correlation: RepoCorrelation
): Hypothesis[] {
  return [
    {
      id: "hypothesis-1",
      summary: "Initial scaffold hypothesis based on discovered log evidence.",
      confidence: evidence.discoveredLogFiles.length > 0 ? "low" : "low",
      supportingSignals: [
        `Discovered ${evidence.discoveredLogFiles.length} log file(s).`,
        `Built ${evidence.clusters.length} coarse cluster(s).`
      ],
      counterEvidence: [
        "No domain-specific clustering or stacktrace analysis has been implemented yet."
      ],
      suggestedOwners: correlation.suggestedOwners,
      probableCodeAreas: correlation.probableCodeAreas
    }
  ];
}

