import type { ElasticHit, NormalizedEvent } from "../types.js";

/**
 * Extract a string value from a possibly-nested ECS object using a dotted path.
 * Tries the dotted key first (e.g., parsed["service.name"]) and then walks
 * the nested objects.
 */
function getString(source: Record<string, unknown>, dotted: string): string | undefined {
  const flat = source[dotted];
  if (typeof flat === "string" && flat.length > 0) return flat;

  const parts = dotted.split(".");
  let current: unknown = source;
  for (const part of parts) {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof current === "string" && current.length > 0 ? current : undefined;
}

function normalizeLevel(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const upper = raw.toUpperCase();
  if (upper === "WARNING") return "WARN";
  if (["FATAL", "ERROR", "WARN", "INFO", "DEBUG", "TRACE"].includes(upper)) return upper;
  return upper;
}

/**
 * Build a NormalizedEvent from an ECS-style ES hit.
 *
 * Field priority:
 * - message:    error.message > message
 * - level:      log.level > level
 * - timestamp:  @timestamp
 * - service:    service.name
 * - component:  event.dataset > log.logger
 * - traceId:    trace.id
 * - stackTrace: error.stack_trace (split by newlines)
 */
export function normalizeElasticHits(hits: ElasticHit[]): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];

  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]!;
    const src = hit._source ?? {};

    const errorMessage = getString(src, "error.message");
    const message = errorMessage ?? getString(src, "message") ?? "(no message)";

    const level = normalizeLevel(getString(src, "log.level") ?? getString(src, "level"));
    const timestamp = getString(src, "@timestamp");
    const service = getString(src, "service.name");
    const component = getString(src, "event.dataset") ?? getString(src, "log.logger");
    const traceId = getString(src, "trace.id");

    const stackRaw = getString(src, "error.stack_trace");
    const stackTrace = stackRaw
      ? stackRaw
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.length > 0)
      : undefined;

    // Compact raw representation. Cap to avoid huge artifacts.
    const rawJson = JSON.stringify(src);
    const raw = rawJson.length > 2000 ? rawJson.slice(0, 2000) + "..." : rawJson;

    events.push({
      id: `event-${i + 1}`,
      sourceFile: `${hit._index}#${hit._id}`,
      message,
      level,
      timestamp,
      service,
      component,
      traceId,
      stackTrace,
      raw
    });
  }

  return events;
}
