import type { IngestionResult } from "../ingest/index.js";
import type { NormalizedEvent } from "../types.js";

export function normalizeEvents(ingestion: IngestionResult): NormalizedEvent[] {
  return ingestion.files.map((file, index) => ({
    id: `event-${index + 1}`,
    sourceFile: file.path,
    message: file.preview.split(/\r?\n/, 1)[0] ?? "(empty file)"
  }));
}

