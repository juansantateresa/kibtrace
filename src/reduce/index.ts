import type { IngestionResult } from "../ingest/index.js";
import type { ClusterSummary, NormalizedEvent, ReducedEvidence } from "../types.js";

function buildCluster(events: NormalizedEvent[]): ClusterSummary[] {
  if (events.length === 0) {
    return [];
  }

  return [
    {
      id: "cluster-1",
      fingerprint: "scaffold-cluster",
      summary: "Scaffold cluster built from discovered log files.",
      count: events.length,
      sourceFiles: events.map((event) => event.sourceFile)
    }
  ];
}

export function reduceEvidence(
  ingestion: IngestionResult,
  normalizedEvents: NormalizedEvent[]
): ReducedEvidence {
  return {
    discoveredLogFiles: ingestion.files.map((file) => file.path),
    totalBytes: ingestion.totalBytes,
    normalizedEvents: normalizedEvents.length,
    clusters: buildCluster(normalizedEvents)
  };
}

