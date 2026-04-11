import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { appFrames, parseStackFrames } from "../evidence/stack.js";
import type {
  ClusterSummary,
  CodeCandidate,
  NormalizedEvent
} from "../types.js";

/**
 * Stack-frame-first repo correlation.
 *
 * Order of evidence (highest to lowest weight):
 *   1. Exact stack-frame mapping  → CodeCandidate score 100 + occurrence boost
 *   2. Exact identifier match in source → score 30-80
 *   3. Broad keyword fallback → score ~10
 *
 * The output is a list of CodeCandidate objects ranked by score. Filebeat,
 * vendor code, and infrastructure files are demoted explicitly.
 */

export interface CorrelationInput {
  repoPath: string;
  events: NormalizedEvent[];
  clusters: ClusterSummary[];
}

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".js", ".tsx", ".jsx", ".mjs", ".cjs",
  ".py", ".java", ".go", ".rs", ".rb", ".cpp", ".c", ".h",
  ".cs", ".kt", ".scala", ".php", ".sql"
]);

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "target", "__pycache__",
  ".next", "vendor", "coverage", ".kibtrace", ".cache"
]);

const MAX_FILE_SIZE = 256 * 1024;

/**
 * Container path prefixes we know how to peel off when mapping stack frames
 * to repo paths. Order matters — most specific first.
 */
const CONTAINER_PREFIXES = [
  "/usr/src/app/",
  "/srv/app/",
  "/workspace/",
  "/code/",
  "/app/"
];

/** Files / paths we explicitly demote even if they match. */
const INFRA_PATH_PATTERNS = [
  /\bfilebeat\b/i,
  /\bmetricbeat\b/i,
  /\blogstash\b/i,
  /\belastic-agent\b/i,
  /\.dockerfile$/i,
  /docker-compose/i,
  /\.github\//i,
  /node_modules\//
];

const INFRA_DEMOTION = -80;

function isInfraPath(p: string): boolean {
  return INFRA_PATH_PATTERNS.some((re) => re.test(p));
}

async function collectSourceFiles(dirPath: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          await walk(fullPath);
        }
      } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        results.push(fullPath);
      }
    }
  }

  await walk(dirPath);
  return results;
}

/**
 * Try mapping a container/runtime stack-frame path to an actual file in the
 * given repo. Returns the absolute path on success, null on miss.
 */
async function mapStackPathToRepo(
  containerPath: string,
  repoPath: string
): Promise<string | null> {
  // Strip URL scheme if present.
  let p = containerPath;
  if (p.startsWith("file:///")) p = p.slice("file://".length);
  else if (p.startsWith("file://")) p = p.slice("file:".length);

  // Try each known prefix; the relative tail is what we look for in the repo.
  const candidates: string[] = [];
  for (const prefix of CONTAINER_PREFIXES) {
    if (p.startsWith(prefix)) {
      candidates.push(p.slice(prefix.length));
    }
  }
  // Also try the path as-is (relative or already-absolute-in-repo).
  candidates.push(p.replace(/^\/+/, ""));
  // And the basename as a last resort (we'll dedupe afterwards).
  candidates.push(path.basename(p));

  for (const rel of candidates) {
    if (!rel) continue;
    const candidatePath = path.resolve(repoPath, rel);
    try {
      const s = await stat(candidatePath);
      if (s.isFile()) return candidatePath;
    } catch {
      // not found, continue
    }
  }
  return null;
}

interface AggregatedCandidate {
  path: string;
  symbol?: string;
  line?: number;
  score: number;
  reasons: Set<string>;
}

function bumpCandidate(
  agg: Map<string, AggregatedCandidate>,
  key: string,
  init: () => AggregatedCandidate,
  scoreDelta: number,
  reason: string
): void {
  let c = agg.get(key);
  if (!c) {
    c = init();
    agg.set(key, c);
  }
  c.score += scoreDelta;
  c.reasons.add(reason);
}

// ---------- pass 1: stack-frame mapping ----------

