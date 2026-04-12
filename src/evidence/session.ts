import { readFile, writeFile } from "node:fs/promises";

import type {
  FetchManifest,
  Hypothesis,
  InvestigationInput,
  PreparedEvidence,
  SourceMode
} from "../types.js";

export const SESSION_SCHEMA_VERSION = "0.4.0" as const;

/** Schema versions this binary can load. */
const SUPPORTED_SCHEMA_VERSIONS = new Set<string>([SESSION_SCHEMA_VERSION]);

export interface SessionArtifact {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  sessionId: string;
  createdAt: string;
  /** Updated whenever prepare runs and modifies session state. */
  updatedAt: string;
  sourceMode: SourceMode;
  input: InvestigationInput;
  /** Present when sourceMode === "elastic". */
  fetch?: FetchManifest;
  /** Present after prepare runs — clusters + ranked evidence + top code candidates. */
  evidence?: PreparedEvidence;
  /** Present after prepare runs — derived from top evidence items. */
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
  const parsed = JSON.parse(raw) as { schemaVersion?: string } & SessionArtifact;

  const version = parsed.schemaVersion;
  if (!version || !SUPPORTED_SCHEMA_VERSIONS.has(version)) {
    const supported = [...SUPPORTED_SCHEMA_VERSIONS].join(", ");
    throw new Error(
      `Unsupported session schema version: ${version ?? "(missing)"}. ` +
      `This kibtrace binary supports: ${supported}. ` +
      `Re-run \`kibtrace fetch\` and \`kibtrace prepare\` to create a fresh session.`
    );
  }

  return parsed;
}
