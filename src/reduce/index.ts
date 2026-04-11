import type { ClusterSummary, NormalizedEvent } from "../types.js";

/**
 * Fingerprint a log message by stripping variable parts:
 * UUIDs, hex strings, numbers, IPs, timestamps, quoted strings.
 */
export function fingerprint(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<UUID>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<HEX>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<HEX>")
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?\b/g, "<IP>")
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*[Z]?/g, "<TS>")
    .replace(/\b\d+(\.\d+)?\b/g, "<N>")
    .replace(/"[^"]*"/g, '"<STR>"')
    .replace(/'[^']*'/g, "'<STR>'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const MAX_EXCERPTS = 3;
const MAX_SAMPLE_IDS = 3;

/**
 * Group normalized events into ClusterSummaries by fingerprint.
 * This is the lower-level building block — call extractEvidence() on top of
 * this to derive ranked evidence items.
 */
export function buildClusters(events: NormalizedEvent[]): ClusterSummary[] {
  if (events.length === 0) return [];

  const groups = new Map<string, NormalizedEvent[]>();
  for (const event of events) {
    const fp = fingerprint(event.message);
    let list = groups.get(fp);
    if (!list) {
      list = [];
      groups.set(fp, list);
    }
    list.push(event);
  }

  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

  return sorted.map(([fp, members], index) => {
    const levels: Record<string, number> = {};
    for (const m of members) {
      const lvl = m.level ?? "UNKNOWN";
      levels[lvl] = (levels[lvl] ?? 0) + 1;
    }

    const excerpts: string[] = [];
    const seen = new Set<string>();
    const picks: Array<NormalizedEvent | undefined> = [
      members[0],
      members[Math.floor(members.length / 2)],
      members[members.length - 1]
    ];
    for (const pick of picks) {
      if (pick && !seen.has(pick.message) && excerpts.length < MAX_EXCERPTS) {
        seen.add(pick.message);
        excerpts.push(pick.raw.slice(0, 300));
      }
    }

    const firstMsg = members[0]!.message;
    const summary = firstMsg.length > 120 ? firstMsg.slice(0, 117) + "..." : firstMsg;

    const sourceFiles = [...new Set(members.map((m) => m.sourceFile))];

    const sampleEventIds = members.slice(0, MAX_SAMPLE_IDS).map((m) => m.id);

    return {
      id: `cluster-${index + 1}`,
      fingerprint: fp,
      summary,
      count: members.length,
      sourceFiles: sourceFiles.slice(0, 10),
      representativeExcerpts: excerpts,
      levels,
      sampleEventIds
    };
  });
}
