import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { createLogger } from "../../shared/logger.js";
import { createTraceContext } from "../../shared/trace.js";
import { envStr, envInt } from "../../shared/env.js";

const { Client } = pg;

const SERVICE_NAME = "event-persistor";
const SERVICE_VERSION = envStr("SERVICE_VERSION", "v2");
const SERVICE_ENV = envStr("SERVICE_ENVIRONMENT", "staging");
const DEPLOYMENT_VERSION = envStr("DEPLOYMENT_VERSION", "deploy-2026-04-12-rollout-b");
const DATABASE_URL = envStr("DATABASE_URL", "postgres://kibtrace:kibtrace@postgres:5432/detections");
const PORT = envInt("PORT", 3003);

// v2 writes to the new table — but the migration hasn't been applied yet
const TARGET_TABLE = "detection_events_v2";

const log = createLogger(SERVICE_NAME, SERVICE_VERSION, {
  "deployment.version": DEPLOYMENT_VERSION,
  "service.environment": SERVICE_ENV,
});

let dbClient = null;
let persistAttempts = 0;
let persistFailures = 0;

async function connectDb() {
  for (let attempt = 1; attempt <= 30; attempt++) {
    const client = new Client({ connectionString: DATABASE_URL });
    try {
      await client.connect();
      log.info("Connected to database", { attempt });
      return client;
    } catch (err) {
      log.warn("Waiting for postgres connection", {
        "error.message": err.message,
        attempt,
      });
      await delay(1000);
    }
  }
  throw new Error("Could not connect to postgres after 30 attempts");
}

async function handlePersist(body) {
  const traceId = body.traceId;
  const parentSpanId = body.spanId;
  const ctx = createTraceContext(traceId, parentSpanId);
  const traceFields = {
    "trace.id": ctx["trace.id"],
    "span.id": ctx["span.id"],
    "parent.span.id": ctx["parent.span.id"],
  };

  const sql = `INSERT INTO ${TARGET_TABLE} (trace_id, camera_id, person_count) VALUES ($1, $2, $3)`;

  log.info("Persisting detection event", {
    ...traceFields,
    "frame.id": body.frameId,
    db: { operation: "insert", statement: sql, table: TARGET_TABLE },
  });

  persistAttempts++;

  try {
    await dbClient.query(sql, [traceId, body.cameraId, body.peopleCount]);
    log.info("Detection event persisted", {
      ...traceFields,
      "frame.id": body.frameId,
      db: { table: TARGET_TABLE },
    });
    return { status: "ok" };
  } catch (error) {
    persistFailures++;

    log.error(error.message, {
      ...traceFields,
      "frame.id": body.frameId,
      db: { operation: "insert", statement: sql, table: TARGET_TABLE },
      "error.message": error.message,
      "error.stack_trace": error.stack,
    });

    // Retry once
    await delay(150);

    log.warn("Retrying detection event persistence", {
      ...traceFields,
      "frame.id": body.frameId,
      db: { operation: "insert", table: TARGET_TABLE },
      retry: 1,
    });

    try {
      await dbClient.query(sql, [traceId, body.cameraId, body.peopleCount]);
      log.info("Detection event persisted on retry", {
        ...traceFields,
        "frame.id": body.frameId,
        db: { table: TARGET_TABLE },
      });
      return { status: "ok_retry" };
    } catch (retryError) {
      log.error(retryError.message, {
        ...traceFields,
        "frame.id": body.frameId,
        db: { operation: "insert", statement: sql, table: TARGET_TABLE },
        "error.message": retryError.message,
        "error.stack_trace": retryError.stack,
        retry: 2,
      });
      return { status: "failed" };
    }
  }
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
  if (req.method === "POST" && req.url === "/persist") {
    try {
      const body = await readBody(req);
      const result = await handlePersist(body);
      const statusCode = result.status === "failed" ? 500 : 200;
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      log.error("Unhandled persistence error", {
        "error.message": err.message,
        "error.stack_trace": err.stack,
      });
      res.writeHead(500);
      res.end("Internal Server Error");
    }
  } else {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", persistAttempts, persistFailures }));
  }
});

async function main() {
  log.info("Event persistor v2 starting", {
    port: PORT,
    targetTable: TARGET_TABLE,
  });

  dbClient = await connectDb();

  server.listen(PORT, () => {
    log.info("Event persistor v2 ready", { port: PORT });
  });
}

main().catch((err) => {
  log.fatal("Event persistor v2 crashed", {
    "error.message": err.message,
    "error.stack_trace": err.stack,
  });
  process.exit(1);
});
