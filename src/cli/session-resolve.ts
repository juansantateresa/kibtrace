import { readdir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Session selector resolution.
 *
 * Commands accept three mutually exclusive ways to point at a session:
 *   --session <path>    explicit session.json path
 *   --session-id <id>   resolve <cwd>/.kibtrace/sessions/<id>/session.json
 *   --latest            resolve the lexicographically greatest valid session
 *
 * Precedence (when multiple are present, we error out — see resolveRequiredSession):
 *   1. --session
 *   2. --session-id
 *   3. --latest
 */

export interface ResolvedSessionRef {
  /** Absolute or relative path to a session.json file. */
  sessionPath: string;
  /** Best-effort session id. May come from the directory name; not authoritative. */
  sessionId?: string;
}

const SESSIONS_SUBDIR = path.join(".kibtrace", "sessions");

function sessionsRoot(cwd: string): string {
  return path.join(cwd, SESSIONS_SUBDIR);
}

/**
 * Find the most recent local session by walking <cwd>/.kibtrace/sessions/.
 * Session directory names are timestamp-based, so lexicographic order is fine.
 *
 * Returns null if the sessions root does not exist or no valid session is found.
 */
export async function findLatestSession(cwd: string): Promise<ResolvedSessionRef | null> {
  const root = sessionsRoot(cwd);

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }

  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  // Walk newest → oldest, return the first directory containing a session.json file.
  for (let i = dirs.length - 1; i >= 0; i--) {
    const id = dirs[i]!;
    const candidate = path.join(root, id, "session.json");
    try {
      const s = await stat(candidate);
      if (s.isFile()) {
        return { sessionPath: candidate, sessionId: id };
      }
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Resolve <cwd>/.kibtrace/sessions/<id>/session.json. Throws a clear error if
 * the path does not exist or is not a file.
 */
export async function resolveSessionId(cwd: string, id: string): Promise<ResolvedSessionRef> {
  const sessionPath = path.join(sessionsRoot(cwd), id, "session.json");
  try {
    const s = await stat(sessionPath);
    if (!s.isFile()) {
      throw new Error(
        `Session id "${id}" resolved to ${sessionPath}, but that path is not a file.`
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Session id")) throw err;
    throw new Error(
      `No session found for --session-id "${id}". Looked at ${sessionPath}.`
    );
  }
  return { sessionPath, sessionId: id };
}

/**
 * Resolve a required session reference from CLI flags.
 *
 *   - Errors if more than one of --session, --session-id, --latest is set.
 *   - Errors if none of them is set, with a message that mentions all three.
 */
export async function resolveRequiredSession(
  cwd: string,
  flags: Record<string, string>
): Promise<ResolvedSessionRef> {
  const provided: string[] = [];
  if (flags["session"]) provided.push("--session");
  if (flags["session-id"]) provided.push("--session-id");
  if (flags["latest"] === "true") provided.push("--latest");

  if (provided.length > 1) {
    throw new Error(
      `Provide only one of --session, --session-id, or --latest (got: ${provided.join(", ")}).`
    );
  }

  if (flags["session"]) {
    // Try to derive a sensible id from the path layout, but don't fail if it
    // doesn't match the conventional shape.
    const dir = path.dirname(flags["session"]);
    const sessionId = path.basename(dir);
    return { sessionPath: flags["session"], sessionId };
  }

  if (flags["session-id"]) {
    return resolveSessionId(cwd, flags["session-id"]);
  }

  if (flags["latest"] === "true") {
    const latest = await findLatestSession(cwd);
    if (!latest) {
      throw new Error(
        `No sessions found under ${sessionsRoot(cwd)}. Run \`kibtrace fetch\` first, ` +
        `or pass --session-id <id> / --session <path>.`
      );
    }
    return latest;
  }

  throw new Error(
    "No session selector provided. Use one of: --latest, --session-id <id>, --session <path>."
  );
}