async function correlateByStackFrames(
  events: NormalizedEvent[],
  repoPath: string,
  agg: Map<string, AggregatedCandidate>
): Promise<void> {
  // We dedupe (containerPath, line, symbol) lookups so we don't stat the same
  // path 200 times.
  const lookupCache = new Map<string, string | null>();

  for (const e of events) {
    if (!e.stackTrace || e.stackTrace.length === 0) continue;
    const frames = parseStackFrames(e.stackTrace);
    const app = appFrames(frames);
    if (app.length === 0) continue;

    // Only consider the *topmost* app frame for primary attribution.
    const top = app[0]!;
    if (!top.cleanFile) continue;

    let mapped: string | null | undefined = lookupCache.get(top.cleanFile);
    if (mapped === undefined) {
      mapped = await mapStackPathToRepo(top.cleanFile, repoPath);
      lookupCache.set(top.cleanFile, mapped);
    }
    if (!mapped) continue;

    const relPath = path.relative(repoPath, mapped);
    const key = `stack:${relPath}:${top.line ?? 0}`;
    const isError = e.level === "ERROR" || e.level === "FATAL";
    const delta = isError ? 5 : 1;

    bumpCandidate(
      agg,
      key,
      () => ({
        path: relPath,
        ...(top.symbol ? { symbol: top.symbol } : {}),
        ...(top.line !== undefined ? { line: top.line } : {}),
        score: 100, // base for being in a stack frame at all
        reasons: new Set<string>()
      }),
      delta,
      `referenced by stack frame${top.symbol ? ` (${top.symbol})` : ""}`
    );

    // Also consider the *next* app frame as a weaker signal.
    const second = app[1];
    if (second?.cleanFile) {
      let m2: string | null | undefined = lookupCache.get(second.cleanFile);
      if (m2 === undefined) {
        m2 = await mapStackPathToRepo(second.cleanFile, repoPath);
        lookupCache.set(second.cleanFile, m2);
      }
      if (m2) {
        const relPath2 = path.relative(repoPath, m2);
        const key2 = `stack:${relPath2}:${second.line ?? 0}`;
        bumpCandidate(
          agg,
          key2,
          () => ({
            path: relPath2,
            ...(second.symbol ? { symbol: second.symbol } : {}),
            ...(second.line !== undefined ? { line: second.line } : {}),
            score: 50,
            reasons: new Set<string>()
          }),
          isError ? 2 : 0,
          `caller frame${second.symbol ? ` (${second.symbol})` : ""}`
        );
      }
    }
  }
}

// ---------- pass 2: identifier / keyword fallback ----------

const GENERIC_TERMS = new Set([
  "Error", "Exception", "Timeout", "Failure", "Warning",
  "String", "Object", "Array", "Number", "Boolean",
  "null", "undefined", "true", "false",
  "INFO", "WARN", "ERROR", "DEBUG", "TRACE", "FATAL"
]);

