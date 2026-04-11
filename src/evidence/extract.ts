import type {
  ClusterSummary,
  EvidenceCitation,
  EvidenceItem,
  NormalizedEvent
} from "../types.js";
import { fingerprint } from "../reduce/index.js";
import { appFrames, frameKey, parseStackFrames, topAppFrame } from "./stack.js";
import {
  rankItems,
  scoreErrorCluster,
  scoreRetryChain,
  scoreStackGroup,
  scoreToSeverity,
  scoreTraceTimeline
} from "./rank.js";

const MAX_TRACE_ITEMS = 5;
const MAX_CITATIONS_PER_ITEM = 6;
const MIN_CLUSTER_FOR_EVIDENCE = 1;

interface ExtractionContext {
  /** Map cluster id → member events (rebuilt for evidence extraction). */
  clusterMembers: Map<string, NormalizedEvent[]>;
}

function buildClusterMembers(
  events: NormalizedEvent[],
  clusters: ClusterSummary[]
): Map<string, NormalizedEvent[]> {
  // Re-bucket events by fingerprint and align to cluster ids.
  const fpToCluster = new Map<string, string>();
  for (const c of clusters) fpToCluster.set(c.fingerprint, c.id);

  const out = new Map<string, NormalizedEvent[]>();
  for (const event of events) {
    const fp = fingerprint(event.message);
    const id = fpToCluster.get(fp);
    if (!id) continue;
    let list = out.get(id);
    if (!list) {
      list = [];
      out.set(id, list);
    }
    list.push(event);
  }
  return out;
}

function citationFromEvent(e: NormalizedEvent): EvidenceCitation {
  const cite: EvidenceCitation = {
    eventId: e.id,
    sourceFile: e.sourceFile
  };
  if (e.timestamp) cite.timestamp = e.timestamp;
  if (e.traceId) cite.traceId = e.traceId;
  return cite;
}

// ---------- A. Error-cluster items ----------

function extractErrorClusterItems(
  clusters: ClusterSummary[],
  ctx: ExtractionContext
): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  let counter = 0;

  for (const cluster of clusters) {
    if (cluster.count < MIN_CLUSTER_FOR_EVIDENCE) continue;

    const members = ctx.clusterMembers.get(cluster.id) ?? [];
    const score = scoreErrorCluster(cluster, members);

    // Only emit clusters that look like real signal — drop deeply negative ones.
    // The negative threshold prevents pure noise from showing up at all.
    if (score < 30) continue;

    counter += 1;
    const id = `evidence-cluster-${counter}`;

    const errors = (cluster.levels["ERROR"] ?? 0) + (cluster.levels["FATAL"] ?? 0);
    const warns = cluster.levels["WARN"] ?? 0;

    const signals: string[] = [];
    signals.push(`${cluster.count} matching event(s)`);
    if (errors > 0) signals.push(`${errors} ERROR/FATAL`);
    if (warns > 0) signals.push(`${warns} WARN`);

    const stackMembers = members.filter((m) => (m.stackTrace?.length ?? 0) > 0);
    if (stackMembers.length > 0) {
      signals.push(`${stackMembers.length} member(s) carry a stack trace`);
    }

    // Build citations: prefer events with stack traces and earliest timestamps.
    const citationCandidates = stackMembers.length > 0 ? stackMembers : members;
    const citations = citationCandidates
      .slice(0, MAX_CITATIONS_PER_ITEM)
      .map(citationFromEvent);

    // Stack frames from the first stack-bearing member.
    const firstStack = stackMembers[0]?.stackTrace;
    const stackFrames = firstStack ? firstStack.slice(0, 8) : undefined;

    const traceIds = [...new Set(members.map((m) => m.traceId).filter((t): t is string => !!t))].slice(0, 5);

    const item: EvidenceItem = {
      id,
      kind: "error-cluster",
      title: cluster.summary,
      summary:
        errors > 0
          ? `${cluster.summary} — ${cluster.count} occurrence(s), ${errors} at ERROR/FATAL`
          : `${cluster.summary} — ${cluster.count} occurrence(s)`,
      score,
      severity: scoreToSeverity(score),
      signals,
      citations,
      relatedClusterIds: [cluster.id],
      ...(traceIds.length > 0 ? { relatedTraceIds: traceIds } : {}),
      ...(stackFrames ? { stackFrames } : {})
    };

    items.push(item);
  }

  return items;
}

// ---------- B. Trace-timeline items ----------

interface TraceBucket {
  traceId: string;
  events: NormalizedEvent[];
  errorCount: number;
}

