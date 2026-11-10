require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const cookieParser = require("cookie-parser");

const app = express();
const syncDB = require("./config/dbSync");
const { requestContext, rejectDangerousKeys } = require("./middleware/requestContext");
const { errorHandler, notFound } = require("./middleware/errorHandler");
const { securityHeaders } = require("./middleware/securityHeaders");
const { errorSanitizer } = require("./middleware/errorSanitizer");
const { validateEnv } = require("./config/envCheck");

// Phase 17 — behind a reverse proxy set TRUST_PROXY (e.g. "1") so req.ip is the real client address for rate limiting and login throttling.
if (process.env.TRUST_PROXY) app.set("trust proxy", /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
app.disable("x-powered-by");

app.use(securityHeaders); // Phase 23: nosniff / frame / CSP / Referrer / no-store (+ HSTS in production over HTTPS)
app.use(requestContext); // correlation id for every request (X-Correlation-ID), also available to services via AsyncLocalStorage
app.use(
  cors({
    // frontend URL(s): a single origin, or several separated by commas (Phase 23). Set CORS_ORIGIN in production.
    origin: (process.env.CORS_ORIGIN || "http://localhost:5173").split(",").map((o) => o.trim()).filter(Boolean),
    credentials: true, // allow cookies
    exposedHeaders: ["X-Correlation-ID", "Retry-After"],
  })
);
// Explicit body-size limit (this is also body-parser's historical default, now visible and tunable). Larger → 413 PAYLOAD_TOO_LARGE.
app.use(bodyParser.json({ limit: process.env.JSON_BODY_LIMIT || "100kb" }));
app.use(cookieParser());
// Phase 24: Express 5 leaves req.body undefined for a non-JSON request; controllers destructure it, so a forged text/plain or form POST used to end in a TypeError -> 500. Empty object -> normal 400 validation.
app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });
app.use(errorSanitizer); // Phase 24: 5xx bodies never carry raw exception text

// Health probes for load balancers / orchestrators. Unauthenticated, so they answer with a status word only — no versions, hosts or details.
app.get("/api/health/live", (req, res) => res.json({ status: "ok" }));
app.get("/api/health/ready", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try { await require("./models").sequelize.authenticate(); return res.json({ status: "ready" }); } catch { return res.status(503).json({ status: "unavailable" }); }
});

// Routes
// Admin portal API — separate auth boundary; mounted first so it is never handled by the Distributor route table.
app.use("/api/admin", rejectDangerousKeys, require("./routes/adminRoutes"));
app.use("/api/public", require("./routes/publicRoutes")); // Phase 24: public website contact form (rate limited, no tenant data)
app.use("/api", require("./routes/allRoutes"));
app.use("/api", notFound); // JSON 404 instead of Express's HTML page
app.use(errorHandler); // standard error shape; never a stack trace, SQL or path

const PORT = process.env.PORT || 5000;

if (require.main === module) {
  // Phase 23: refuse to start a production process with a missing/weak essential setting; warn (names only, never values) about the rest.
  const envReport = validateEnv(process.env);
  envReport.warnings.forEach((w) => console.warn(`[env] warning: ${w}`));
  if (!envReport.ok) { envReport.errors.forEach((e) => console.error(`[env] error: ${e}`)); process.exit(1); }
  syncDB().then(() => {
    const httpServer = app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      // Phase 15: in-process ERP sync scheduler + worker (creates jobs from due schedules, runs queued ones). Disable with ERP_SCHEDULER_ENABLED=false.
      if (process.env.ERP_SCHEDULER_ENABLED !== "false") require("./services/erpScheduler.service").startScheduler(require("./models"));
    });
    // Phase 23: bounded connection lifetimes so a slow or stalled client cannot hold a socket forever (tunable; Node's own defaults otherwise).
    httpServer.headersTimeout = Number(process.env.HEADERS_TIMEOUT_MS) > 0 ? Number(process.env.HEADERS_TIMEOUT_MS) : 60000;
    httpServer.requestTimeout = Number(process.env.REQUEST_TIMEOUT_MS) > 0 ? Number(process.env.REQUEST_TIMEOUT_MS) : 120000;
    httpServer.keepAliveTimeout = Number(process.env.KEEPALIVE_TIMEOUT_MS) > 0 ? Number(process.env.KEEPALIVE_TIMEOUT_MS) : 65000;
    // Graceful shutdown: stop accepting requests, let running ERP syncs finish (bounded by ERP_SHUTDOWN_GRACE_SECONDS), hand back the rest, then exit.
    let closing = false;
    const shutdown = async (signal) => {
      if (closing) return; closing = true;
      console.log(`[shutdown] ${signal}: stopping`);
      httpServer.close();
      try {
        const r = await require("./services/erpScheduler.service").shutdownScheduler({ db: require("./models") });
        console.log(`[shutdown] ERP worker stopped (still running: ${r.stillRunning}, released: ${r.released})`);
        await require("./services/erpAudit.service").flush();
      } catch (_) { /* exit anyway */ }
      process.exit(0);
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  });
}

module.exports = app;
