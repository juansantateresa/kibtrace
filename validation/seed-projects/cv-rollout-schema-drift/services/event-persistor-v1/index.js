import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { createLogger } from "../../shared/logger.js";
import { createTraceContext } from "../../shared/trace.js";
import { envStr, envInt } from "../../shared/env.js";

const { Client } = pg;

const SERVICE_NAME = "event-persistor";
const SERVICE_VERSION = envStr("SERVICE_VERSION", "v1");
const SERVICE_ENV = envStr("SERVICE_ENVIRONMENT", "staging");
const DEPLOYMENT_VERSION = envStr("DEPLOYMENT_VERSION", "deploy-2026-04-12-rollout-b");
const DATABASE_URL = envStr("DATABASE_URL", "postgres://kibtrace:kibtrace@postgres:5432/detections");
const PORT = envInt("PORT", 3002);

const TARGET_TABLE = "detection_events";

const log = createLogger(SERVICE_NAME, SERVICE_VERSION, {
  "deployment.version": DEPLOYMENT_VERSION,
  "service.environment": SERVICE_ENV,
});

let dbClient = null;
let persistCount = 0;

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

  await dbClient.query(sql, [traceId, body.cameraId, body.peopleCount]);
  persistCount++;

  log.info("Detection event persisted", {
    ...traceFields,
    "frame.id": body.frameId,
    db: { table: TARGET_TABLE },
  });

  return { status: "ok" };
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
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      log.error("Persistence failed unexpectedly", {
        "error.message": err.message,
        "error.stack_trace": err.stack,
      });
      res.writeHead(500);
      res.end("Internal Server Error");
    }
  } else {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", persistCount }));
  }
});

async function main() {
  log.info("Event persistor v1 starting", {
    port: PORT,
    targetTable: TARGET_TABLE,
  });

  dbClient = await connectDb();

  server.listen(PORT, () => {
    log.info("Event persistor v1 ready", { port: PORT });
  });
}

main().catch((err) => {
  log.fatal("Event persistor v1 crashed", {
    "error.message": err.message,
    "error.stack_trace": err.stack,
  });
  process.exit(1);
});