function bucketByTrace(events: NormalizedEvent[]): TraceBucket[] {
  const map = new Map<string, TraceBucket>();
  for (const e of events) {
    if (!e.traceId) continue;
    let bucket = map.get(e.traceId);
    if (!bucket) {
      bucket = { traceId: e.traceId, events: [], errorCount: 0 };
      map.set(e.traceId, bucket);
    }
    bucket.events.push(e);
    if (e.level === "ERROR" || e.level === "FATAL") bucket.errorCount += 1;
  }
  return [...map.values()];
}

const HEALTHY_STAGE_PATTERNS = [
  /received|preprocessed|processed|inference|detected|persisting|persist/i
];

function hasHealthyStages(events: NormalizedEvent[]): boolean {
  for (const e of events) {
    if (e.level !== "INFO" && e.level !== "DEBUG") continue;
    if (HEALTHY_STAGE_PATTERNS.some((re) => re.test(e.message))) return true;
  }
  return false;
}

function extractTraceTimelineItems(
  events: NormalizedEvent[],
  clusters: ClusterSummary[]
): EvidenceItem[] {
  const buckets = bucketByTrace(events).filter((b) => b.errorCount > 0);

  // Pick the top traces by error count, then by total event count.
  buckets.sort((a, b) => {
    if (b.errorCount !== a.errorCount) return b.errorCount - a.errorCount;
    return b.events.length - a.events.length;
  });

  const top = buckets.slice(0, MAX_TRACE_ITEMS);
  const fpToClusterId = new Map<string, string>();
  for (const c of clusters) fpToClusterId.set(c.fingerprint, c.id);

  const items: EvidenceItem[] = [];
  let counter = 0;

  for (const bucket of top) {
    counter += 1;
    const id = `evidence-trace-${counter}`;
    const sorted = [...bucket.events].sort((a, b) => {
      const ta = a.timestamp ?? "";
      const tb = b.timestamp ?? "";
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });

    // Build a compact timeline string from messages, dedupe consecutive duplicates.
    const stages: string[] = [];
    for (const e of sorted) {
      const tag = e.level === "ERROR" || e.level === "FATAL" ? "ERROR: " : "";
      const text = `${tag}${e.message}`;
      if (stages[stages.length - 1] !== text) stages.push(text);
    }
    const timeline = stages.slice(0, 8).join(" → ");

    const healthy = hasHealthyStages(sorted);
    const score = scoreTraceTimeline(bucket.errorCount, sorted.length, healthy);

    const relatedClusterIds = [
      ...new Set(
        sorted
          .map((e) => fpToClusterId.get(fingerprint(e.message)))
          .filter((c): c is string => !!c)
      )
    ].slice(0, 8);

    const citations = sorted.slice(0, MAX_CITATIONS_PER_ITEM).map(citationFromEvent);

    const stackBearer = sorted.find((e) => e.stackTrace && e.stackTrace.length > 0);
    const stackFrames = stackBearer?.stackTrace?.slice(0, 8);

    const signals: string[] = [
      `${sorted.length} event(s) in trace`,
      `${bucket.errorCount} ERROR/FATAL event(s)`
    ];
    if (healthy) signals.push("trace shows healthy stages followed by failure");

    items.push({
      id,
      kind: "trace-timeline",
      title: `Trace ${bucket.traceId.slice(0, 12)}… ends in failure`,
      summary: timeline,
      score,
      severity: scoreToSeverity(score),
      signals,
      citations,
      relatedClusterIds,
      relatedTraceIds: [bucket.traceId],
      ...(stackFrames ? { stackFrames } : {})
    });
  }

  return items;
}

// ---------- C. Stack-group items ----------

function extractStackGroupItems(events: NormalizedEvent[]): EvidenceItem[] {
  const groups = new Map<string, NormalizedEvent[]>();

  for (const e of events) {
    if (!e.stackTrace || e.stackTrace.length === 0) continue;
    const top = topAppFrame(e.stackTrace);
    if (!top) continue;
    const key = frameKey(top);
    let list = groups.get(key);
    if (!list) {
      list = [];
      groups.set(key, list);
    }
    list.push(e);
  }

  const items: EvidenceItem[] = [];
  let counter = 0;

  for (const [key, members] of groups) {
    if (members.length < 2) continue;

    counter += 1;
    const id = `evidence-stack-${counter}`;

    const top = topAppFrame(members[0]!.stackTrace);
    if (!top) continue;

    const incidentKw = members.some((m) =>
      /relation|insert|deadlock|null|undefined|exception|timeout|refused/i.test(m.message)
    );
    const score = scoreStackGroup(members.length, incidentKw);

    const stackFrames = parseStackFrames(members[0]!.stackTrace ?? [])
      .slice(0, 8)
      .map((f) => f.raw);

    const citations = members.slice(0, MAX_CITATIONS_PER_ITEM).map(citationFromEvent);

    const traceIds = [...new Set(members.map((m) => m.traceId).filter((t): t is string => !!t))].slice(0, 5);

    items.push({
      id,
      kind: "stack-group",
      title: `${top.symbol ?? "(anonymous)"} at ${top.cleanFile}:${top.line ?? "?"}`,
      summary: `${members.length} error(s) converge on ${top.symbol ?? "(anonymous)"} in ${top.cleanFile}:${top.line ?? "?"}`,
      score,
      severity: scoreToSeverity(score),
      signals: [
        `${members.length} occurrence(s)`,
        `top app frame: ${key}`
      ],
      citations,
      ...(traceIds.length > 0 ? { relatedTraceIds: traceIds } : {}),
      stackFrames,
      codeCandidates: top.cleanFile
        ? [
            {
              path: top.cleanFile,
              ...(top.line !== undefined ? { line: top.line } : {}),
              score: 100,
              reason: `referenced by stack frame in ${members.length} error(s)`,
              ...(top.symbol ? { symbol: top.symbol } : {})
            }
          ]
        : []
    });
  }

  return items;
}

