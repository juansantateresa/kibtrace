import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ElasticHit, FetchConfig, FetchManifest } from "../types.js";

const PIT_KEEP_ALIVE = "1m";

interface FetchHttpOptions {
  esUrl: string;
  authHeader?: string;
  body?: unknown;
  method?: "GET" | "POST" | "DELETE";
  pathname: string;
  query?: Record<string, string>;
}

/** Internal HTTP helper. Never logs the auth header. */
async function callEs<T>(opts: FetchHttpOptions): Promise<T> {
  const url = new URL(opts.pathname, opts.esUrl);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      url.searchParams.set(k, v);
    }
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json"
  };
  if (opts.authHeader) {
    headers["Authorization"] = opts.authHeader;
  }

  const init: RequestInit = {
    method: opts.method ?? "POST",
    headers
  };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
  }

  const response = await fetch(url, init);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Elasticsearch ${opts.method ?? "POST"} ${opts.pathname} failed: ${response.status} ${response.statusText} ${text.slice(0, 500)}`
    );
  }
  return (await response.json()) as T;
}

/** Build the bool/range query body from FetchConfig. */
export function buildQuery(config: FetchConfig): Record<string, unknown> {
  const filters: Array<Record<string, unknown>> = [];

  if (config.since || config.until) {
    const range: Record<string, string> = {};
    if (config.since) range.gte = config.since;
    if (config.until) range.lte = config.until;
    filters.push({ range: { "@timestamp": range } });
  }

  if (config.service) {
    filters.push({ term: { "service.name": config.service } });
  }

  if (config.environment) {
    filters.push({ term: { "service.environment": config.environment } });
  }

  if (filters.length === 0) {
    return { match_all: {} };
  }

  return { bool: { filter: filters } };
}

interface OpenPitResponse {
  id: string;
}

interface SearchResponse {
  pit_id?: string;
  hits: {
    total: { value: number; relation: string } | number;
    hits: ElasticHit[];
  };
}

/** Open a Point-In-Time. Returns the PIT id. */
async function openPit(esUrl: string, indexPattern: string, authHeader?: string): Promise<string> {
  const response = await callEs<OpenPitResponse>({
    esUrl,
    authHeader,
    method: "POST",
    pathname: `/${encodeURIComponent(indexPattern)}/_pit`,
    query: { keep_alive: PIT_KEEP_ALIVE }
  });
  return response.id;
}

/** Close a PIT. Best-effort — failures are ignored. */
async function closePit(esUrl: string, pitId: string, authHeader?: string): Promise<void> {
  try {
    await callEs({
      esUrl,
      authHeader,
      method: "DELETE",
      pathname: "/_pit",
      body: { id: pitId }
    });
  } catch {
    // Ignore — PIT will time out on its own.
  }
}

export interface FetchResult {
  manifest: FetchManifest;
  /** Absolute paths to written page files. */
  pageFilePaths: string[];
}

/**
 * Fetch hits from Elasticsearch using PIT + search_after, writing each page
 * to disk under <rawHitsDir>/page-NNN.json. Never logs secrets.
 */
export async function fetchFromElastic(
  config: FetchConfig,
  rawHitsDir: string
): Promise<FetchResult> {
  await mkdir(rawHitsDir, { recursive: true });

  const authHeader = config.apiKey ? `ApiKey ${config.apiKey}` : undefined;
  const query = buildQuery(config);
  const pageFiles: string[] = [];
  const pageFilePaths: string[] = [];
  let fetchedHits = 0;
  let totalHits: number | null = null;
  let pageCount = 0;

  let currentPitId = await openPit(config.esUrl, config.indexPattern, authHeader);

  try {
    let searchAfter: unknown[] | undefined;

    while (fetchedHits < config.maxHits) {
      const remaining = config.maxHits - fetchedHits;
      const size = Math.min(config.pageSize, remaining);

      const body: Record<string, unknown> = {
        size,
        query,
        sort: [{ "@timestamp": "asc" }, { _shard_doc: "asc" }],
        track_total_hits: pageCount === 0,
        pit: { id: currentPitId, keep_alive: PIT_KEEP_ALIVE }
      };
      if (searchAfter) {
        body.search_after = searchAfter;
      }

      const response = await callEs<SearchResponse>({
        esUrl: config.esUrl,
        authHeader,
        method: "POST",
        pathname: "/_search",
        body
      });

      if (response.pit_id) {
        currentPitId = response.pit_id;
      }

      if (pageCount === 0) {
        const total = response.hits.total;
        totalHits = typeof total === "number" ? total : total.value;
      }

      const hits = response.hits.hits;
      if (hits.length === 0) break;

      pageCount += 1;
      const pageName = `page-${String(pageCount).padStart(4, "0")}.json`;
      const pagePath = path.join(rawHitsDir, pageName);
      await writeFile(pagePath, JSON.stringify({ hits }, null, 2), "utf8");
      pageFiles.push(pageName);
      pageFilePaths.push(pagePath);
      fetchedHits += hits.length;

      const last = hits[hits.length - 1];
      if (!last?.sort) break;
      searchAfter = last.sort;

      if (hits.length < size) break;
    }
  } finally {
    await closePit(config.esUrl, currentPitId, authHeader);
  }

  const manifest: FetchManifest = {
    esUrl: config.esUrl,
    indexPattern: config.indexPattern,
    since: config.since,
    until: config.until,
    service: config.service,
    environment: config.environment,
    pageSize: config.pageSize,
    pageCount,
    fetchedHits,
    totalHits,
    fetchedAt: new Date().toISOString(),
    authMode: config.apiKey ? "api-key" : "none",
    query,
    pageFiles
  };

  return { manifest, pageFilePaths };
}

/** Read all ElasticHit objects back from a session's raw hits directory. */
export async function loadHitsFromDir(rawHitsDir: string): Promise<ElasticHit[]> {
  const dirStat = await stat(rawHitsDir).catch(() => null);
  if (!dirStat || !dirStat.isDirectory()) return [];

  const entries = await readdir(rawHitsDir);
  const pageFiles = entries.filter((f) => f.startsWith("page-") && f.endsWith(".json")).sort();

  const allHits: ElasticHit[] = [];
  for (const file of pageFiles) {
    const content = await readFile(path.join(rawHitsDir, file), "utf8");
    const parsed = JSON.parse(content) as { hits: ElasticHit[] };
    if (Array.isArray(parsed.hits)) {
      allHits.push(...parsed.hits);
    }
  }
  return allHits;
}
