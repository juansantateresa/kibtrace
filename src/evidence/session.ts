import { readFile, writeFile } from "node:fs/promises";

import type { Hypothesis, InvestigationInput, ReducedEvidence, RepoCorrelation } from "../types.js";

export interface SessionArtifact {
  schemaVersion: "0.1.0";
  sessionId: string;
  createdAt: string;
  input: InvestigationInput;
  evidence: ReducedEvidence;
  correlation: RepoCorrelation;
  hypotheses: Hypothesis[];
  artifacts: {
    sessionPath: string;
    reportJsonPath: string;
    reportMarkdownPath: string;
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

