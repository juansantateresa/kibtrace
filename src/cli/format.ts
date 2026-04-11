/**
 * Tiny formatting helper for the kibtrace CLI.
 *
 * Two output modes:
 *   - "machine": stable JSON, no ANSI, intended for Claude Code / automation.
 *   - "human":   compact, lightly colored terminal output for humans.
 *
 * Style is intentionally restrained: small palette, compact headers, clean
 * spacing, dim metadata. No banners, no ASCII art, no spinners.
 */

export type OutputMode = "machine" | "human";

export interface OutputOptions {
  mode: OutputMode;
  color: boolean;
}

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

function wrap(open: string, enabled: boolean): (s: string) => string {
  return (s: string) => (enabled ? `${ESC}${open}${s}${RESET}` : s);
}

export interface Palette {
  dim: (s: string) => string;
  bold: (s: string) => string;
  cyan: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  red: (s: string) => string;
}

export function makePalette(color: boolean): Palette {
  return {
    dim: wrap("2m", color),
    bold: wrap("1m", color),
    cyan: wrap("36m", color),
    green: wrap("32m", color),
    yellow: wrap("33m", color),
    red: wrap("31m", color)
  };
}

/**
 * Decide whether to emit ANSI colors.
 *  - machine mode: never
 *  - --no-color flag: never
 *  - NO_COLOR env (any non-empty value): never
 *  - non-TTY stdout: never
 */
export function shouldUseColor(noColorFlag: boolean, mode: OutputMode): boolean {
  if (mode === "machine") return false;
  if (noColorFlag) return false;
  if (process.env.NO_COLOR && process.env.NO_COLOR.length > 0) return false;
  if (!process.stdout.isTTY) return false;
  return true;
}

const KEY_WIDTH = 14;

/** "kibtrace fetch" — bold cyan, with optional dim subtitle. */
export function title(p: Palette, command: string, subtitle?: string): string {
  const main = p.bold(p.cyan(`kibtrace ${command}`));
  return subtitle ? `${main}  ${p.dim(subtitle)}` : main;
}

/** Compact section header (uppercase, dim). */
export function section(p: Palette, label: string): string {
  return p.dim(label.toUpperCase());
}

/**
 * "  key           value" — returns null when value is empty/missing so callers
 * can drop the row. Use empty string ("") for explicit blank lines.
 */
export function kv(
  p: Palette,
  key: string,
  value: string | number | null | undefined
): string | null {
  if (value === null || value === undefined || value === "") return null;
  const k = p.dim(key.padEnd(KEY_WIDTH));
  return `  ${k}${value}`;
}

/** Multi-row kv: first row has the key, subsequent rows are indented. */
export function kvList(p: Palette, key: string, values: string[]): string[] {
  if (values.length === 0) return [];
  const lines: string[] = [];
  const k = p.dim(key.padEnd(KEY_WIDTH));
  lines.push(`  ${k}${values[0]}`);
  const indent = " ".repeat(2 + KEY_WIDTH);
  for (const v of values.slice(1)) {
    lines.push(`${indent}${v}`);
  }
  return lines;
}

/** Dim "next  <command>" hint line. */
export function hint(p: Palette, command: string): string {
  return `  ${p.dim("next".padEnd(KEY_WIDTH))}${p.dim(command)}`;
}

/** Red "error: <message>" — write to stderr. */
export function statusError(p: Palette, message: string): string {
  return `${p.red("error")}  ${message}`;
}

/** Color a log level with a fixed visual width. */
export function colorLevel(p: Palette, level: string | undefined, width = 5): string {
  const display = (level ?? "?").padEnd(width);
  if (!level) return p.dim(display);
  switch (level) {
    case "FATAL":
    case "ERROR":
      return p.red(display);
    case "WARN":
      return p.yellow(display);
    case "INFO":
    case "DEBUG":
    case "TRACE":
      return p.dim(display);
    default:
      return display;
  }
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Pad a possibly-colored string to a fixed visual width. */
export function visualPad(s: string, width: number): string {
  const stripped = s.replace(ANSI_RE, "");
  const padding = Math.max(0, width - stripped.length);
  return s + " ".repeat(padding);
}

/** Pad a possibly-colored string from the left to a fixed visual width. */
export function visualPadStart(s: string, width: number): string {
  const stripped = s.replace(ANSI_RE, "");
  const padding = Math.max(0, width - stripped.length);
  return " ".repeat(padding) + s;
}

/**
 * Extract HH:MM:SS.sss from an ISO timestamp.
 * Returns the original string if no match.
 */
export function shortTime(iso: string | undefined): string {
  if (!iso) return "?";
  const m = iso.match(/T(\d{2}:\d{2}:\d{2}\.\d{3})/);
  return m ? m[1]! : iso;
}

/** Pick the highest-severity level present in a level breakdown. */
export function dominantLevel(levels: Record<string, number>): string {
  const order = ["FATAL", "ERROR", "WARN", "INFO", "DEBUG", "TRACE"];
  for (const lvl of order) {
    if ((levels[lvl] ?? 0) > 0) return lvl;
  }
  const keys = Object.keys(levels);
  return keys[0] ?? "?";
}

/**
 * Print a sequence of lines (or arrays of lines) to stdout.
 * - `null` is skipped (use this for "drop the row")
 * - `""` is printed as a blank line (use this for spacing)
 */
export function emit(lines: Array<string | string[] | null>): void {
  for (const line of lines) {
    if (line === null) continue;
    if (Array.isArray(line)) {
      for (const l of line) {
        console.log(l);
      }
    } else {
      console.log(line);
    }
  }
}
