/**
 * Environment variable parsing with defaults.
 */

export function envStr(key, fallback) {
  return process.env[key] ?? fallback;
}

export function envInt(key, fallback) {
  const v = process.env[key];
  if (v == null) return fallback;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}
