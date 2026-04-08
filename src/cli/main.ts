#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { ingestLogs } from "../ingest/index.js";
import { normalizeEvents } from "../normalize/index.js";
import { reduceEvidence } from "../reduce/index.js";
import {
  loadSessionArtifact,
  type SessionArtifact,
  writeSessionArtifact
} from "../evidence/session.js";
import { correlateRepository } from "../repo-context/index.js";
import { buildHypotheses } from "../hypotheses/index.js";
import { renderMarkdownReport, renderReportJson } from "../reporting/index.js";
import type { InvestigationInput } from "../types.js";

type CommandName = "prepare" | "inspect" | "correlate" | "report";

interface ParsedCommand {
  name: CommandName;
  flags: Record<string, string>;
}

function printHelp(): void {
  console.log(`kibtrace

Usage:
  kibtrace prepare --logs <path> --repo <path> [--out <dir>]
  kibtrace inspect --session <path>
  kibtrace correlate --session <path>
  kibtrace report --session <path>
`);
}

function parseCommand(argv: string[]): ParsedCommand | null {
  const [name, ...rest] = argv;
  if (!name || !["prepare", "inspect", "correlate", "report"].includes(name)) {
    return null;
  }

  const flags: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token?.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for flag --${key}`);
    }

    flags[key] = value;
    index += 1;
  }

  return {
    name: name as CommandName,
    flags
  };
}

function requireFlag(flags: Record<string, string>, key: string): string {
  const value = flags[key];
  if (!value) {
    throw new Error(`Missing required flag --${key}`);
  }

  return value;
}

function createSessionDir(baseOutDir?: string): string {
  const now = new Date().toISOString().replaceAll(":", "-");
  const randomSuffix = Math.random().toString(36).slice(2, 8);
  const root = baseOutDir ?? path.join(process.cwd(), ".kibtrace", "sessions");
  return path.join(root, `${now}-${randomSuffix}`);
}

async function handlePrepare(flags: Record<string, string>): Promise<void> {
  const logsPath = requireFlag(flags, "logs");
  const repoPath = requireFlag(flags, "repo");
  const outDir = createSessionDir(flags.out);
  const input: InvestigationInput = {
    logsPath,
    repoPath,
    outDir,
    since: flags.since,
    until: flags.until,
    service: flags.service,
    environment: flags.env
  };

  await mkdir(outDir, { recursive: true });

  const ingestion = await ingestLogs(logsPath);
  const normalized = normalizeEvents(ingestion);
  const reduced = reduceEvidence(ingestion, normalized);
  const correlation = await correlateRepository({
    repoPath,
    clusters: reduced.clusters
  });
  const hypotheses = buildHypotheses(reduced, correlation);

  const session: SessionArtifact = {
    schemaVersion: "0.1.0",
    sessionId: path.basename(outDir),
    createdAt: new Date().toISOString(),
    input,
    evidence: reduced,
    correlation,
    hypotheses,
    artifacts: {
      sessionPath: path.join(outDir, "session.json"),
      reportJsonPath: path.join(outDir, "report.json"),
      reportMarkdownPath: path.join(outDir, "report.md")
    }
  };

  await writeSessionArtifact(session.artifacts.sessionPath, session);
  await writeFile(
    session.artifacts.reportJsonPath,
    JSON.stringify(renderReportJson(session), null, 2),
    "utf8"
  );
  await writeFile(
    session.artifacts.reportMarkdownPath,
    renderMarkdownReport(session),
    "utf8"
  );

  console.log(JSON.stringify({
    ok: true,
    command: "prepare",
    sessionPath: session.artifacts.sessionPath,
    reportJsonPath: session.artifacts.reportJsonPath,
    reportMarkdownPath: session.artifacts.reportMarkdownPath
  }, null, 2));
}

async function handleInspect(flags: Record<string, string>): Promise<void> {
  const sessionPath = requireFlag(flags, "session");
  const session = await loadSessionArtifact(sessionPath);

  console.log(JSON.stringify({
    ok: true,
    command: "inspect",
    sessionId: session.sessionId,
    clusterCount: session.evidence.clusters.length,
    clusters: session.evidence.clusters
  }, null, 2));
}

async function handleCorrelate(flags: Record<string, string>): Promise<void> {
  const sessionPath = requireFlag(flags, "session");
  const session = await loadSessionArtifact(sessionPath);

  console.log(JSON.stringify({
    ok: true,
    command: "correlate",
    sessionId: session.sessionId,
    correlation: session.correlation,
    hypotheses: session.hypotheses
  }, null, 2));
}

async function handleReport(flags: Record<string, string>): Promise<void> {
  const sessionPath = requireFlag(flags, "session");
  const session = await loadSessionArtifact(sessionPath);
  const markdown = await readFile(session.artifacts.reportMarkdownPath, "utf8");

  console.log(markdown);
}

async function main(): Promise<void> {
  const parsed = parseCommand(process.argv.slice(2));
  if (!parsed) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  switch (parsed.name) {
    case "prepare":
      await handlePrepare(parsed.flags);
      break;
    case "inspect":
      await handleInspect(parsed.flags);
      break;
    case "correlate":
      await handleCorrelate(parsed.flags);
      break;
    case "report":
      await handleReport(parsed.flags);
      break;
    default:
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`kibtrace error: ${message}`);
  process.exitCode = 1;
});

