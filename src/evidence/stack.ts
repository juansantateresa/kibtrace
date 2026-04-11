/**
 * Stack-frame parsing helpers.
 *
 * Recognizes Node.js / V8-style frames such as:
 *   "at async persistDetection (file:///app/src/index.js:155:5)"
 *   "at process.processTicksAndRejections (node:internal/process/task_queues:103:5)"
 *   "at /app/node_modules/pg/lib/client.js:631:17"
 *   "    at com.example.Foo.bar(Foo.java:42)"      (Java)
 *
 * The goal is to surface *application* frames — i.e. frames pointing at the
 * user's own source files, not node_modules, runtime internals, or vendor libs.
 */

export interface StackFrame {
  /** Raw line as it appeared. */
  raw: string;
  /** Symbol/function name if extractable. */
  symbol?: string;
  /** File path as referenced in the stack frame (may use file:/// scheme). */
  file?: string;
  /** Cleaned file path (file:/// stripped, prefixes intact). */
  cleanFile?: string;
  line?: number;
  column?: number;
  /** True if the frame looks like application code (not vendor/runtime). */
  isApp: boolean;
}

const NODE_FRAME_WITH_SYMBOL =
  /^\s*at\s+(?:async\s+)?([\w$.[\]<>]+)\s+\(([^)]+)\)\s*$/;
const NODE_FRAME_BARE = /^\s*at\s+(?:async\s+)?([^\s(].*?)\s*$/;
const FILE_LOC = /^(.+?):(\d+)(?::(\d+))?$/;

const VENDOR_PATH_RE = /(^|\/)(node_modules|vendor|dist|build)\//;
const RUNTIME_PREFIX_RE = /^(node:|internal\/|<)/;

function stripFileScheme(p: string): string {
  if (p.startsWith("file:///")) return p.slice("file://".length);
  if (p.startsWith("file://")) return p.slice("file:".length);
  return p;
}

function classifyFile(file: string | undefined): boolean {
  if (!file) return false;
  if (RUNTIME_PREFIX_RE.test(file)) return false;
  if (VENDOR_PATH_RE.test(file)) return false;
  return true;
}

/** Parse a single stack-frame line. Returns null if it doesn't look like one. */
export function parseStackFrame(line: string): StackFrame | null {
  if (!line) return null;
  const trimmed = line.trim();
  if (!trimmed.startsWith("at ") && !/^\s+at\s/.test(line)) {
    // Not a typical Node/V8 frame.
    return null;
  }

  let symbol: string | undefined;
  let location: string | undefined;

  const m1 = trimmed.match(NODE_FRAME_WITH_SYMBOL);
  if (m1) {
    symbol = m1[1];
    location = m1[2];
  } else {
    // Bare form: "at /path/to/file.js:12:34"
    const m2 = trimmed.match(NODE_FRAME_BARE);
    if (m2) {
      location = m2[1];
    }
  }

  if (!location) {
    return { raw: trimmed, isApp: false };
  }

  let file: string | undefined;
  let line_: number | undefined;
  let col: number | undefined;

  const fl = location.match(FILE_LOC);
  if (fl) {
    file = fl[1];
    line_ = Number.parseInt(fl[2]!, 10);
    col = fl[3] ? Number.parseInt(fl[3], 10) : undefined;
  } else {
    file = location;
  }

  const cleanFile = file ? stripFileScheme(file) : undefined;
  const isApp = classifyFile(cleanFile);

  return {
    raw: trimmed,
    symbol,
    file,
    cleanFile,
    line: line_,
    column: col,
    isApp
  };
}

/** Parse all frames in a stackTrace array. */
export function parseStackFrames(lines: string[]): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const line of lines) {
    const frame = parseStackFrame(line);
    if (frame) frames.push(frame);
  }
  return frames;
}

/** Return only the application frames (skips node_modules / runtime). */
export function appFrames(frames: StackFrame[]): StackFrame[] {
  return frames.filter((f) => f.isApp && f.cleanFile);
}

/** Pick the topmost application frame from a stack, if any. */
export function topAppFrame(stackTrace: string[] | undefined): StackFrame | null {
  if (!stackTrace || stackTrace.length === 0) return null;
  const frames = parseStackFrames(stackTrace);
  const app = appFrames(frames);
  return app[0] ?? null;
}

/**
 * Build a stable key for a stack frame group, e.g.
 *   "/app/src/index.js:155:persistDetection"
 *
 * Used to group multiple errors by their topmost app frame.
 */
export function frameKey(frame: StackFrame): string {
  const file = frame.cleanFile ?? "(unknown)";
  const line = frame.line ?? 0;
  const symbol = frame.symbol ?? "(anonymous)";
  return `${file}:${line}:${symbol}`;
}
