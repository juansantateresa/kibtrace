/**
 * Structured JSON logger with ECS-like fields.
 * Writes one JSON line per event to stdout.
 */

export function createLogger(serviceName, serviceVersion, extra = {}) {
  const base = {
    "service.name": serviceName,
    "service.version": serviceVersion,
    ...extra,
  };

  function emit(level, message, fields = {}) {
    const event = {
      "@timestamp": new Date().toISOString(),
      message,
      log: { level },
      service: {
        name: base["service.name"],
        version: base["service.version"],
        environment: fields["service.environment"] || base["service.environment"] || undefined,
      },
      event: {
        dataset: `${base["service.name"]}.application`,
      },
    };

    // Merge extra base fields
    if (base["deployment.version"]) {
      event.deployment = { version: base["deployment.version"] };
    }

    // Merge caller fields
    for (const [k, v] of Object.entries(fields)) {
      if (k === "service.environment") continue;
      setNested(event, k, v);
    }

    // Clean undefined values
    cleanUndefined(event);

    process.stdout.write(JSON.stringify(event) + "\n");
  }

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    fatal: (msg, fields) => emit("fatal", msg, fields),
  };
}

function setNested(obj, dottedKey, value) {
  const parts = dottedKey.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== "object") {
      cur[parts[i]] = {};
    }
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function cleanUndefined(obj) {
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined) {
      delete obj[key];
    } else if (typeof obj[key] === "object" && obj[key] !== null && !Array.isArray(obj[key])) {
      cleanUndefined(obj[key]);
      if (Object.keys(obj[key]).length === 0) delete obj[key];
    }
  }
}
