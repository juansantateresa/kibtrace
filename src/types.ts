export type ConfidenceLevel = "low" | "medium" | "high";

export interface InvestigationInput {
  logsPath: string;
  repoPath: string;
  outDir: string;
  since?: string;
  until?: string;
  service?: string;
  environment?: string;
}

export interface NormalizedEvent {
  id: string;
  sourceFile: string;
  message: string;
  level?: string;
  timestamp?: string;
}

export interface ClusterSummary {
  id: string;
  fingerprint: string;
  summary: string;
  count: number;
  sourceFiles: string[];
}

export interface CodeReference {
  path: string;
  reason: string;
  symbol?: string;
  line?: number;
}

export interface Hypothesis {
  id: string;
  summary: string;
  confidence: ConfidenceLevel;
  supportingSignals: string[];
  counterEvidence: string[];
  suggestedOwners: string[];
  probableCodeAreas: CodeReference[];
}

export interface ReducedEvidence {
  discoveredLogFiles: string[];
  totalBytes: number;
  normalizedEvents: number;
  clusters: ClusterSummary[];
}

export interface RepoCorrelation {
  repoPath: string;
  probableCodeAreas: CodeReference[];
  suggestedOwners: string[];
}

