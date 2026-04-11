import { readFile } from "node:fs/promises";

import type { SessionArtifact } from "../evidence/session.js";
import type { ClusterSummary, NormalizedEvent, QueryResult, QueryViewName } from "../types.js";

export interface QueryOptions {
  view: QueryViewName;
  clusterId?: string;
  service?: string;
  trace?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 20;

/** Compact cluster shape for query output. */
function compactCluster(c: ClusterSummary) {
  return {
    id: c.id,
    summary: c.summary,
    fingerprint: c.fingerprint,
    count: c.count,
    levels: c.levels,
    sampleEventIds: c.sampleEventIds,
    excerptCount: c.representativeExcerpts.length
  };
}

async function loadNormalizedEvents(session: SessionArtifact): Promise<NormalizedEvent[]> {
  const path = session.artifacts.normalizedEventsPath;
  if (!path) {
    throw new Error(
      "Session has no normalized-events.json. Run `kibtrace prepare --session <path>` first."
    );
  }
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as NormalizedEvent[];
}

function pickLatestErrors(events: NormalizedEvent[], limit: number): NormalizedEvent[] {
  const errors = events.filter((e) => e.level === "ERROR" || e.level === "FATAL");
  // Sort by timestamp descending if present, otherwise keep insertion order reversed
  const sorted = [...errors].sort((a, b) => {
    const ta = a.timestamp ?? "";
    const tb = b.timestamp ?? "";
    if (ta === tb) return 0;
    return ta < tb ? 1 : -1;
  });
  return sorted.slice(0, limit);
}

function pickByService(events: NormalizedEvent[], service: string, limit: number): NormalizedEvent[] {
  return events.filter((e) => e.service === service).slice(0, limit);
}

function pickByTrace(events: NormalizedEvent[], traceId: string, limit: number): NormalizedEvent[] {
  return events.filter((e) => e.traceId === traceId).slice(0, limit);
}

function compactEvent(e: NormalizedEvent) {
  return {
    id: e.id,
    timestamp: e.timestamp,
    level: e.level,
    service: e.service,
    traceId: e.traceId,
    message: e.message,
    stackTracePreview: e.stackTrace?.slice(0, 5),
    sourceFile: e.sourceFile
  };
}

export async function runQuery(
  session: SessionArtifact,
  options: QueryOptions
): Promise<QueryResult> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const evidence = session.evidence;

  switch (options.view) {
    case "clusters": {
      if (!evidence) {
        throw new Error("Session has no evidence. Run `kibtrace prepare --session <path>` first.");
      }
      const top = evidence.clusters.slice(0, limit).map(compactCluster);
      return {
        view: "clusters",
        sessionId: session.sessionId,
        result: { totalClusters: evidence.clusters.length, returned: top.length, clusters: top }
      };
    }

    case "cluster": {
      if (!evidence) {
        throw new Error("Session has no evidence. Run `kibtrace prepare --session <path>` first.");
      }
      if (!options.clusterId) {
        throw new Error("--id <cluster-id> is required for view=cluster");
      }
      const found = evidence.clusters.find((c) => c.id === options.clusterId);
      if (!found) {
        return {
          view: "cluster",
          sessionId: session.sessionId,
          result: { error: `cluster not found: ${options.clusterId}` }
        };
      }
      return {
        view: "cluster",
        sessionId: session.sessionId,
        result: {
          ...found,
          // Send the full excerpts (not truncated)
          representativeExcerpts: found.representativeExcerpts
        }
      };
    }

    case "latest-errors": {
      const events = await loadNormalizedEvents(session);
      const picked = pickLatestErrors(events, limit);
      return {
        view: "latest-errors",
        sessionId: session.sessionId,
        result: { totalErrors: events.filter((e) => e.level === "ERROR" || e.level === "FATAL").length, returned: picked.length, events: picked.map(compactEvent) }
      };
    }

    case "service": {
      if (!options.service) {
        throw new Error("--service <name> is required for view=service");
      }
      const events = await loadNormalizedEvents(session);
      const picked = pickByService(events, options.service, limit);
      return {
        view: "service",
        sessionId: session.sessionId,
        result: { service: options.service, returned: picked.length, events: picked.map(compactEvent) }
      };
    }

    case "trace": {
      if (!options.trace) {
        throw new Error("--trace <id> is required for view=trace");
      }
      const events = await loadNormalizedEvents(session);
      const picked = pickByTrace(events, options.trace, limit);
      return {
        view: "trace",
        sessionId: session.sessionId,
        result: { traceId: options.trace, returned: picked.length, events: picked.map(compactEvent) }
      };
    }

    default: {
      const exhaustive: never = options.view;
      throw new Error(`Unknown query view: ${exhaustive as string}`);
    }
  }
}
