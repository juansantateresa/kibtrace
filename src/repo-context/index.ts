import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { ClusterSummary, CodeReference, RepoCorrelation } from "../types.js";

interface RepoContextInput {
  repoPath: string;
  clusters: ClusterSummary[];
}

/** File extensions we consider source code. */
const SOURCE_EXTENSIONS = new Set([
  ".ts", ".js", ".tsx", ".jsx", ".py", ".java", ".go", ".rs",
  ".rb", ".cpp", ".c", ".h", ".cs", ".kt", ".scala", ".php",
  ".sql", ".yaml", ".yml", ".json", ".toml", ".xml"
]);

/** Directories to skip when scanning the repo. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "target", "__pycache__",
  ".next", "vendor", "coverage", ".kibtrace"
]);

const MAX_FILE_SIZE = 256 * 1024; // 256 KB — skip large files

/**
 * Extract search keywords from cluster summaries and excerpts.
 * Focuses on identifiers: CamelCase, snake_case, dotted paths, class names.
 */
function extractKeywords(clusters: ClusterSummary[]): string[] {
  const keywords = new Set<string>();

  for (const cluster of clusters) {
    const texts = [cluster.summary, ...cluster.representativeExcerpts];
    for (const text of texts) {
      // CamelCase or PascalCase identifiers (min 4 chars)
      const camel = text.match(/\b[A-Z][a-zA-Z]{3,}\b/g) ?? [];
      for (const c of camel) keywords.add(c);

      // snake_case identifiers
      const snake = text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [];
      for (const s of snake) keywords.add(s);

      // Dotted paths (e.g., com.example.MyClass)
      const dotted = text.match(/\b[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){2,}\b/gi) ?? [];
      for (const d of dotted) keywords.add(d);

      // Exception/Error class names
      const errors = text.match(/\b\w+(?:Error|Exception|Failure|Timeout)\b/g) ?? [];
      for (const e of errors) keywords.add(e);

      // Function-like references: word(
      const funcs = text.match(/\b([a-zA-Z_]\w{3,})\s*\(/g) ?? [];
      for (const f of funcs) {
        const name = f.replace(/\s*\($/, "");
        keywords.add(name);
      }
    }
  }

  // Filter out overly generic terms
  const generic = new Set([
    "Error", "Exception", "Timeout", "Failure", "Warning",
    "String", "Object", "Array", "Number", "Boolean",
    "null", "undefined", "true", "false", "INFO", "WARN", "ERROR", "DEBUG"
  ]);

  return [...keywords].filter((k) => !generic.has(k) && k.length >= 4);
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

export async function correlateRepository(
  input: RepoContextInput
): Promise<RepoCorrelation> {
  const keywords = extractKeywords(input.clusters);

  if (keywords.length === 0) {
    return {
      repoPath: input.repoPath,
      probableCodeAreas: [],
      suggestedOwners: ["unassigned"]
    };
  }

  const sourceFiles = await collectSourceFiles(input.repoPath);
  const hits = new Map<string, { reasons: Set<string>; lines: Map<string, number> }>();

  for (const filePath of sourceFiles) {
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      continue;
    }
    if (fileStat.size > MAX_FILE_SIZE) continue;

    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);

    for (const keyword of keywords) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.includes(keyword)) {
          const relativePath = path.relative(input.repoPath, filePath);
          let entry = hits.get(relativePath);
          if (!entry) {
            entry = { reasons: new Set(), lines: new Map() };
            hits.set(relativePath, entry);
          }
          entry.reasons.add(`contains "${keyword}"`);
          if (!entry.lines.has(keyword)) {
            entry.lines.set(keyword, i + 1);
          }
          break; // One hit per keyword per file is enough
        }
      }
    }
  }

  // Sort by number of keyword matches descending, take top 10
  const sorted = [...hits.entries()]
    .sort((a, b) => b[1].reasons.size - a[1].reasons.size)
    .slice(0, 10);

  const codeAreas: CodeReference[] = sorted.map(([relPath, entry]) => {
    const reasons = [...entry.reasons];
    const firstSymbol = [...entry.lines.keys()][0];
    const firstLine = firstSymbol ? entry.lines.get(firstSymbol) : undefined;
    return {
      path: relPath,
      reason: reasons.slice(0, 3).join("; "),
      symbol: firstSymbol,
      line: firstLine
    };
  });

  // Derive owners from directory structure (top-level dirs as proxy)
  const ownerDirs = new Set<string>();
  for (const [relPath] of sorted) {
    const parts = relPath.split(path.sep);
    if (parts.length > 1) {
      ownerDirs.add(parts[0]!);
    }
  }
  const suggestedOwners = ownerDirs.size > 0 ? [...ownerDirs] : ["unassigned"];

  return {
    repoPath: input.repoPath,
    probableCodeAreas: codeAreas,
    suggestedOwners
  };
}
