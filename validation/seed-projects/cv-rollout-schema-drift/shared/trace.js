/**
 * Trace ID generation and propagation.
 * Generates W3C-style 32-hex-char trace IDs and 16-hex-char span IDs.
 */

import { randomBytes } from "node:crypto";

export function generateTraceId() {
  return randomBytes(16).toString("hex");
}

export function generateSpanId() {
  return randomBytes(8).toString("hex");
}

/**
 * Build a trace context object for propagation between services.
 */
export function createTraceContext(traceId, parentSpanId) {
  const spanId = generateSpanId();
  return {
    "trace.id": traceId || generateTraceId(),
    "span.id": spanId,
    ...(parentSpanId ? { "parent.span.id": parentSpanId } : {}),
  };
}

/**
 * Extract trace fields from an incoming HTTP request body.
 */
export function extractTrace(body) {
  return {
    "trace.id": body["trace.id"] || body.traceId,
    "parent.span.id": body["span.id"] || body.spanId,
  };
}
