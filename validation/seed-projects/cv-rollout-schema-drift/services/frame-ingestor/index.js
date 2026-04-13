import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createLogger } from "../../shared/logger.js";
import { generateTraceId, generateSpanId } from "../../shared/trace.js";
import { envStr, envInt } from "../../shared/env.js";
import { randomInt } from "../../shared/random.js";

const SERVICE_NAME = "frame-ingestor";
const SERVICE_VERSION = envStr("SERVICE_VERSION", "1.0.0");
const SERVICE_ENV = envStr("SERVICE_ENVIRONMENT", "staging");
const DEPLOYMENT_VERSION = envStr("DEPLOYMENT_VERSION", "deploy-2026-04-12-rollout-b");
const CAMERA_ID = envStr("CAMERA_ID", "camera-east-loading-bay");
const DETECTOR_URL = envStr("DETECTOR_WORKER_URL", "http://detector-worker:3001");
const FRAME_INTERVAL_MS = envInt("FRAME_INTERVAL_MS", 200);
const TOTAL_FRAMES = envInt("TOTAL_FRAMES", 500);
const PORT = envInt("PORT", 3000);

const log = createLogger(SERVICE_NAME, SERVICE_VERSION, {
  "deployment.version": DEPLOYMENT_VERSION,
  "service.environment": SERVICE_ENV,
});

let frameCounter = 0;

async function sendFrame() {
  frameCounter++;
  const traceId = generateTraceId();
  const spanId = generateSpanId();
  const frameId = `frame-${frameCounter}`;

  const traceFields = { "trace.id": traceId, "span.id": spanId };

  log.info("Frame received for inference", {
    ...traceFields,
    "camera.id": CAMERA_ID,
    "frame.id": frameId,
  });

  const payload = JSON.stringify({
    traceId,
    spanId,
    frameId,
    cameraId: CAMERA_ID,
    frameNumber: frameCounter,
  });

  try {
    const res = await fetch(`${DETECTOR_URL}/detect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
    if (!res.ok) {
      log.warn("Detector worker returned non-OK", {
        ...traceFields,
        "frame.id": frameId,
        "http.status_code": res.status,
      });
    }
  } catch (err) {
    log.error("Failed to reach detector worker", {
      ...traceFields,
      "frame.id": frameId,
      "error.message": err.message,
    });
  }
}

async function runFrameLoop() {
  log.info("Frame ingestor starting", {
    "camera.id": CAMERA_ID,
    "deployment.version": DEPLOYMENT_VERSION,
    totalFrames: TOTAL_FRAMES,
    intervalMs: FRAME_INTERVAL_MS,
  });

  // Emit periodic heartbeat noise
  const heartbeatInterval = setInterval(() => {
    log.debug("Heartbeat: frame-ingestor alive", {
      "camera.id": CAMERA_ID,
      framesEmitted: frameCounter,
    });
  }, 10_000);

  for (let i = 0; i < TOTAL_FRAMES; i++) {
    await sendFrame();
    await delay(FRAME_INTERVAL_MS);
  }

  clearInterval(heartbeatInterval);
  log.info("Frame ingestor completed all frames", {
    "camera.id": CAMERA_ID,
    totalFrames: TOTAL_FRAMES,
  });

  // Stay alive so Docker doesn't restart
  await delay(5_000);
  process.exit(0);
}

// Health endpoint
const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok", framesEmitted: frameCounter }));
});

server.listen(PORT, () => {
  log.info("Frame ingestor HTTP server listening", { port: PORT });
  runFrameLoop();
});
