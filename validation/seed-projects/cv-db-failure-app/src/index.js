import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";

const { Client } = pg;

const config = {
  databaseUrl:
    process.env.DATABASE_URL ?? "postgres://kibtrace:kibtrace@postgres:5432/detections",
  logFile: process.env.LOG_FILE ?? "/app/logs/cv-db-failure-app.ndjson",
  serviceName: process.env.SERVICE_NAME ?? "cv-db-failure-app",
  serviceVersion: process.env.SERVICE_VERSION ?? "0.1.0-sandbox",
  cameraId: process.env.CAMERA_ID ?? "camera-east-loading-bay",
  modelVersion: process.env.MODEL_VERSION ?? "yolo11n-2026.04",
  deploymentVersion:
    process.env.DEPLOYMENT_VERSION ?? "deploy-2026-04-09-a",
  frameIntervalMs: Number(process.env.FRAME_INTERVAL_MS ?? "750"),
  incidentMode: process.env.INCIDENT_MODE ?? "wrong_table",
  logLevel: process.env.LOG_LEVEL ?? "info"
};

const state = {
  frame: 0,
  startupTime: new Date().toISOString()
};

function ensureLogDirectory(logFile) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function padHex(value) {
  return value.toString(16).padStart(16, "0");
}

function traceIdForFrame(frame) {
  return `${padHex(frame)}${padHex(frame + 1024)}`;
}

function transactionIdForFrame(frame) {
  return padHex(frame + 4096);
}

function buildBaseEvent(level, message, extra = {}) {
  return {
    "@timestamp": nowIso(),
    message,
    log: { level },
    service: {
      name: config.serviceName,
      version: config.serviceVersion
    },
    event: {
      dataset: `${config.serviceName}.application`
    },
    deployment: {
      version: config.deploymentVersion
    },
    camera: {
      id: config.cameraId
    },
    model: {
      version: config.modelVersion
    },
    labels: {
      kibtrace_sandbox: "true"
    },
    ...extra
  };
}

function writeEvent(level, message, extra = {}) {
  const event = buildBaseEvent(level, message, extra);
  fs.appendFileSync(config.logFile, `${JSON.stringify(event)}\n`, "utf8");
}

async function connectPostgres() {
  let lastError;

  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const client = new Client({ connectionString: config.databaseUrl });

    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      writeEvent("warn", "Waiting for postgres connection", {
        error: {
          message: error.message,
          type: error.name,
          stack_trace: error.stack
        },
        kibtrace: {
          startup_attempt: attempt
        }
      });
      await delay(1000);
    }
  }

  throw lastError;
}

async function bootstrapDatabase(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS detection_events (
      id SERIAL PRIMARY KEY,
      trace_id TEXT NOT NULL,
      camera_id TEXT NOT NULL,
      person_count INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

function detectionProfile(frame) {
  const detected = frame % 4 === 0 || frame % 7 === 0;
  const personCount = detected ? ((frame % 3) + 1) : 0;
  const inferenceMs = 24 + (frame % 6) * 5;

  return {
    detected,
    personCount,
    inferenceMs
  };
}

async function persistDetection(client, frame, profile, trace) {
  const targetTable =
    config.incidentMode === "wrong_table" ? "detection_events_v2" : "detection_events";
  const sql = `INSERT INTO ${targetTable} (trace_id, camera_id, person_count) VALUES ($1, $2, $3)`;

  writeEvent("info", "Persisting detection event", {
    trace,
    db: {
      operation: "insert",
      statement: sql
    },
    person: {
      detected: true,
      count: profile.personCount
    },
    kibtrace: {
      frame_id: frame
    }
  });

  try {
    await client.query(sql, [trace.id, config.cameraId, profile.personCount]);
    writeEvent("info", "Detection event persisted", {
      trace,
      person: {
        detected: true,
        count: profile.personCount
      },
      kibtrace: {
        frame_id: frame
      }
    });
  } catch (error) {
    writeEvent("error", "Failed to persist detection event", {
      trace,
      person: {
        detected: true,
        count: profile.personCount
      },
      db: {
        operation: "insert",
        statement: sql
      },
      error: {
        message: error.message,
        type: error.name,
        stack_trace: error.stack
      },
      kibtrace: {
        frame_id: frame,
        retry: 1
      }
    });

    await delay(150);

    writeEvent("warn", "Retrying detection event persistence", {
      trace,
      db: {
        operation: "insert"
      },
      kibtrace: {
        frame_id: frame,
        retry: 2
      }
    });

    try {
      await client.query(sql, [trace.id, config.cameraId, profile.personCount]);
    } catch (retryError) {
      writeEvent("error", "Detection event persistence retry failed", {
        trace,
        person: {
          detected: true,
          count: profile.personCount
        },
        db: {
          operation: "insert",
          statement: sql
        },
        error: {
          message: retryError.message,
          type: retryError.name,
          stack_trace: retryError.stack
        },
        kibtrace: {
          frame_id: frame,
          retry: 2
        }
      });
    }
  }
}

async function emitFrame(client, frame) {
  const trace = {
    id: traceIdForFrame(frame)
  };
  const transaction = {
    id: transactionIdForFrame(frame)
  };
  const profile = detectionProfile(frame);

  writeEvent("info", "Frame received for inference", {
    trace,
    transaction,
    kibtrace: {
      frame_id: frame,
      startup_time: state.startupTime
    }
  });

  writeEvent("debug", "Frame preprocessed for model input", {
    trace,
    transaction,
    kibtrace: {
      frame_id: frame,
      image_shape: "640x640"
    }
  });

  writeEvent(profile.detected ? "info" : "debug", "Inference completed", {
    trace,
    transaction,
    person: {
      detected: profile.detected,
      count: profile.personCount
    },
    inference: {
      ms: profile.inferenceMs
    },
    kibtrace: {
      frame_id: frame
    }
  });

  if (!profile.detected) {
    writeEvent("info", "No people detected in frame", {
      trace,
      transaction,
      person: {
        detected: false,
        count: 0
      },
      kibtrace: {
        frame_id: frame
      }
    });
    return;
  }

  writeEvent("info", "People detected in frame", {
    trace,
    transaction,
    person: {
      detected: true,
      count: profile.personCount
    },
    inference: {
      ms: profile.inferenceMs
    },
    kibtrace: {
      frame_id: frame
    }
  });

  await persistDetection(client, frame, profile, trace);
}

async function main() {
  ensureLogDirectory(config.logFile);

  writeEvent(config.logLevel, "Starting sandbox CV service", {
    kibtrace: {
      incident_mode: config.incidentMode
    }
  });

  const client = await connectPostgres();
  await bootstrapDatabase(client);

  writeEvent("info", "Sandbox CV service ready", {
    kibtrace: {
      incident_mode: config.incidentMode
    }
  });

  while (true) {
    state.frame += 1;
    await emitFrame(client, state.frame);
    await delay(config.frameIntervalMs);
  }
}

main().catch((error) => {
  ensureLogDirectory(config.logFile);
  writeEvent("fatal", "Sandbox CV service crashed", {
    error: {
      message: error.message,
      type: error.name,
      stack_trace: error.stack
    }
  });
  process.exitCode = 1;
});
