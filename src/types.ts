export type ConfidenceLevel = "low" | "medium" | "high";

export type SourceMode = "file" | "elastic";

export interface InvestigationInput {
  /** Source mode for this session. */
  sourceMode: SourceMode;
  /** Path to local logs (file mode only). */
  logsPath?: string;
  /** Repo path used for code correlation. */
  repoPath?: string;
  /** Output / session directory. */
  outDir: string;
  since?: string;
  until?: string;
  service?: string;
  environment?: string;
}

// ---------- Elastic fetch ----------

export type AuthMode = "none" | "api-key";

export interface FetchConfig {
  esUrl: string;
  indexPattern: string;
  since?: string;
  until?: string;
  service?: string;
  environment?: string;
  pageSize: number;
  maxHits: number;
  /** Auth key — never persisted, never logged. */
  apiKey?: string;
}

export interface FetchManifest {
  esUrl: string;
  indexPattern: string;
  since?: string;
  until?: string;
  service?: string;
  environment?: string;
  pageSize: number;
  pageCount: number;
  fetchedHits: number;
  totalHits: number | null;
  fetchedAt: string;
  authMode: AuthMode;
  /** The query body used (without secrets). */
  query: Record<string, unknown>;
  /** Filenames of raw page artifacts (relative to session raw dir). */
  pageFiles: string[];
}

/** A single Elasticsearch search hit. */
export interface ElasticHit {
  _id: string;
  _index: string;
  _source: Record<string, unknown>;
  sort?: unknown[];
}

// ---------- Ingestion (file mode) ----------

/** A single line parsed from a log file. */
export interface RawLogEntry {
  lineNumber: number;
  raw: string;
  /** Present when the line is valid JSON (NDJSON mode). */
  parsed?: Record<string, unknown>;
  sourceFile: string;
}

// ---------- Normalized events ----------

export interface NormalizedEvent {
  id: string;
  /** Source file (file mode) or _index/_id pointer (elastic mode). */
  sourceFile: string;
  lineNumber?: number;
  message: string;
  level?: string;
  timestamp?: string;
  service?: string;
  component?: string;
  traceId?: string;
  /** Stacktrace lines attached to this event, if any. */
  stackTrace?: string[];
  /** Raw text/JSON of the original event (truncated for storage). */
  raw: string;
}

// ---------- Clusters (debug-level abstraction, kept for drilldown) ----------

export interface ClusterSummary {
  id: string;
  fingerprint: string;
  summary: string;
  count: number;
  sourceFiles: string[];
  /** Up to 3 representative log lines for this cluster. */
  representativeExcerpts: string[];
  /** Breakdown of log levels within this cluster. */
  levels: Record<string, number>;
  /** Up to 3 sample event IDs (for query --view cluster). */
  sampleEventIds: string[];
}

export interface CodeReference {
  path: string;
  reason: string;
  symbol?: string;
  line?: number;
}

// ---------- Evidence model (signal-level abstraction, primary product output) ----------

export type EvidenceKind =
  | "error-cluster"
  | "trace-timeline"
  | "stack-group"
  | "retry-chain"
  | "code-candidate";

export type EvidenceSeverity = "low" | "medium" | "high";

export interface EvidenceCitation {
  eventId: string;
  sourceFile: string;
  timestamp?: string;
  traceId?: string;
}

export interface CodeCandidate {
  path: string;
  line?: number;
  score: number;
  reason: string;
  symbol?: string;
}

export interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  title: string;
  summary: string;
  score: number;
  severity: EvidenceSeverity;
  signals: string[];
  citations: EvidenceCitation[];
  relatedClusterIds?: string[];
  relatedTraceIds?: string[];
  stackFrames?: string[];
  codeCandidates?: CodeCandidate[];
}

export interface PreparedEvidence {
  /** Source artifact paths (log files for file mode, raw page files for elastic mode). */
  discoveredArtifacts: string[];
  totalBytes: number;
  normalizedEvents: number;
  /** Low-level cluster data — kept for debug/drilldown. */
  clusters: ClusterSummary[];
  /** Ranked evidence items — the primary product abstraction. */
  items: EvidenceItem[];
  /** Top-ranked code candidates across all evidence. */
  topCodeCandidates: CodeCandidate[];
}

export interface Hypothesis {
  id: string;
  summary: string;
  confidence: ConfidenceLevel;
  supportingSignals: string[];
  counterEvidence: string[];
  suggestedOwners: string[];
  probableCodeAreas: CodeReference[];
  /** Evidence item IDs that back this hypothesis. */
  backedByEvidenceIds?: string[];
}

// ---------- Query views ----------

export type QueryViewName =
  | "clusters"
  | "cluster"
  | "latest-errors"
  | "service"
  | "trace"
  | "incident-summary"
  | "top-evidence"
  | "evidence"
  | "code-candidates";

export interface QueryResult {
  view: QueryViewName;
  sessionId: string;
  /** Compact payload — shape depends on view. */
  result: unknown;
}
