import { createServer } from "node:http";
import { createLogger } from "../../shared/logger.js";
import { createTraceContext } from "../../shared/trace.js";
import { envStr, envInt } from "../../shared/env.js";
import { shouldRouteToV2, randomInt } from "../../shared/random.js";

const SERVICE_NAME = "detector-worker";
const SERVICE_VERSION = envStr("SERVICE_VERSION", "1.0.0");
const SERVICE_ENV = envStr("SERVICE_ENVIRONMENT", "staging");
const DEPLOYMENT_VERSION = envStr("DEPLOYMENT_VERSION", "deploy-2026-04-12-rollout-b");
const MODEL_VERSION = envStr("MODEL_VERSION", "yolo11n-2026.04");
const V2_ROUTE_PERCENT = envInt("V2_ROUTE_PERCENT", 30);
const PERSISTOR_V1_URL = envStr("PERSISTOR_V1_URL", "http://event-persistor-v1:3002");
const PERSISTOR_V2_URL = envStr("PERSISTOR_V2_URL", "http://event-persistor-v2:3003");
const PORT = envInt("PORT", 3001);

const log = createLogger(SERVICE_NAME, SERVICE_VERSION, {
  "deployment.version": DEPLOYMENT_VERSION,
  "service.environment": SERVICE_ENV,
});

let requestCount = 0;

async function handleDetect(body) {
  const traceId = body.traceId;
  const parentSpanId = body.spanId;
  const ctx = createTraceContext(traceId, parentSpanId);
  const traceFields = {
    "trace.id": ctx["trace.id"],
    "span.id": ctx["span.id"],
    "parent.span.id": ctx["parent.span.id"],
  };

  const frameId = body.frameId;

  // Preprocessing
  log.debug("Frame preprocessed for model input", {
    ...traceFields,
    "frame.id": frameId,
    "model.version": MODEL_VERSION,
    preprocessing: { shape: "640x640", normalization: "float32" },
  });

  // Inference
  const inferenceMs = randomInt(18, 45);
  const peopleCount = randomInt(0, 4);
  const detected = peopleCount > 0;

  log.info("Inference completed", {
    ...traceFields,
    "frame.id": frameId,
    "model.version": MODEL_VERSION,
    "people.count": peopleCount,
    inference: { ms: inferenceMs, model: MODEL_VERSION },
  });

  if (!detected) {
    log.debug("No people detected in frame", {
      ...traceFields,
      "frame.id": frameId,
      "people.count": 0,
    });
    return { status: "no_detection", peopleCount: 0 };
  }

  log.info("People detected in frame", {
    ...traceFields,
    "frame.id": frameId,
    "people.count": peopleCount,
    "model.version": MODEL_VERSION,
  });

  // Route to v1 or v2 persistor
  const useV2 = shouldRouteToV2(V2_ROUTE_PERCENT);
  const persistorUrl = useV2 ? PERSISTOR_V2_URL : PERSISTOR_V1_URL;
  const persistorVersion = useV2 ? "v2" : "v1";

  const payload = JSON.stringify({
    traceId: ctx["trace.id"],
    spanId: ctx["span.id"],
    frameId,
    cameraId: body.cameraId,
    peopleCount,
    persistorVersion,
  });

  try {
    const res = await fetch(`${persistorUrl}/persist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
    if (!res.ok) {
      log.warn("Persistor returned non-OK", {
        ...traceFields,
        "frame.id": frameId,
        "http.status_code": res.status,
        persistorVersion,
      });
    }
  } catch (err) {
    log.error("Failed to reach persistor", {
      ...traceFields,
      "frame.id": frameId,
      "error.message": err.message,
      persistorVersion,
    });
  }

  return { status: "persisted", peopleCount, persistorVersion };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/detect") {
    requestCount++;
    try {
      const body = await readBody(req);
      const result = await handleDetect(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      log.error("Unhandled error in detect handler", {
        "error.message": err.message,
        "error.stack_trace": err.stack,
      });
      res.writeHead(500);
      res.end("Internal Server Error");
    }
  } else {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", requestsHandled: requestCount }));
  }
});

// Periodic noise: warnings about model cache
setInterval(() => {
  if (requestCount > 0) {
    log.warn("Model cache approaching eviction threshold", {
      "model.version": MODEL_VERSION,
      cache: { usedMb: randomInt(400, 480), maxMb: 512 },
    });
  }
}, 15_000);

server.listen(PORT, () => {
  log.info("Detector worker starting", {
    port: PORT,
    "model.version": MODEL_VERSION,
    v2RoutePercent: V2_ROUTE_PERCENT,
  });
});
