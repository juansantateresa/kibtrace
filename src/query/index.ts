import { readFile } from "node:fs/promises";

import type { SessionArtifact } from "../evidence/session.js";
import type {
  ClusterSummary,
  EvidenceItem,
  NormalizedEvent,
  QueryResult,
  QueryViewName
} from "../types.js";

export interface QueryOptions {
  view: QueryViewName;
  clusterId?: string;
  evidenceId?: string;
  service?: string;
  trace?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 20;

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

function compactEvidenceHeader(item: EvidenceItem) {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    score: item.score,
    severity: item.severity
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

function requireEvidence(session: SessionArtifact) {
  if (!session.evidence) {
    throw new Error("Session has no evidence. Run `kibtrace prepare --session <path>` first.");
  }
  return session.evidence;
}

export async function runQuery(
  session: SessionArtifact,
  options: QueryOptions
): Promise<QueryResult> {
  const limit = options.limit ?? DEFAULT_LIMIT;

  switch (options.view) {
    // ---------- new evidence-first views ----------

    case "incident-summary": {
      const evidence = requireEvidence(session);
      const top = evidence.items.slice(0, 3);
      const traceIds = new Set<string>();
      for (const item of top) {
        for (const t of item.relatedTraceIds ?? []) traceIds.add(t);
      }
      return {
        view: "incident-summary",
        sessionId: session.sessionId,
        result: {
          summary: top[0]?.title ?? "(no evidence)",
          totalEvents: evidence.normalizedEvents,
          totalClusters: evidence.clusters.length,
          totalEvidence: evidence.items.length,
          topEvidence: top.map((item) => ({
            id: item.id,
            kind: item.kind,
            title: item.title,
            summary: item.summary,
            score: item.score,
            severity: item.severity,
            signals: item.signals.slice(0, 4),
            relatedTraceIds: item.relatedTraceIds?.slice(0, 3) ?? []
          })),
          topCodeCandidates: evidence.topCodeCandidates.slice(0, 5),
          keyTraceIds: [...traceIds].slice(0, 5),
          hypotheses: (session.hypotheses ?? []).slice(0, 3).map((h) => ({
            id: h.id,
            summary: h.summary,
            confidence: h.confidence,
            backedByEvidenceIds: h.backedByEvidenceIds ?? []
          }))
        }
      };
    }

    case "top-evidence": {
      const evidence = requireEvidence(session);
      const top = evidence.items.slice(0, limit).map(compactEvidenceHeader);
      return {
        view: "top-evidence",
        sessionId: session.sessionId,
        result: {
          totalEvidence: evidence.items.length,
          returned: top.length,
          items: top
        }
      };
    }

    case "evidence": {
      const evidence = requireEvidence(session);
      if (!options.evidenceId) {
        throw new Error("--id <evidence-id> is required for view=evidence");
      }
      const found = evidence.items.find((it) => it.id === options.evidenceId);
      if (!found) {
        return {
          view: "evidence",
          sessionId: session.sessionId,
          result: { error: `evidence not found: ${options.evidenceId}` }
        };
      }
      return {
        view: "evidence",
        sessionId: session.sessionId,
        result: found
      };
    }

    case "code-candidates": {
      const evidence = requireEvidence(session);
      const top = evidence.topCodeCandidates.slice(0, limit);
      return {
        view: "code-candidates",
        sessionId: session.sessionId,
        result: {
          total: evidence.topCodeCandidates.length,
          returned: top.length,
          candidates: top
        }
      };
    }

    // ---------- existing debug / drilldown views ----------

    case "clusters": {
      const evidence = requireEvidence(session);
      const top = evidence.clusters.slice(0, limit).map(compactCluster);
      return {
        view: "clusters",
        sessionId: session.sessionId,
        result: { totalClusters: evidence.clusters.length, returned: top.length, clusters: top }
      };
    }

    case "cluster": {
      const evidence = requireEvidence(session);
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
        result: { ...found, representativeExcerpts: found.representativeExcerpts }
      };
    }

    case "latest-errors": {
      const events = await loadNormalizedEvents(session);
      const picked = pickLatestErrors(events, limit);
      return {
        view: "latest-errors",
        sessionId: session.sessionId,
        result: {
          totalErrors: events.filter((e) => e.level === "ERROR" || e.level === "FATAL").length,
          returned: picked.length,
          events: picked.map(compactEvent)
        }
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