// ---------- D. Retry-chain items ----------

const RETRY_RE = /retry|retrying/i;

function extractRetryChainItems(
  events: NormalizedEvent[],
  clusters: ClusterSummary[]
): EvidenceItem[] {
  const retryClusters = clusters.filter((c) => RETRY_RE.test(c.summary));
  if (retryClusters.length === 0) return [];

  const items: EvidenceItem[] = [];
  let counter = 0;

  for (const retryCluster of retryClusters) {
    // Find traces that contain this retry pattern AND an error.
    const retryFp = retryCluster.fingerprint;
    const tracesWithRetry = new Set<string>();
    for (const e of events) {
      if (!e.traceId) continue;
      if (fingerprint(e.message) === retryFp) tracesWithRetry.add(e.traceId);
    }

    if (tracesWithRetry.size === 0) continue;

    // Pull all events for those traces and confirm an error appears.
    const chainEvents = events.filter((e) => e.traceId && tracesWithRetry.has(e.traceId));
    const errorEvents = chainEvents.filter(
      (e) => e.level === "ERROR" || e.level === "FATAL"
    );
    if (errorEvents.length === 0) continue;

    counter += 1;
    const id = `evidence-retry-${counter}`;

    // Was the action ever successful within these traces?
    const successFps = new Set<string>();
    for (const e of chainEvents) {
      if (e.level === "INFO" && /succeed|success|ok|complete/i.test(e.message)) {
        successFps.add(fingerprint(e.message));
      }
    }
    const allFailed = successFps.size === 0;

    const score = scoreRetryChain(retryCluster.count, allFailed);

    // Citations: one action, one error, one retry, one error tail.
    const citationsSeen = new Set<string>();
    const orderedCitations: NormalizedEvent[] = [];
    const sortedChain = [...chainEvents].sort((a, b) => {
      const ta = a.timestamp ?? "";
      const tb = b.timestamp ?? "";
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
    for (const e of sortedChain) {
      const key = `${e.level}-${fingerprint(e.message)}`;
      if (citationsSeen.has(key)) continue;
      citationsSeen.add(key);
      orderedCitations.push(e);
      if (orderedCitations.length >= MAX_CITATIONS_PER_ITEM) break;
    }

    const stackBearer = errorEvents.find((e) => e.stackTrace && e.stackTrace.length > 0);
    const stackFrames = stackBearer?.stackTrace?.slice(0, 8);

    items.push({
      id,
      kind: "retry-chain",
      title: `Retry chain: ${retryCluster.summary}`,
      summary: `Action retried ${retryCluster.count} time(s) across ${tracesWithRetry.size} trace(s); ${
        allFailed ? "all attempts failed" : "some attempts succeeded"
      }`,
      score,
      severity: scoreToSeverity(score),
      signals: [
        `${retryCluster.count} retry attempt(s)`,
        `${tracesWithRetry.size} affected trace(s)`,
        `${errorEvents.length} associated error event(s)`,
        allFailed ? "no successful outcome observed" : "partial success observed"
      ],
      citations: orderedCitations.map(citationFromEvent),
      relatedClusterIds: [retryCluster.id],
      relatedTraceIds: [...tracesWithRetry].slice(0, 5),
      ...(stackFrames ? { stackFrames } : {})
    });
  }

  return items;
}

// ---------- public API ----------

export function extractEvidence(
  events: NormalizedEvent[],
  clusters: ClusterSummary[]
): EvidenceItem[] {
  const ctx: ExtractionContext = {
    clusterMembers: buildClusterMembers(events, clusters)
  };

  const items: EvidenceItem[] = [];
  items.push(...extractErrorClusterItems(clusters, ctx));
  items.push(...extractTraceTimelineItems(events, clusters));
  items.push(...extractStackGroupItems(events));
  items.push(...extractRetryChainItems(events, clusters));

  return rankItems(items);
}
