import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export interface IngestedLogFile {
  path: string;
  sizeBytes: number;
  preview: string;
}

export interface IngestionResult {
  sourcePath: string;
  files: IngestedLogFile[];
  totalBytes: number;
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

  return nested.flat();
}

export async function ingestLogs(sourcePath: string): Promise<IngestionResult> {
  const files = await collectFiles(sourcePath);
  const ingested = await Promise.all(files.map(async (filePath) => {
    const fileStat = await stat(filePath);
    const preview = (await readFile(filePath, "utf8")).slice(0, 400);
    return {
      path: filePath,
      sizeBytes: fileStat.size,
      preview
    };
  }));

  return {
    sourcePath,
    files: ingested,
    totalBytes: ingested.reduce((sum, file) => sum + file.sizeBytes, 0)
  };
}

