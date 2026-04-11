#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  fetchFromElastic,
  ingestFiles,
  loadHitsFromDir
} from "../ingest/index.js";
import { normalizeElasticHits, normalizeFileEvents } from "../normalize/index.js";
import { reduceEvidence } from "../reduce/index.js";
import {
  loadSessionArtifact,
  SESSION_SCHEMA_VERSION,
  type SessionArtifact,
  writeSessionArtifact
} from "../evidence/session.js";
import { correlateRepository } from "../repo-context/index.js";
import { buildHypotheses } from "../hypotheses/index.js";
import { renderMarkdownReport, renderReportJson } from "../reporting/index.js";
import { runQuery } from "../query/index.js";
import type {
  FetchConfig,
  InvestigationInput,
  NormalizedEvent,
  QueryViewName
} from "../types.js";

type CommandName = "fetch" | "prepare" | "inspect" | "correlate" | "report" | "query";

interface ParsedCommand {
  name: CommandName;
  flags: Record<string, string>;
}

const COMMANDS: CommandName[] = ["fetch", "prepare", "inspect", "correlate", "report", "query"];

function printHelp(): void {
  console.log(`kibtrace v0.3.0

Usage:
  kibtrace fetch     --es-url <url> --index <pattern> --since <iso> --until <iso>
                     [--service <name>] [--env <env>] [--api-key <key>] [--max-hits <n>] [--out <dir>]
  kibtrace prepare   --session <session.json> --repo <path>
  kibtrace prepare   --logs <path> --repo <path> [--out <dir>]      (legacy file mode)
  kibtrace query     --session <session.json> --view <name>
                     [--id <cluster-id>] [--service <name>] [--trace <id>] [--limit <n>]
                     views: clusters | cluster | latest-errors | service | trace
  kibtrace inspect   --session <session.json>
  kibtrace correlate --session <session.json>
  kibtrace report    --session <session.json>

Auth:
  --api-key <key>           or env KIBTRACE_ES_API_KEY
  (no auth allowed for sandbox)

Notes:
  Secrets (--api-key, KIBTRACE_ES_API_KEY) are never logged or written to session files.
`);
}