function extractIdentifiers(clusters: ClusterSummary[]): Set<string> {
  const ids = new Set<string>();
  for (const cluster of clusters) {
    const text = cluster.summary;
    const camel = text.match(/\b[A-Z][a-zA-Z]{3,}\b/g) ?? [];
    for (const c of camel) ids.add(c);
    const snake = text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [];
    for (const s of snake) ids.add(s);
    const errors = text.match(/\b\w+(?:Error|Exception|Failure|Timeout)\b/g) ?? [];
    for (const e of errors) ids.add(e);
    // SQL relation names appearing in messages
    const quoted = text.match(/"([a-z][a-z0-9_]+)"/gi) ?? [];
    for (const q of quoted) ids.add(q.replace(/"/g, ""));
  }
  return new Set([...ids].filter((k) => !GENERIC_TERMS.has(k) && k.length >= 4));
}

async function correlateByKeywords(
  clusters: ClusterSummary[],
  repoPath: string,
  agg: Map<string, AggregatedCandidate>
): Promise<void> {
  const identifiers = extractIdentifiers(clusters);
  if (identifiers.size === 0) return;

  const sourceFiles = await collectSourceFiles(repoPath);

  for (const filePath of sourceFiles) {
    let s;
    try {
      s = await stat(filePath);
    } catch {
      continue;
    }
    if (s.size > MAX_FILE_SIZE) continue;

    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    const matched = new Map<string, number>(); // identifier → first line

    for (const id of identifiers) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.includes(id)) {
          matched.set(id, i + 1);
          break;
        }
      }
    }

    if (matched.size === 0) continue;

    const relPath = path.relative(repoPath, filePath);
    const firstSymbol = [...matched.keys()][0]!;
    const firstLine = matched.get(firstSymbol);
    const key = `kw:${relPath}`;

    bumpCandidate(
      agg,
      key,
      () => ({
        path: relPath,
        symbol: firstSymbol,
        ...(firstLine !== undefined ? { line: firstLine } : {}),
        score: 0,
        reasons: new Set<string>()
      }),
      30 + Math.min(matched.size * 5, 50),
      `contains ${[...matched.keys()].slice(0, 3).map((k) => `"${k}"`).join(", ")}`
    );
  }
}

// ---------- public API ----------

export interface CorrelationResult {
  repoPath: string;
  candidates: CodeCandidate[];
}

export async function correlateRepository(
  input: CorrelationInput
): Promise<CorrelationResult> {
  const agg = new Map<string, AggregatedCandidate>();

  // Stack-frame correlation runs first and contributes the highest weights.
  await correlateByStackFrames(input.events, input.repoPath, agg);

  // Keyword fallback fills in candidates for clusters that have no stack.
  await correlateByKeywords(input.clusters, input.repoPath, agg);

  // Demote infra paths.
  for (const c of agg.values()) {
    if (isInfraPath(c.path)) {
      c.score += INFRA_DEMOTION;
      c.reasons.add("demoted: infrastructure / vendor file");
    }
  }

  const candidates: CodeCandidate[] = [...agg.values()]
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 15)
    .map((c) => ({
      path: c.path,
      ...(c.line !== undefined ? { line: c.line } : {}),
      score: c.score,
      reason: [...c.reasons].slice(0, 3).join("; "),
      ...(c.symbol ? { symbol: c.symbol } : {})
    }));

  return { repoPath: input.repoPath, candidates };
}

/**
 * Attach code candidates to evidence items where the item already has a
 * matching code candidate (by path) or where the item's stack frames point at
 * the candidate file. Used after extractEvidence().
 */
export function attachCodeCandidatesToItems(
  items: import("../types.js").EvidenceItem[],
  candidates: CodeCandidate[]
): import("../types.js").EvidenceItem[] {
  if (candidates.length === 0) return items;
  const byPath = new Map<string, CodeCandidate[]>();
  for (const c of candidates) {
    let list = byPath.get(c.path);
    if (!list) {
      list = [];
      byPath.set(c.path, list);
    }
    list.push(c);
  }

  return items.map((item) => {
    if (!item.stackFrames || item.stackFrames.length === 0) return item;

    // Pull the cleaned file paths out of the item's stack frames and look for
    // candidates whose tail matches.
    const matched: CodeCandidate[] = [];
    const seen = new Set<string>();
    for (const frame of item.stackFrames) {
      const m = frame.match(/(?:file:\/\/)?\/?([\w/.\-]+\.(?:ts|js|mjs|cjs|tsx|jsx|py|java|go|rs|rb|cpp|c|h|cs|kt|scala|php|sql))/);
      if (!m) continue;
      const tail = m[1]!;
      for (const c of candidates) {
        if (c.path.endsWith(tail.split("/").slice(-2).join("/"))) {
          if (seen.has(c.path)) continue;
          seen.add(c.path);
          matched.push(c);
        }
      }
    }
    if (matched.length === 0) return item;
    return {
      ...item,
      codeCandidates: [...(item.codeCandidates ?? []), ...matched].slice(0, 5)
    };
  });
}
