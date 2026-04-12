#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  fetchFromElastic,
  ingestFiles,
  loadHitsFromDir
} from "../ingest/index.js";
import { normalizeElasticHits, normalizeFileEvents } from "../normalize/index.js";
import { buildClusters } from "../reduce/index.js";
import { extractEvidence } from "../evidence/extract.js";
import {
  loadSessionArtifact,
  SESSION_SCHEMA_VERSION,
  type SessionArtifact,
  writeSessionArtifact
} from "../evidence/session.js";
import {
  attachCodeCandidatesToItems,
  correlateRepository
} from "../repo-context/index.js";
import { buildHypotheses } from "../hypotheses/index.js";
import { renderMarkdownReport, renderReportJson } from "../reporting/index.js";
import { runQuery } from "../query/index.js";
import type {
  ClusterSummary,
  CodeCandidate,
  EvidenceItem,
  FetchConfig,
  InvestigationInput,
  NormalizedEvent,
  PreparedEvidence,
  QueryViewName
} from "../types.js";
import {
  colorLevel,
  dominantLevel,
  emit,
  hint,
  kv,
  kvList,
  makePalette,
  type OutputOptions,
  type Palette,
  shortTime,
  shouldUseColor,
  statusError,
  title,
  visualPad,
  visualPadStart
} from "./format.js";
import { resolveRequiredSession } from "./session-resolve.js";

type CommandName = "fetch" | "prepare" | "inspect" | "correlate" | "report" | "query";

interface ParsedCommand {
  name: CommandName | "help";
  flags: Record<string, string>;
}

const COMMANDS: CommandName[] = ["fetch", "prepare", "inspect", "correlate", "report", "query"];
const BOOLEAN_FLAGS = new Set(["human", "no-color", "help", "latest"]);

// ---------- arg parsing ----------

function parseFlags(tokens: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token?.startsWith("--") && token !== "-h") continue;

    const key = token === "-h" ? "help" : token.slice(2);

    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = "true";
      continue;
    }

    const value = tokens[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for flag --${key}`);
    }

    flags[key] = value;
    index += 1;
  }
  return flags;
}

function parseCommand(argv: string[]): ParsedCommand | null {
  if (argv.length === 0) return null;

  const first = argv[0]!;

  if (first === "--help" || first === "-h" || first === "help") {
    const flags = parseFlags(argv.slice(1));
    return { name: "help", flags };
  }

  if (!COMMANDS.includes(first as CommandName)) {
    return null;
  }

  const flags = parseFlags(argv.slice(1));
  if (flags.help === "true") {
    return { name: "help", flags };
  }

  return { name: first as CommandName, flags };
}

function requireFlag(flags: Record<string, string>, key: string): string {
  const value = flags[key];
  if (!value) {
    throw new Error(`Missing required flag --${key}`);
  }
  return value;
}

function buildOutput(flags: Record<string, string>): OutputOptions {
  const mode = flags.human === "true" ? "human" : "machine";
  const color = shouldUseColor(flags["no-color"] === "true", mode);
  return { mode, color };
}

function createSessionDir(baseOutDir?: string): string {
  const now = new Date().toISOString().replaceAll(":", "-");
  const randomSuffix = Math.random().toString(36).slice(2, 8);
  const root = baseOutDir ?? path.join(process.cwd(), ".kibtrace", "sessions");
  return path.join(root, `${now}-${randomSuffix}`);
}

function relSession(sessionPath: string): string {
  const rel = path.relative(process.cwd(), sessionPath);
  return rel.length < sessionPath.length ? rel : sessionPath;
}

// ---------- help ----------

function handleHelp(flags: Record<string, string>): void {
  const color = shouldUseColor(flags["no-color"] === "true", "human");
  const p = makePalette(color);

  emit([
    `${p.bold(p.cyan("kibtrace"))} ${p.dim("0.4.0")}`,
    p.dim("elastic-to-code incident investigation"),
    "",
    p.dim("USAGE"),
    "  kibtrace <command> [flags]",
    "",
    p.dim("COMMANDS"),
    `  ${p.cyan("fetch")}      fetch logs from Elasticsearch / OpenSearch`,
    `  ${p.cyan("prepare")}    normalize, cluster, extract evidence, correlate code`,
    `  ${p.cyan("query")}      focused evidence slices for Claude`,
    `  ${p.cyan("inspect")}    summary of a session`,
    `  ${p.cyan("correlate")}  show top code candidates and hypotheses`,
    `  ${p.cyan("report")}     print the markdown report`,
    "",
    p.dim("QUERY VIEWS"),
    `  ${p.cyan("incident-summary")}   compact one-call summary for Claude`,
    `  ${p.cyan("top-evidence")}       ranked evidence items (header only)`,
    `  ${p.cyan("evidence")}           full evidence item, requires --id <evidence-id>`,
    `  ${p.cyan("code-candidates")}    ranked code locations`,
    `  ${p.cyan("clusters")}           low-level cluster table (debug)`,
    `  ${p.cyan("cluster")}            single cluster, requires --id <cluster-id>`,
    `  ${p.cyan("latest-errors")}      most recent ERROR/FATAL events`,
    `  ${p.cyan("service")}            events scoped to a service`,
    `  ${p.cyan("trace")}              events sharing a trace.id`,
    "",
    p.dim("SESSION SELECTORS"),
    `  --session <path>     explicit session.json path`,
    `  --session-id <id>    resolve .kibtrace/sessions/<id>/session.json`,
    `  --latest             resolve the most recent local session`,
    "",
    p.dim("GLOBAL FLAGS"),
    `  --human       human-readable output (default is JSON)`,
    `  --no-color    disable ANSI colors`,
    "",
    p.dim("AUTH"),
    `  --api-key <key>     or env KIBTRACE_ES_API_KEY`,
    `                      no auth needed for the local sandbox`,
    "",
    p.dim("EXAMPLE"),
    `  kibtrace fetch --human \\`,
    `    --es-url http://127.0.0.1:9200 \\`,
    `    --index 'kibtrace-sandbox-*' \\`,
    `    --since 2026-04-11T00:00:00Z \\`,
    `    --until 2026-04-11T23:59:59Z \\`,
    `    --service cv-db-failure-app`,
    "",
    `  kibtrace prepare --latest --repo .`,
    `  kibtrace query   --latest --view incident-summary`,
    `  kibtrace report  --latest`,
    "",
    p.dim("JSON output (the default) is intended for Claude Code and automation."),
    ""
  ]);
}

