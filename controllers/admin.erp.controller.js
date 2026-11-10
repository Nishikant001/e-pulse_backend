// controllers/admin.erp.controller.js — Admin ERP integration + sync (Phases 13–14). Every route is behind requireAdmin.
// The tenant is derived from the authenticated session (services/erp/tenantScope.js); a `tenantKey` in body/query is ignored.
// Controllers never talk to an ERP: they call the services only.
const db = require("../models");
const svc = require("../services/erpIntegration.service");
const sync = require("../services/erpSync.service");
const monitor = require("../services/erpMonitoring.service");
const scheduler = require("../services/erpScheduler.service");
const auditSvc = require("../services/erpAudit.service");
const codeMaps = require("../services/erpCodeMapping.service");
const outbound = require("../services/erpOutbound.service");
const readiness = require("../services/erpReadiness.service");
const business = require("../services/erpBusiness.service");
const reconciliation = require("../services/erpReconciliation.service");
const { resolveTenantKey } = require("../services/erp/tenantScope");
const { sendError, describeError } = require("../middleware/errorHandler");
const { redactString } = require("../services/erp/redaction");

// Every ERP response goes through here. Success bodies are unchanged; failures use the standard shape from middleware/errorHandler.js
// (flat message/code/details kept for existing clients + { success:false, error:{code,message,correlationId} }). Unexpected errors are a fixed
// message — the detail goes to the server log, redacted, with the same correlation id.
async function handle(req, res, fn, okStatus = 200, notFound = "ERP connection not found") {
  res.set("Cache-Control", "no-store");
  try {
    const data = await fn();
    if (data === null || data === undefined) return sendError(res, req, 404, "NOT_FOUND", notFound);
    return res.status(okStatus).json(data);
  } catch (err) {
    if (err instanceof svc.ErpApiError) return sendError(res, req, err.statusCode, err.code, err.message, err.details);
    const d = describeError(err);
    if (d.status >= 500) console.error(redactString(`[admin-erp] cid=${req.correlationId || "-"} ${req.method} ${req.route && req.route.path} ${err && err.name}: ${err && err.message}`, 400));
    return sendError(res, req, d.status, d.code, d.message, d.details);
  }
}
const adminId = (req) => req.admin && req.admin.id;
const scope = (req) => resolveTenantKey(req);

// connections (Phase 13)
exports.lookups = (req, res) => handle(req, res, async () => svc.getLookups());
exports.list = (req, res) => handle(req, res, () => svc.listConnections(db, scope(req), req.query || {}));
exports.get = (req, res) => handle(req, res, () => svc.getConnection(db, scope(req), req.params.id));
exports.create = (req, res) => handle(req, res, () => svc.createConnection(db, scope(req), adminId(req), req.body), 201);
exports.update = (req, res) => handle(req, res, () => svc.updateConnection(db, scope(req), adminId(req), req.params.id, req.body));
exports.setStatus = (req, res) => handle(req, res, () => svc.setStatus(db, scope(req), adminId(req), req.params.id, req.body || {}));
exports.setDefault = (req, res) => handle(req, res, () => svc.setDefault(db, scope(req), adminId(req), req.params.id));
exports.test = (req, res) => handle(req, res, () => svc.testConnection(db, scope(req), adminId(req), req.params.id, { correlationId: cid(req) }));

// mappings + sync (Phase 14)
exports.getMappings = (req, res) => handle(req, res, () => sync.getMappings(db, scope(req), req.params.id, req.params.capability));
exports.saveMappings = (req, res) => handle(req, res, () => sync.saveMappings(db, scope(req), adminId(req), req.params.id, req.params.capability, req.body));
exports.syncSummary = (req, res) => handle(req, res, () => monitor.getSummary(db, scope(req)));
exports.listJobs = (req, res) => handle(req, res, () => sync.listJobs(db, scope(req), req.query || {}));
exports.getJob = (req, res) => handle(req, res, () => sync.getJob(db, scope(req), req.params.id), 200, "Sync job not found");
exports.jobErrors = (req, res) => handle(req, res, () => sync.listJobErrors(db, scope(req), req.params.id, req.query || {}), 200, "Sync job not found");
exports.startSync = (req, res) => handle(req, res, () => sync.startSync(db, scope(req), adminId(req), req.body, { correlationId: cid(req) }), 202);
exports.retryJob = (req, res) => handle(req, res, () => sync.retryJob(db, scope(req), adminId(req), req.params.id, { correlationId: cid(req) }), 202, "Sync job not found");

// monitoring + schedules (Phase 15)
exports.listErrors = (req, res) => handle(req, res, () => monitor.listErrors(db, scope(req), req.query || {}));
exports.listSchedules = (req, res) => handle(req, res, () => scheduler.listSchedules(db, scope(req), req.query || {}));
exports.getSchedule = (req, res) => handle(req, res, () => scheduler.getSchedule(db, scope(req), req.params.id), 200, "Schedule not found");
exports.saveSchedule = (req, res) => handle(req, res, () => scheduler.saveSchedule(db, scope(req), adminId(req), req.params.id, req.params.capability, req.body));
exports.runSchedule = (req, res) => handle(req, res, () => scheduler.triggerSchedule(db, scope(req), adminId(req), req.params.id), 202, "Schedule not found");

// Phase 16 — persistent audit (read-only: there is no write route), alerts, code mappings, outbound (DMS → ERP)
const cid = (req) => req.correlationId || undefined;
const withConn = async (req, fn) => { const conn = await sync.loadConnection(db, scope(req), req.params.id); return conn ? fn(conn) : null; };
exports.listAudit = (req, res) => handle(req, res, () => auditSvc.list(db, scope(req), req.query || {}));
exports.alerts = (req, res) => handle(req, res, () => monitor.getAlerts(db, scope(req)));
exports.listCodeMappings = (req, res) => handle(req, res, () => withConn(req, (c) => codeMaps.list(db, scope(req), c, req.query || {})));
exports.saveCodeMapping = (req, res) => handle(req, res, () => withConn(req, (c) => codeMaps.upsert(db, scope(req), adminId(req), c, req.body || {})));
exports.deleteCodeMapping = (req, res) => handle(req, res, () => withConn(req, (c) => codeMaps.remove(db, scope(req), adminId(req), c, req.params.mappingId)), 200, "Mapping not found");
exports.sendOutbound = (req, res) => handle(req, res, () => outbound.send(db, scope(req), adminId(req), req.body || {}, { correlationId: cid(req) }), 200);
exports.listOutbound = (req, res) => handle(req, res, () => outbound.list(db, scope(req), req.query || {}));

// Phase 17 — production readiness (read-only; never contacts an ERP, never returns a secret)
exports.readiness = (req, res) => handle(req, res, () => readiness.run(db, scope(req), { schedulerState: scheduler.getState() }));

// Phase 18 — business-capability overview / monitoring (read-only) and reconciliation (read-only comparison; stores only a note on the compared links)
exports.businessOverview = (req, res) => handle(req, res, () => business.overview(db, scope(req)));
exports.runReconciliation = (req, res) => handle(req, res, () => reconciliation.run(db, scope(req), adminId(req), req.body || {}, { correlationId: cid(req) }), 200);
exports.listReconciliation = (req, res) => handle(req, res, () => reconciliation.list(db, scope(req), req.query || {}));
