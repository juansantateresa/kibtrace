import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { RawLogEntry } from "../types.js";

export interface FileIngestionResult {
  sourcePath: string;
  totalBytes: number;
  fileCount: number;
  entries: RawLogEntry[];
  /** Per-file format detected: "ndjson" or "text". */
  formats: Record<string, "ndjson" | "text">;
}

async function collectFiles(targetPath: string): Promise<string[]> {
  const targetStat = await stat(targetPath);
  if (targetStat.isFile()) {
    return [targetPath];
  }

  const entries = await readdir(targetPath, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      return collectFiles(entryPath);
    }
    return [entryPath];
  }));

  return nested.flat().sort();
}

function isNdjson(firstLine: string): boolean {
  try {
    const parsed = JSON.parse(firstLine);
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

function parseNdjsonLine(line: string, lineNumber: number, sourceFile: string): RawLogEntry | null {
  if (line.trim() === "") return null;
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    return { lineNumber, raw: line, parsed, sourceFile };
  } catch {
    return { lineNumber, raw: line, sourceFile };
  }
}

function parseTextLine(line: string, lineNumber: number, sourceFile: string): RawLogEntry | null {
  if (line.trim() === "") return null;
  return { lineNumber, raw: line, sourceFile };
}

export async function ingestFiles(sourcePath: string): Promise<FileIngestionResult> {
  const files = await collectFiles(sourcePath);
  const allEntries: RawLogEntry[] = [];
  const formats: Record<string, "ndjson" | "text"> = {};
  let totalBytes = 0;

  for (const filePath of files) {
    const fileStat = await stat(filePath);
    totalBytes += fileStat.size;

    const content = await readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    const firstNonEmpty = lines.find((l) => l.trim() !== "");
    const format = firstNonEmpty && isNdjson(firstNonEmpty) ? "ndjson" : "text";
    formats[filePath] = format;

    const parseLine = format === "ndjson" ? parseNdjsonLine : parseTextLine;

    for (let i = 0; i < lines.length; i++) {
      const entry = parseLine(lines[i]!, i + 1, filePath);
      if (entry) {
        allEntries.push(entry);
      }
    }
  }

  return {
    sourcePath,
    totalBytes,
    fileCount: files.length,
    entries: allEntries,
    formats
  };
}
