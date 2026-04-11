import type { FileIngestionResult } from "../ingest/file.js";
import type { NormalizedEvent, RawLogEntry } from "../types.js";

// Common log level patterns
const LEVEL_RE = /\b(FATAL|ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/i;

// ISO-8601 and common timestamp patterns
const TIMESTAMP_RE =
  /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/;

// Stacktrace continuation lines (Java/Node style)
const STACK_LINE_RE = /^\s+at\s+/;
const CAUSED_BY_RE = /^Caused by:/i;

/** Known NDJSON field names for standard log fields. */
const MESSAGE_FIELDS = ["message", "msg", "@message", "log", "text"];
const LEVEL_FIELDS = ["level", "severity", "log.level", "loglevel"];
const TIMESTAMP_FIELDS = ["@timestamp", "timestamp", "time", "ts", "datetime"];
const SERVICE_FIELDS = ["service", "service.name", "app", "application"];
const COMPONENT_FIELDS = ["component", "logger", "logger_name", "module"];

function extractFromParsed(parsed: Record<string, unknown>, candidates: string[]): string | undefined {
  for (const key of candidates) {
    const value = parsed[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function normalizeLevel(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const upper = raw.toUpperCase();
  if (upper === "WARNING") return "WARN";
  if (["FATAL", "ERROR", "WARN", "INFO", "DEBUG", "TRACE"].includes(upper)) return upper;
  return raw;
}

function extractFromRawLine(line: string): {
  message: string;
  level?: string;
  timestamp?: string;
} {
  const tsMatch = line.match(TIMESTAMP_RE);
  const lvlMatch = line.match(LEVEL_RE);
  let message = line;

  if (tsMatch) {
    message = message.replace(tsMatch[0], "").trim();
  }

  return {
    message: message || line,
    level: normalizeLevel(lvlMatch?.[1]),
    timestamp: tsMatch?.[1]
  };
}

export function normalizeFileEvents(ingestion: FileIngestionResult): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  let idCounter = 0;

  // Group entries by source file to detect stacktraces
  const byFile = new Map<string, RawLogEntry[]>();
  for (const entry of ingestion.entries) {
    let list = byFile.get(entry.sourceFile);
    if (!list) {
      list = [];
      byFile.set(entry.sourceFile, list);
    }
    list.push(entry);
  }

  for (const [sourceFile, entries] of byFile) {
    let pendingEvent: NormalizedEvent | null = null;
    const stackLines: string[] = [];

    for (const entry of entries) {
      const isStackLine = STACK_LINE_RE.test(entry.raw) || CAUSED_BY_RE.test(entry.raw);

      if (isStackLine && pendingEvent) {
        stackLines.push(entry.raw.trim());
        continue;
      }

      if (pendingEvent) {
        if (stackLines.length > 0) {
          pendingEvent.stackTrace = [...stackLines];
          stackLines.length = 0;
        }
        events.push(pendingEvent);
        pendingEvent = null;
      }

      idCounter += 1;

      if (entry.parsed) {
        const message = extractFromParsed(entry.parsed, MESSAGE_FIELDS) ?? entry.raw;
        const level = normalizeLevel(extractFromParsed(entry.parsed, LEVEL_FIELDS));
        const timestamp = extractFromParsed(entry.parsed, TIMESTAMP_FIELDS);
        const service = extractFromParsed(entry.parsed, SERVICE_FIELDS);
        const component = extractFromParsed(entry.parsed, COMPONENT_FIELDS);

        pendingEvent = {
          id: `event-${idCounter}`,
          sourceFile,
          lineNumber: entry.lineNumber,
          message,
          level: level ?? (LEVEL_RE.test(message) ? normalizeLevel(message.match(LEVEL_RE)?.[1]) : undefined),
          timestamp,
          service,
          component,
          raw: entry.raw
        };
      } else {
        const extracted = extractFromRawLine(entry.raw);
        pendingEvent = {
          id: `event-${idCounter}`,
          sourceFile,
          lineNumber: entry.lineNumber,
          message: extracted.message,
          level: extracted.level,
          timestamp: extracted.timestamp,
          raw: entry.raw
        };
      }
    }

    if (pendingEvent) {
      if (stackLines.length > 0) {
        pendingEvent.stackTrace = [...stackLines];
      }
      events.push(pendingEvent);
    }
  }

  return events;
}