function parseCommand(argv: string[]): ParsedCommand | null {
  const [name, ...rest] = argv;
  if (!name || !COMMANDS.includes(name as CommandName)) {
    return null;
  }

  const flags: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token?.startsWith("--")) continue;

    const key = token.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for flag --${key}`);
    }

    flags[key] = value;
    index += 1;
  }

  return { name: name as CommandName, flags };
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

// ---------- fetch ----------

async function handleFetch(flags: Record<string, string>): Promise<void> {
  const esUrl = requireFlag(flags, "es-url");
  const indexPattern = requireFlag(flags, "index");
  const since = requireFlag(flags, "since");
  const until = requireFlag(flags, "until");
  const service = flags.service;
  const environment = flags.env;
  const apiKey = flags["api-key"] ?? process.env.KIBTRACE_ES_API_KEY;
  const maxHits = flags["max-hits"] ? Number.parseInt(flags["max-hits"], 10) : 50000;
  const pageSize = 1000;

  if (Number.isNaN(maxHits) || maxHits <= 0) {
    throw new Error("--max-hits must be a positive integer");
  }

  const outDir = createSessionDir(flags.out);
  const rawHitsDir = path.join(outDir, "raw");
  await mkdir(rawHitsDir, { recursive: true });

  const config: FetchConfig = {
    esUrl,
    indexPattern,
    since,
    until,
    service,
    environment,
    pageSize,
    maxHits,
    apiKey
  };

  const { manifest } = await fetchFromElastic(config, rawHitsDir);

  const input: InvestigationInput = {
    sourceMode: "elastic",
    outDir,
    since,
    until,
    service,
    environment
  };

  const session: SessionArtifact = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    sessionId: path.basename(outDir),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sourceMode: "elastic",
    input,
    fetch: manifest,
    artifacts: {
      sessionPath: path.join(outDir, "session.json"),
      rawHitsDir
    }
  };

  await writeSessionArtifact(session.artifacts.sessionPath, session);

  console.log(JSON.stringify({
    ok: true,
    command: "fetch",
    sessionPath: session.artifacts.sessionPath,
    rawHitsDir,
    fetched: {
      pages: manifest.pageCount,
      hits: manifest.fetchedHits,
      totalHits: manifest.totalHits,
      indexPattern: manifest.indexPattern,
      since: manifest.since,
      until: manifest.until,
      service: manifest.service,
      authMode: manifest.authMode
    }
  }, null, 2));
}

// ---------- prepare ----------

async function preparePipeline(
  session: SessionArtifact,
  events: NormalizedEvent[],
  artifacts: { discoveredArtifacts: string[]; totalBytes: number },
  repoPath: string
): Promise<SessionArtifact> {
  const reduced = reduceEvidence(artifacts, events);
  const correlation = await correlateRepository({
    repoPath,
    clusters: reduced.clusters
  });
  const hypotheses = buildHypotheses(reduced, correlation);

  const outDir = session.input.outDir;
  const normalizedEventsPath = path.join(outDir, "normalized-events.json");
  const reportJsonPath = path.join(outDir, "report.json");
  const reportMarkdownPath = path.join(outDir, "report.md");

  await writeFile(normalizedEventsPath, JSON.stringify(events, null, 2), "utf8");

  const updated: SessionArtifact = {
    ...session,
    updatedAt: new Date().toISOString(),
    input: { ...session.input, repoPath },
    evidence: reduced,
    correlation,
    hypotheses,
    artifacts: {
      ...session.artifacts,
      normalizedEventsPath,
      reportJsonPath,
      reportMarkdownPath
    }
  };

  await writeFile(reportJsonPath, JSON.stringify(renderReportJson(updated), null, 2), "utf8");
  await writeFile(reportMarkdownPath, renderMarkdownReport(updated), "utf8");

  await writeSessionArtifact(updated.artifacts.sessionPath, updated);
  return updated;
}

async function handlePrepareFromSession(flags: Record<string, string>): Promise<void> {
  const sessionPath = requireFlag(flags, "session");
  const repoPath = requireFlag(flags, "repo");

  const session = await loadSessionArtifact(sessionPath);

  if (session.sourceMode !== "elastic") {
    throw new Error(
      `Session sourceMode is "${session.sourceMode}" — use legacy --logs flow instead.`
    );
  }
  if (!session.artifacts.rawHitsDir) {
    throw new Error("Session has no rawHitsDir.");
  }

  const hits = await loadHitsFromDir(session.artifacts.rawHitsDir);
  const events = normalizeElasticHits(hits);

  // Compute total raw bytes for evidence
  let totalBytes = 0;
  for (const f of session.fetch?.pageFiles ?? []) {
    try {
      const stat = await readFile(path.join(session.artifacts.rawHitsDir, f));
      totalBytes += stat.length;
    } catch {
      // ignore
    }
  }

  const updated = await preparePipeline(
    session,
    events,
    {
      discoveredArtifacts: (session.fetch?.pageFiles ?? []).map((f) =>
        path.join(session.artifacts.rawHitsDir!, f)
      ),
      totalBytes
    },
    repoPath
  );

  console.log(JSON.stringify({
    ok: true,
    command: "prepare",
    mode: "session",
    sessionPath: updated.artifacts.sessionPath,
    stats: {
      hits: hits.length,
      normalizedEvents: events.length,
      clusters: updated.evidence?.clusters.length ?? 0,
      codeCorrelations: updated.correlation?.probableCodeAreas.length ?? 0,
      hypotheses: updated.hypotheses?.length ?? 0
    }
  }, null, 2));
}

async function handlePrepareFromFiles(flags: Record<string, string>): Promise<void> {
  const logsPath = requireFlag(flags, "logs");
  const repoPath = requireFlag(flags, "repo");
  const outDir = createSessionDir(flags.out);

  await mkdir(outDir, { recursive: true });

  const ingestion = await ingestFiles(logsPath);
  const events = normalizeFileEvents(ingestion);

  const input: InvestigationInput = {
    sourceMode: "file",
    logsPath,
    repoPath,
    outDir,
    since: flags.since,
    until: flags.until,
    service: flags.service,
    environment: flags.env
  };

  const session: SessionArtifact = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    sessionId: path.basename(outDir),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sourceMode: "file",
    input,
    artifacts: {
      sessionPath: path.join(outDir, "session.json")
    }
  };

  // Persist initial skeleton so preparePipeline can update it
  await writeSessionArtifact(session.artifacts.sessionPath, session);

  const updated = await preparePipeline(
    session,
    events,
    {
      discoveredArtifacts: Object.keys(ingestion.formats),
      totalBytes: ingestion.totalBytes
    },
    repoPath
  );

  console.log(JSON.stringify({
    ok: true,
    command: "prepare",
    mode: "file",
    sessionPath: updated.artifacts.sessionPath,
    stats: {
      logFiles: ingestion.fileCount,
      totalBytes: ingestion.totalBytes,
      normalizedEvents: events.length,
      clusters: updated.evidence?.clusters.length ?? 0,
      codeCorrelations: updated.correlation?.probableCodeAreas.length ?? 0,
      hypotheses: updated.hypotheses?.length ?? 0
    }
  }, null, 2));
}

async function handlePrepare(flags: Record<string, string>): Promise<void> {
  if (flags.session) {
    await handlePrepareFromSession(flags);
  } else if (flags.logs) {
    await handlePrepareFromFiles(flags);
  } else {
    throw new Error("prepare requires either --session <path> or --logs <path>");
  }
}

// ---------- query ----------

async function handleQuery(flags: Record<string, string>): Promise<void> {
  const sessionPath = requireFlag(flags, "session");
  const view = requireFlag(flags, "view") as QueryViewName;
  const session = await loadSessionArtifact(sessionPath);

  const limit = flags.limit ? Number.parseInt(flags.limit, 10) : undefined;

  const result = await runQuery(session, {
    view,
    clusterId: flags.id,
    service: flags.service,
    trace: flags.trace,
    ...(limit !== undefined ? { limit } : {})
  });

  console.log(JSON.stringify({ ok: true, command: "query", ...result }, null, 2));
}

// ---------- inspect ----------

async function handleInspect(flags: Record<string, string>): Promise<void> {
  const sessionPath = requireFlag(flags, "session");
  const session = await loadSessionArtifact(sessionPath);

  console.log(JSON.stringify({
    ok: true,
    command: "inspect",
    sessionId: session.sessionId,
    schemaVersion: session.schemaVersion,
    sourceMode: session.sourceMode,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    fetch: session.fetch
      ? {
          indexPattern: session.fetch.indexPattern,
          since: session.fetch.since,
          until: session.fetch.until,
          service: session.fetch.service,
          fetchedHits: session.fetch.fetchedHits,
          totalHits: session.fetch.totalHits,
          pageCount: session.fetch.pageCount,
          authMode: session.fetch.authMode
        }
      : null,
    evidence: session.evidence
      ? {
          discoveredArtifacts: session.evidence.discoveredArtifacts.length,
          totalBytes: session.evidence.totalBytes,
          normalizedEvents: session.evidence.normalizedEvents,
          clusterCount: session.evidence.clusters.length
        }
      : null,
    clusters: (session.evidence?.clusters ?? []).slice(0, 10).map((c) => ({
      id: c.id,
      summary: c.summary,
      count: c.count,
      levels: c.levels
    }))
  }, null, 2));
}

// ---------- correlate ----------

async function handleCorrelate(flags: Record<string, string>): Promise<void> {
  const sessionPath = requireFlag(flags, "session");
  const session = await loadSessionArtifact(sessionPath);

  if (!session.correlation || !session.hypotheses) {
    throw new Error("Session has no correlation. Run `kibtrace prepare --session <path>` first.");
  }

  console.log(JSON.stringify({
    ok: true,
    command: "correlate",
    sessionId: session.sessionId,
    correlation: {
      repoPath: session.correlation.repoPath,
      codeAreaCount: session.correlation.probableCodeAreas.length,
      codeAreas: session.correlation.probableCodeAreas,
      suggestedOwners: session.correlation.suggestedOwners
    },
    hypotheses: session.hypotheses.map((h) => ({
      id: h.id,
      summary: h.summary,
      confidence: h.confidence,
      signalCount: h.supportingSignals.length,
      counterCount: h.counterEvidence.length
    }))
  }, null, 2));
}

// ---------- report ----------

async function handleReport(flags: Record<string, string>): Promise<void> {
  const sessionPath = requireFlag(flags, "session");
  const session = await loadSessionArtifact(sessionPath);

  if (!session.artifacts.reportMarkdownPath) {
    throw new Error("Session has no report. Run `kibtrace prepare --session <path>` first.");
  }

  const markdown = await readFile(session.artifacts.reportMarkdownPath, "utf8");
  console.log(markdown);
}

// ---------- main ----------

async function main(): Promise<void> {
  const parsed = parseCommand(process.argv.slice(2));
  if (!parsed) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  switch (parsed.name) {
    case "fetch":
      await handleFetch(parsed.flags);
      break;
    case "prepare":
      await handlePrepare(parsed.flags);
      break;
    case "query":
      await handleQuery(parsed.flags);
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