// ---------- fetch ----------

async function handleFetch(flags: Record<string, string>, output: OutputOptions): Promise<void> {
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

  if (output.mode === "machine") {
    console.log(JSON.stringify({
      ok: true,
      command: "fetch",
      sessionId: session.sessionId,
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
    return;
  }

  const p = makePalette(output.color);
  const sessionDisplay = relSession(session.artifacts.sessionPath);
  const hitsDisplay = manifest.totalHits != null
    ? `${manifest.fetchedHits} / ${manifest.totalHits}`
    : String(manifest.fetchedHits);

  emit([
    title(p, "fetch"),
    "",
    kv(p, "target", manifest.esUrl),
    kv(p, "index", manifest.indexPattern),
    kv(p, "window", `${manifest.since} → ${manifest.until}`),
    kv(p, "service", manifest.service),
    kv(p, "auth", manifest.authMode),
    kv(p, "pages", String(manifest.pageCount)),
    kv(p, "hits", hitsDisplay),
    "",
    kv(p, "id", session.sessionId),
    kv(p, "session", sessionDisplay),
    "",
    hint(p, `kibtrace prepare --human --latest --repo .`),
    ""
  ]);
}

// ---------- prepare ----------

async function preparePipeline(
  session: SessionArtifact,
  events: NormalizedEvent[],
  artifacts: { discoveredArtifacts: string[]; totalBytes: number },
  repoPath: string
): Promise<SessionArtifact> {
  // 1. Build clusters (debug-level abstraction)
  const clusters = buildClusters(events);

  // 2. Extract ranked evidence items (signal-level abstraction)
  let items = extractEvidence(events, clusters);

  // 3. Code correlation: stack-frame-first, keyword fallback
  const correlation = await correlateRepository({
    repoPath,
    events,
    clusters
  });

  // 4. Attach matching code candidates to evidence items
  items = attachCodeCandidatesToItems(items, correlation.candidates);

  // 5. Bump scores for items that now have a resolved code candidate
  items = items.map((item) =>
    item.codeCandidates && item.codeCandidates.length > 0
      ? { ...item, score: item.score + 30 }
      : item
  );

  // Re-sort after the score bump and re-derive severity tiers if needed
  items.sort((a, b) => b.score - a.score);

  const evidence: PreparedEvidence = {
    discoveredArtifacts: artifacts.discoveredArtifacts,
    totalBytes: artifacts.totalBytes,
    normalizedEvents: events.length,
    clusters,
    items,
    topCodeCandidates: correlation.candidates.slice(0, 10)
  };

  // 6. Hypotheses derived from top evidence
  const hypotheses = buildHypotheses(evidence);

  const outDir = session.input.outDir;
  const normalizedEventsPath = path.join(outDir, "normalized-events.json");
  const reportJsonPath = path.join(outDir, "report.json");
  const reportMarkdownPath = path.join(outDir, "report.md");

  await writeFile(normalizedEventsPath, JSON.stringify(events, null, 2), "utf8");

  const updated: SessionArtifact = {
    ...session,
    updatedAt: new Date().toISOString(),
    input: { ...session.input, repoPath },
    evidence,
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

interface PrepareOutcome {
  session: SessionArtifact;
  hits: number;
  events: number;
  logFiles?: number;
  totalBytes?: number;
  mode: "session" | "file";
}

async function runPrepareFromSession(
  sessionPath: string,
  repoPath: string
): Promise<PrepareOutcome> {
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

  return { session: updated, hits: hits.length, events: events.length, mode: "session" };
}

async function runPrepareFromFiles(flags: Record<string, string>): Promise<PrepareOutcome> {
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

  return {
    session: updated,
    hits: events.length,
    events: events.length,
    logFiles: ingestion.fileCount,
    totalBytes: ingestion.totalBytes,
    mode: "file"
  };
}

async function handlePrepare(flags: Record<string, string>, output: OutputOptions): Promise<void> {
  let outcome: PrepareOutcome;

  if (flags.logs) {
    outcome = await runPrepareFromFiles(flags);
  } else if (flags.session || flags["session-id"] || flags.latest === "true") {
    const ref = await resolveRequiredSession(process.cwd(), flags);
    const repoPath = requireFlag(flags, "repo");
    outcome = await runPrepareFromSession(ref.sessionPath, repoPath);
  } else {
    throw new Error(
      "prepare requires a session selector (--latest, --session-id <id>, --session <path>) " +
      "or --logs <path> for legacy file mode."
    );
  }

  const updated = outcome.session;
  const evidence = updated.evidence;
  const clusters = evidence?.clusters.length ?? 0;
  const evidenceItems = evidence?.items.length ?? 0;
  const codeCandidates = evidence?.topCodeCandidates.length ?? 0;
  const hypotheses = updated.hypotheses?.length ?? 0;
  const topItem = evidence?.items[0];
  const topCode = evidence?.topCodeCandidates[0];

  if (output.mode === "machine") {
    console.log(JSON.stringify({
      ok: true,
      command: "prepare",
      mode: outcome.mode,
      sessionId: updated.sessionId,
      sessionPath: updated.artifacts.sessionPath,
      stats: {
        ...(outcome.mode === "file"
          ? { logFiles: outcome.logFiles, totalBytes: outcome.totalBytes }
          : { hits: outcome.hits }),
        normalizedEvents: outcome.events,
        clusters,
        evidenceItems,
        topCodeCandidates: codeCandidates,
        hypotheses
      },
      top: topItem
        ? {
            evidenceId: topItem.id,
            kind: topItem.kind,
            title: topItem.title,
            score: topItem.score,
            severity: topItem.severity
          }
        : null,
      topCodeCandidate: topCode
        ? { path: topCode.path, line: topCode.line, score: topCode.score }
        : null
    }, null, 2));
    return;
  }

  const p = makePalette(output.color);
  const sessionDisplay = relSession(updated.artifacts.sessionPath);

  emit([
    title(p, "prepare"),
    "",
    kv(p, "id", updated.sessionId),
    kv(p, "session", sessionDisplay),
    kv(p, "source", updated.sourceMode),
    kv(p, "events", String(outcome.events)),
    kv(p, "clusters", String(clusters)),
    kv(p, "evidence", String(evidenceItems)),
    kv(p, "code", String(codeCandidates)),
    kv(p, "hypotheses", String(hypotheses)),
    "",
    topItem ? kv(p, "top", `${topItem.title}  ${p.dim(`[${topItem.severity}]`)}`) : null,
    topCode ? kv(p, "origin", `${topCode.path}${topCode.line ? `:${topCode.line}` : ""}`) : null,
    "",
    kvList(p, "written", [
      "session.json",
      "normalized-events.json",
      "report.json",
      "report.md"
    ]),
    "",
    hint(p, `kibtrace query --human --latest --view incident-summary`),
    hint(p, `kibtrace report --latest`),
    ""
  ]);
}

// ---------- query ----------

interface ClustersResultShape {
  totalClusters: number;
  returned: number;
  clusters: Array<{
    id: string;
    summary: string;
    fingerprint: string;
    count: number;
    levels: Record<string, number>;
    sampleEventIds: string[];
    excerptCount: number;
  }>;
}

interface EventsResultShape {
  events: Array<{
    id: string;
    timestamp?: string;
    level?: string;
    service?: string;
    traceId?: string;
    message: string;
    stackTracePreview?: string[];
    sourceFile: string;
  }>;
  totalErrors?: number;
  returned?: number;
  service?: string;
  traceId?: string;
}

interface IncidentSummaryShape {
  summary: string;
  totalEvents: number;
  totalClusters: number;
  totalEvidence: number;
  topEvidence: Array<{
    id: string;
    kind: string;
    title: string;
    summary: string;
    score: number;
    severity: string;
    signals: string[];
    relatedTraceIds: string[];
  }>;
  topCodeCandidates: CodeCandidate[];
  keyTraceIds: string[];
  hypotheses: Array<{
    id: string;
    summary: string;
    confidence: string;
    backedByEvidenceIds: string[];
  }>;
}

interface TopEvidenceShape {
  totalEvidence: number;
  returned: number;
  items: Array<{
    id: string;
    kind: string;
    title: string;
    score: number;
    severity: string;
  }>;
}

interface CodeCandidatesShape {
  total: number;
  returned: number;
  candidates: CodeCandidate[];
}

function severityColor(p: Palette, sev: string): string {
  switch (sev) {
    case "high": return p.red(sev.toUpperCase());
    case "medium": return p.yellow(sev.toUpperCase());
    default: return p.dim(sev.toUpperCase());
  }
}

function renderClustersHuman(p: Palette, sessionDisplay: string, payload: ClustersResultShape): void {
  const idWidth = Math.max(9, ...payload.clusters.map((c) => c.id.length));
  const countWidth = Math.max(5, ...payload.clusters.map((c) => String(c.count).length));

  emit([
    title(p, "query", "clusters"),
    "",
    kv(p, "total", String(payload.totalClusters)),
    kv(p, "showing", String(payload.returned)),
    ""
  ]);

  for (const c of payload.clusters) {
    const id = visualPad(p.cyan(c.id), idWidth);
    const count = visualPadStart(String(c.count), countWidth);
    const level = colorLevel(p, dominantLevel(c.levels), 5);
    console.log(`  ${id}  ${count}  ${level}  ${c.summary}`);
  }
  console.log("");
}

function renderClusterDetailHuman(p: Palette, payload: unknown): void {
  if (!payload || typeof payload !== "object" || !("id" in payload)) {
    if (payload && typeof payload === "object" && "error" in payload) {
      emit([
        title(p, "query", "cluster"),
        "",
        statusError(p, String((payload as { error: unknown }).error)),
        ""
      ]);
      return;
    }
    return;
  }

  const c = payload as ClusterSummary;
  const dominantLvl = dominantLevel(c.levels);
  const levelLine = `${colorLevel(p, dominantLvl, 5)} (${Object.entries(c.levels).map(([k, v]) => `${k}=${v}`).join(", ")})`;

  emit([
    title(p, "query", "cluster"),
    "",
    kv(p, "id", c.id),
    kv(p, "count", String(c.count)),
    kv(p, "level", levelLine),
    kv(p, "fingerprint", c.fingerprint),
    "",
    kv(p, "summary", c.summary),
    ""
  ]);

  if (c.representativeExcerpts.length > 0) {
    emit([p.dim("  EXCERPTS")]);
    for (const ex of c.representativeExcerpts) {
      const trimmed = ex.length > 200 ? ex.slice(0, 197) + "..." : ex;
      console.log(`    ${trimmed}`);
    }
    console.log("");
  }
}

function renderEventListHuman(
  p: Palette,
  view: "latest-errors" | "service" | "trace",
  sessionDisplay: string,
  payload: EventsResultShape
): void {
  const events = payload.events;
  const subtitle = view === "service"
    ? payload.service ?? ""
    : view === "trace"
      ? payload.traceId ?? ""
      : "";

  emit([
    title(p, "query", view + (subtitle ? "  " + subtitle : "")),
    ""
  ]);

  const meta: Array<string | null> = [];
  if (payload.totalErrors !== undefined) meta.push(kv(p, "total", String(payload.totalErrors)));
  if (payload.returned !== undefined) meta.push(kv(p, "showing", String(payload.returned)));
  if (meta.some((m) => m !== null)) {
    emit([...meta, ""]);
  }

  if (events.length === 0) {
    emit([p.dim("  (no matching events)"), ""]);
    return;
  }

  const useShort = view === "trace";

  for (const e of events) {
    const ts = useShort ? shortTime(e.timestamp) : (e.timestamp ?? "?");
    const tsCell = visualPad(p.dim(ts), useShort ? 12 : 24);
    const level = colorLevel(p, e.level, 5);
    const svc = view === "service" ? "" : (e.service ? `${visualPad(p.dim(e.service), 22)}  ` : "");
    console.log(`  ${tsCell}  ${level}  ${svc}${e.message}`);
  }

  const firstWithStack = events.find((e) => e.stackTracePreview && e.stackTracePreview.length > 0);
  if (firstWithStack && firstWithStack.stackTracePreview) {
    console.log("");
    console.log(`  ${p.dim("STACK".padEnd(14))}${firstWithStack.id}`);
    for (const line of firstWithStack.stackTracePreview.slice(0, 5)) {
      console.log(`  ${" ".repeat(14)}${p.dim(line)}`);
    }
  }
  console.log("");

  if (view === "latest-errors") {
    const firstTrace = events.find((e) => e.traceId)?.traceId;
    if (firstTrace) {
      emit([
        hint(p, `kibtrace query --human --session ${sessionDisplay} --view trace --trace ${firstTrace}`),
        ""
      ]);
    }
  }
}

function renderIncidentSummaryHuman(p: Palette, sessionDisplay: string, payload: IncidentSummaryShape): void {
  emit([
    title(p, "query", "incident-summary"),
    "",
    kv(p, "events", String(payload.totalEvents)),
    kv(p, "clusters", String(payload.totalClusters)),
    kv(p, "evidence", String(payload.totalEvidence)),
    "",
    kv(p, "summary", payload.summary),
    ""
  ]);

  if (payload.topEvidence.length > 0) {
    emit([p.dim("  TOP EVIDENCE")]);
    for (const item of payload.topEvidence) {
      const sev = severityColor(p, item.severity);
      console.log(`    ${visualPad(sev, 8)}  ${p.cyan(item.id)}  ${item.title}`);
      if (item.signals.length > 0) {
        console.log(`              ${p.dim(item.signals.slice(0, 2).join("; "))}`);
      }
    }
    console.log("");
  }

  if (payload.topCodeCandidates.length > 0) {
    emit([p.dim("  LIKELY CODE ORIGIN")]);
    for (const c of payload.topCodeCandidates.slice(0, 5)) {
      const loc = c.line !== undefined ? `:${c.line}` : "";
      console.log(`    ${visualPadStart(String(c.score), 5)}  ${p.cyan(c.path)}${p.dim(loc)}  ${p.dim(c.reason)}`);
    }
    console.log("");
  }

  if (payload.hypotheses.length > 0) {
    emit([p.dim("  HYPOTHESES")]);
    for (const h of payload.hypotheses) {
      const conf =
        h.confidence === "high" ? p.green("HIGH") :
        h.confidence === "medium" ? p.yellow("MEDIUM") :
        p.dim("LOW");
      console.log(`    ${visualPad(conf, 8)}  ${p.cyan(h.id)}  ${h.summary}`);
    }
    console.log("");
  }

  if (payload.keyTraceIds.length > 0) {
    emit([p.dim("  KEY TRACE IDS")]);
    for (const t of payload.keyTraceIds) {
      console.log(`    ${p.dim(t)}`);
    }
    console.log("");
  }

  emit([
    hint(p, `kibtrace query --human --session ${sessionDisplay} --view evidence --id ${payload.topEvidence[0]?.id ?? "<id>"}`),
    ""
  ]);
}

function renderTopEvidenceHuman(p: Palette, sessionDisplay: string, payload: TopEvidenceShape): void {
  emit([
    title(p, "query", "top-evidence"),
    "",
    kv(p, "total", String(payload.totalEvidence)),
    kv(p, "showing", String(payload.returned)),
    ""
  ]);

  for (const item of payload.items) {
    const sev = severityColor(p, item.severity);
    const score = visualPadStart(String(item.score), 5);
    console.log(`  ${visualPad(sev, 8)}  ${score}  ${p.cyan(item.id)}  ${p.dim(item.kind.padEnd(14))}${item.title}`);
  }
  console.log("");

  if (payload.items.length > 0) {
    emit([
      hint(p, `kibtrace query --human --session ${sessionDisplay} --view evidence --id ${payload.items[0]!.id}`),
      ""
    ]);
  }
}

function renderEvidenceDetailHuman(p: Palette, payload: unknown): void {
  if (!payload || typeof payload !== "object") return;
  if ("error" in payload) {
    emit([title(p, "query", "evidence"), "", statusError(p, String((payload as { error: unknown }).error)), ""]);
    return;
  }
  const item = payload as EvidenceItem;
  const sev = severityColor(p, item.severity);

  emit([
    title(p, "query", "evidence"),
    "",
    kv(p, "id", item.id),
    kv(p, "kind", item.kind),
    kv(p, "score", String(item.score)),
    kv(p, "severity", sev),
    "",
    kv(p, "title", item.title),
    kv(p, "summary", item.summary),
    ""
  ]);

  if (item.signals.length > 0) {
    emit([p.dim("  SIGNALS")]);
    for (const s of item.signals) console.log(`    ${s}`);
    console.log("");
  }

  if (item.codeCandidates && item.codeCandidates.length > 0) {
    emit([p.dim("  CODE CANDIDATES")]);
    for (const c of item.codeCandidates) {
      const loc = c.line !== undefined ? `:${c.line}` : "";
      console.log(`    ${visualPadStart(String(c.score), 5)}  ${p.cyan(c.path)}${p.dim(loc)}  ${p.dim(c.reason)}`);
    }
    console.log("");
  }

  if (item.stackFrames && item.stackFrames.length > 0) {
    emit([p.dim("  STACK FRAMES")]);
    for (const f of item.stackFrames.slice(0, 8)) console.log(`    ${p.dim(f)}`);
    console.log("");
  }

  if (item.relatedTraceIds && item.relatedTraceIds.length > 0) {
    emit([p.dim("  RELATED TRACES")]);
    for (const t of item.relatedTraceIds.slice(0, 5)) console.log(`    ${p.dim(t)}`);
    console.log("");
  }

  if (item.citations.length > 0) {
    emit([p.dim("  CITATIONS")]);
    for (const c of item.citations.slice(0, 6)) {
      const ts = c.timestamp ?? "";
      console.log(`    ${p.cyan(c.eventId)}  ${p.dim(ts)}  ${p.dim(c.sourceFile)}`);
    }
    console.log("");
  }
}

function renderCodeCandidatesHuman(p: Palette, payload: CodeCandidatesShape): void {
  emit([
    title(p, "query", "code-candidates"),
    "",
    kv(p, "total", String(payload.total)),
    kv(p, "showing", String(payload.returned)),
    ""
  ]);

  for (const c of payload.candidates) {
    const loc = c.line !== undefined ? `:${c.line}` : "";
    console.log(`  ${visualPadStart(String(c.score), 5)}  ${p.cyan(c.path)}${p.dim(loc)}`);
    console.log(`         ${p.dim(c.reason)}`);
  }
  console.log("");
}

async function handleQuery(flags: Record<string, string>, output: OutputOptions): Promise<void> {
  const ref = await resolveRequiredSession(process.cwd(), flags);
  const view = requireFlag(flags, "view") as QueryViewName;
  const session = await loadSessionArtifact(ref.sessionPath);

  const limit = flags.limit ? Number.parseInt(flags.limit, 10) : undefined;

  // For view=cluster --id is a cluster id; for view=evidence --id is an evidence id.
  const result = await runQuery(session, {
    view,
    clusterId: view === "cluster" ? flags.id : undefined,
    evidenceId: view === "evidence" ? flags.id : undefined,
    service: flags.service,
    trace: flags.trace,
    ...(limit !== undefined ? { limit } : {})
  });

  if (output.mode === "machine") {
    console.log(JSON.stringify({ ok: true, command: "query", ...result }, null, 2));
    return;
  }

  const p = makePalette(output.color);
  const sessionDisplay = relSession(session.artifacts.sessionPath);

  switch (view) {
    case "incident-summary":
      renderIncidentSummaryHuman(p, sessionDisplay, result.result as IncidentSummaryShape);
      return;
    case "top-evidence":
      renderTopEvidenceHuman(p, sessionDisplay, result.result as TopEvidenceShape);
      return;
    case "evidence":
      renderEvidenceDetailHuman(p, result.result);
      return;
    case "code-candidates":
      renderCodeCandidatesHuman(p, result.result as CodeCandidatesShape);
      return;
    case "clusters":
      renderClustersHuman(p, sessionDisplay, result.result as ClustersResultShape);
      return;
    case "cluster":
      renderClusterDetailHuman(p, result.result);
      return;
    case "latest-errors":
    case "service":
    case "trace":
      renderEventListHuman(p, view, sessionDisplay, result.result as EventsResultShape);
      return;
  }
}

// ---------- inspect ----------

async function handleInspect(flags: Record<string, string>, output: OutputOptions): Promise<void> {
  const ref = await resolveRequiredSession(process.cwd(), flags);
  const session = await loadSessionArtifact(ref.sessionPath);

  if (output.mode === "machine") {
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
            normalizedEvents: session.evidence.normalizedEvents,
            clusterCount: session.evidence.clusters.length,
            evidenceItemCount: session.evidence.items.length,
            topCodeCandidateCount: session.evidence.topCodeCandidates.length
          }
        : null,
      topEvidence: (session.evidence?.items ?? []).slice(0, 5).map((it) => ({
        id: it.id,
        kind: it.kind,
        title: it.title,
        score: it.score,
        severity: it.severity
      }))
    }, null, 2));
    return;
  }

  const p = makePalette(output.color);
  const evidence = session.evidence;
  const fetchInfo = session.fetch;

  emit([
    title(p, "inspect"),
    "",
    kv(p, "session", session.sessionId),
    kv(p, "source", session.sourceMode),
    kv(p, "schema", session.schemaVersion),
    kv(p, "updated", session.updatedAt),
    ""
  ]);

  if (fetchInfo) {
    emit([
      kv(p, "index", fetchInfo.indexPattern),
      kv(p, "service", fetchInfo.service),
      kv(p, "hits", fetchInfo.totalHits != null ? `${fetchInfo.fetchedHits} / ${fetchInfo.totalHits}` : String(fetchInfo.fetchedHits)),
      kv(p, "pages", String(fetchInfo.pageCount)),
      kv(p, "auth", fetchInfo.authMode),
      ""
    ]);
  }

  if (evidence) {
    emit([
      kv(p, "events", String(evidence.normalizedEvents)),
      kv(p, "clusters", String(evidence.clusters.length)),
      kv(p, "evidence", String(evidence.items.length)),
      kv(p, "code", String(evidence.topCodeCandidates.length)),
      ""
    ]);

    const topItems = evidence.items.slice(0, 5);
    if (topItems.length > 0) {
      emit([p.dim("  TOP EVIDENCE")]);
      for (const it of topItems) {
        const sev = severityColor(p, it.severity);
        console.log(`    ${visualPad(sev, 8)}  ${visualPadStart(String(it.score), 5)}  ${p.cyan(it.id)}  ${it.title}`);
      }
      console.log("");
    }
  } else {
    emit([p.dim("  (no evidence — run `kibtrace prepare --session <path> --repo <path>`)"), ""]);
  }
}

// ---------- correlate ----------

async function handleCorrelate(flags: Record<string, string>, output: OutputOptions): Promise<void> {
  const ref = await resolveRequiredSession(process.cwd(), flags);
  const session = await loadSessionArtifact(ref.sessionPath);

  if (!session.evidence || !session.hypotheses) {
    throw new Error("Session has no evidence. Run `kibtrace prepare --session <path>` first.");
  }

  const candidates = session.evidence.topCodeCandidates;

  if (output.mode === "machine") {
    console.log(JSON.stringify({
      ok: true,
      command: "correlate",
      sessionId: session.sessionId,
      repoPath: session.input.repoPath ?? null,
      codeCandidateCount: candidates.length,
      codeCandidates: candidates,
      hypotheses: session.hypotheses.map((h) => ({
        id: h.id,
        summary: h.summary,
        confidence: h.confidence,
        backedByEvidenceIds: h.backedByEvidenceIds ?? [],
        signalCount: h.supportingSignals.length,
        counterCount: h.counterEvidence.length
      }))
    }, null, 2));
    return;
  }

  const p = makePalette(output.color);

  emit([
    title(p, "correlate"),
    "",
    kv(p, "session", session.sessionId),
    kv(p, "repo", session.input.repoPath),
    kv(p, "candidates", String(candidates.length)),
    ""
  ]);

  if (candidates.length > 0) {
    emit([p.dim("  CODE CANDIDATES")]);
    for (const c of candidates) {
      const loc = c.line !== undefined ? `:${c.line}` : "";
      console.log(`    ${visualPadStart(String(c.score), 5)}  ${p.cyan(c.path)}${p.dim(loc)}  ${p.dim(c.reason)}`);
    }
    console.log("");
  }

  if (session.hypotheses.length > 0) {
    emit([p.dim("  HYPOTHESES")]);
    for (const h of session.hypotheses) {
      const conf = h.confidence === "high"
        ? p.green(h.confidence.toUpperCase())
        : h.confidence === "medium"
          ? p.yellow(h.confidence.toUpperCase())
          : p.dim(h.confidence.toUpperCase());
      console.log(`    ${p.cyan(h.id)}  ${visualPad(conf, 8)}  ${h.summary}`);
    }
    console.log("");
  }
}

// ---------- report ----------

async function handleReport(flags: Record<string, string>, _output: OutputOptions): Promise<void> {
  const ref = await resolveRequiredSession(process.cwd(), flags);
  const session = await loadSessionArtifact(ref.sessionPath);

  if (!session.artifacts.reportMarkdownPath) {
    throw new Error("Session has no report. Run `kibtrace prepare --session <path>` first.");
  }

  const markdown = await readFile(session.artifacts.reportMarkdownPath, "utf8");
  console.log(markdown);
}

// ---------- main ----------

async function main(): Promise<void> {
  let parsed: ParsedCommand | null;
  try {
    parsed = parseCommand(process.argv.slice(2));
  } catch (error) {
    handleHelp({});
    const message = error instanceof Error ? error.message : String(error);
    console.error("");
    console.error(`error  ${message}`);
    process.exitCode = 1;
    return;
  }

  if (!parsed) {
    handleHelp({});
    process.exitCode = 1;
    return;
  }

  if (parsed.name === "help") {
    handleHelp(parsed.flags);
    return;
  }

  const output = buildOutput(parsed.flags);

  try {
    switch (parsed.name) {
      case "fetch":
        await handleFetch(parsed.flags, output);
        break;
      case "prepare":
        await handlePrepare(parsed.flags, output);
        break;
      case "query":
        await handleQuery(parsed.flags, output);
        break;
      case "inspect":
        await handleInspect(parsed.flags, output);
        break;
      case "correlate":
        await handleCorrelate(parsed.flags, output);
        break;
      case "report":
        await handleReport(parsed.flags, output);
        break;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (output.mode === "human") {
      const p = makePalette(output.color);
      console.error(statusError(p, message));
    } else {
      console.error(`kibtrace error: ${message}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`kibtrace error: ${message}`);
  process.exitCode = 1;
});
