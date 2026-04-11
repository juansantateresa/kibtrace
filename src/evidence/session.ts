import { readFile, writeFile } from "node:fs/promises";

import type {
  FetchManifest,
  Hypothesis,
  InvestigationInput,
  ReducedEvidence,
  RepoCorrelation,
  SourceMode
} from "../types.js";

export const SESSION_SCHEMA_VERSION = "0.3.0" as const;

export interface SessionArtifact {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  sessionId: string;
  createdAt: string;
  /** Updated whenever prepare/correlate runs and modifies session state. */
  updatedAt: string;
  sourceMode: SourceMode;
  input: InvestigationInput;
  /** Present when sourceMode === "elastic". */
  fetch?: FetchManifest;
  /** Present after prepare runs. */
  evidence?: ReducedEvidence;
  /** Present after prepare runs. */
  correlation?: RepoCorrelation;
  /** Present after prepare runs. */
  hypotheses?: Hypothesis[];
  artifacts: {
    sessionPath: string;
    /** Directory holding raw fetched pages (elastic mode only). */
    rawHitsDir?: string;
    /** Path to normalized events JSON (after prepare). */
    normalizedEventsPath?: string;
    /** Report files (after prepare). */
    reportJsonPath?: string;
    reportMarkdownPath?: string;
  };
}

export async function writeSessionArtifact(
  outputPath: string,
  session: SessionArtifact
): Promise<void> {
  await writeFile(outputPath, JSON.stringify(session, null, 2), "utf8");
}

export async function loadSessionArtifact(inputPath: string): Promise<SessionArtifact> {
  const raw = await readFile(inputPath, "utf8");
  return JSON.parse(raw) as SessionArtifact;
}
