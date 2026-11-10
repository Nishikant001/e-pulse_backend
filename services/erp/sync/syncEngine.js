// services/erp/sync/syncEngine.js — the ONE generic sync engine (ERP → DMS). It contains NO vendor, protocol or entity knowledge:
//   job → connection → provider (registry) → fetchPage… → normalized records → mapping → DMS target → link/skip/create/update → counts
// any provider adapter (ERP-specific or generic REST) all run through this same function.
// Safety: bounded pages / records, repeated-cursor guard, bounded retry (transient errors only), per-record isolation, heartbeat.
const { ErpIntegrationError, normalizeError, redact } = require("../erpErrors");
const { buildProvider } = require("../connectionManager");
const { getTarget } = require("./targets");
const { mapRecord, contentHash } = require("./mapper");

const LIMITS = { pageSize: 100, maxPages: 200, maxRecords: 20000, fetchAttempts: 3 };
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const plain = (r) => (r ? r.get({ plain: true }) : null);

async function fetchWithRetry(provider, args, { attempts, delayMs }) {
  let last;
  for (let i = 1; i <= attempts; i += 1) {
    try { return await provider.fetchPage(args); } catch (e) {
      last = provider.handleError(e);
      if (!last.retryable || i === attempts) throw last; // AUTH / MAPPING / VALIDATION / CONFIGURATION are never retried
      await sleep(delayMs * 2 ** (i - 1));
    }
  }
  throw last;
}

/**
 * @param {object} db @param {number} jobId
 * @param {object} [deps] { fetchImpl, logger, retryDelayMs, limits }  — injectable for tests
 * @returns the finished job row (plain)
 */
async function runSync(db, jobId, deps = {}) {
  const limits = { ...LIMITS, ...(deps.limits || {}) };
  const delayMs = deps.retryDelayMs ?? Number(process.env.ERP_SYNC_RETRY_DELAY_MS || 500);
  const log = deps.logger || ((l) => console.info(l));
  const job = await db.ErpSyncJob.findByPk(jobId);
  if (!job) return null;

  const c = { total: 0, processed: 0, created: 0, updated: 0, failed: 0, skipped: 0 };
  let fatal = null;
  const t0 = Date.now();
  const flush = (extra = {}) => job.update({ total_count: c.total, processed_count: c.processed, created_count: c.created, updated_count: c.updated, success_count: c.created + c.updated, failed_count: c.failed, skipped_count: c.skipped, heartbeat_at: new Date(), ...extra });
  const writeError = (index, externalId, err) => db.ErpSyncError.create({ job_id: job.id, tenant_key: job.tenant_key, connection_id: job.connection_id, capability: job.capability, record_index: index, external_id: externalId ? String(externalId).slice(0, 190) : null, error_code: err.code, message: String(err.message).slice(0, 500), retryable: Boolean(err.retryable) });
  const recordError = async (index, externalId, err) => { c.failed += 1; await writeError(index, externalId, err); };

  try {
    await job.update({ status: "RUNNING", started_at: new Date(), heartbeat_at: new Date() });
    log(`[erp-sync] job=${job.id} cid=${job.correlation_id} start tenant=${job.tenant_key} connection=${job.connection_id} capability=${job.capability}`);

    // Tenant-scoped: the job's own tenant key is the filter, so a connection of another tenant can never be loaded here.
    const conn = plain(await db.ErpConnection.findOne({ where: { id: job.connection_id, tenant_key: job.tenant_key } }));
    if (!conn) throw new ErpIntegrationError("INVALID_CONFIGURATION", { message: "The ERP connection no longer exists." });
    if (conn.status === "INACTIVE") throw new ErpIntegrationError("INVALID_CONFIGURATION", { message: "The ERP connection is inactive." });
    const cap = plain(await db.ErpConnectionCapability.findOne({ where: { connection_id: conn.id, capability: job.capability } }));
    if (!cap || !cap.enabled) throw new ErpIntegrationError("CAPABILITY_NOT_SUPPORTED", { message: "This capability is not enabled for the ERP connection." });
    const own = require("../../erpOwnership.service").evaluate(cap, job.capability, "inbound"); // Phase 16: defence in depth (a schedule may predate an ownership change)
    if (!own.ok) throw new ErpIntegrationError(own.code, { message: own.message });
    if (!cap.endpoint_path) throw new ErpIntegrationError("INVALID_CONFIGURATION", { message: "No endpoint is configured for this capability." });

    const target = getTarget(job.capability);
    if (!target) throw new ErpIntegrationError("CAPABILITY_NOT_SUPPORTED");
    const mappings = (await db.ErpEntityMapping.findAll({ where: { connection_id: conn.id, capability: job.capability }, order: [["id", "ASC"]] })).map(plain);
    if (!mappings.length || !mappings.some((m) => m.is_key)) throw new ErpIntegrationError("MAPPING_NOT_CONFIGURED");
    const resolved = await target.resolveScope(db, job.scope || {});
    const scopeKey = resolved.scopeKey;
    // Everything a target may need to stay tenant- and connection-correct; none of it comes from the ERP payload.
    const ctx = { ...resolved.ctx, connectionId: conn.id, tenantKey: job.tenant_key, jobId: job.id, adminId: job.requested_by_admin_id || null };
    // A target whose existing service owns its transaction (e.g. payments → journal) runs outside the engine's wrapper.
    const inTx = (fn) => (target.ownTransaction ? fn(undefined) : db.sequelize.transaction(fn));

    const capsPlain = (await db.ErpConnectionCapability.findAll({ where: { connection_id: conn.id } })).map(plain);
    const provider = await buildProvider(conn, { capabilities: capsPlain, fetchImpl: deps.fetchImpl, logger: deps.logger });
    if (!provider.supports.fetch) throw new ErpIntegrationError("PROVIDER_NOT_SUPPORTED", { message: "This provider cannot read data." });

    let cursor = null; let pages = 0; let seenTotal = null; let index = 0;
    do {
      const page = await fetchWithRetry(provider, { endpointPath: cap.endpoint_path, config: cap.config || {}, cursor, pageSize: limits.pageSize, correlationId: job.correlation_id }, { attempts: limits.fetchAttempts, delayMs });
      pages += 1;
      if (page.total !== null && page.total !== undefined && seenTotal === null) seenTotal = page.total;
      if (pages > limits.maxPages) throw new ErpIntegrationError("LIMIT_EXCEEDED", { message: `Stopped after ${limits.maxPages} pages.` });

      for (const rec of page.records) {
        if (index >= limits.maxRecords) throw new ErpIntegrationError("LIMIT_EXCEEDED", { message: `Stopped after ${limits.maxRecords} records.` });
        const i = index; index += 1; c.total += 1;
        let externalId = null;
        try {
          const mapped = mapRecord(rec, mappings);
          externalId = mapped.externalId;
          const outcome = await inTx(async (t) => {
            const where = { connection_id: conn.id, entity_type: target.entityType, external_id: mapped.externalId, scope_key: scopeKey };
            const link = await db.ErpExternalLink.findOne({ where, transaction: t });
            const entity = link ? await target.find(db, link.dms_entity_id, ctx, t) : null;
            const values = target.validate(mapped.values, { creating: !entity, ctx });
            const hash = contentHash(values);
            if (link && entity) {
              if (link.content_hash === hash) { await link.update({ last_synced_at: new Date(), last_job_id: job.id }, { transaction: t }); return "skipped"; }
              // Phase 18 ECHO PREVENTION: the first time the ERP shows a record that THIS DMS sent (link.origin DMS, never seen by a sync job) it only binds the
              // hash. The DMS row is not rewritten with the ERP's echo; later, genuine ERP changes are handled by the target's own update rules.
              if (link.origin === "DMS" && !link.last_job_id) { await link.update({ content_hash: hash, last_synced_at: new Date(), last_job_id: job.id }, { transaction: t }); return "skipped"; }
              const upd = await target.update(db, entity, values, ctx, t, { externalId: mapped.externalId, link });
              await link.update({ content_hash: hash, ...(upd && upd.linkValue !== undefined ? { dms_value: upd.linkValue } : {}), last_synced_at: new Date(), last_job_id: job.id }, { transaction: t });
              return "updated";
            }
            // Phase 18 ECHO PREVENTION (DMS → ERP → DMS): an ERP id that THIS DMS created through an outbound write is the DMS's own record coming back.
            // It is linked to the DMS row it came from and never created a second time (even if the outbound link write failed after the ERP accepted it).
            if (!link) {
              const sent = await db.ErpOutboundEvent.findOne({ where: { tenant_key: job.tenant_key, connection_id: conn.id, entity_type: target.entityType, external_id: mapped.externalId, status: "SENT", operation: "CREATE" }, transaction: t });
              const own = sent ? await target.find(db, Number(sent.entity_id), ctx, t) : null;
              if (own) {
                await db.ErpExternalLink.create({ ...where, tenant_key: job.tenant_key, dms_entity_id: own.id, content_hash: hash, origin: "DMS", last_synced_at: new Date(), last_job_id: job.id }, { transaction: t });
                return "skipped";
              }
            }
            const created = await target.create(db, values, ctx, t, { externalId: mapped.externalId, link });
            if (created && created.skip) return "skipped"; // the target decided there is nothing to create (e.g. an ERP order that was cancelled before it was ever imported); no link is written
            const lv = created.linkValue !== undefined ? { dms_value: created.linkValue } : {}; // Phase 16: a target may keep a small value on the link (e.g. the last ERP stock snapshot)
            const origin = created.adopted ? "DMS" : "ERP"; // adopted = the target recognised an existing DMS record as this ERP record (no new row was created)
            if (link) await link.update({ dms_entity_id: created.id, content_hash: hash, origin, ...lv, last_synced_at: new Date(), last_job_id: job.id }, { transaction: t });
            else await db.ErpExternalLink.create({ ...where, tenant_key: job.tenant_key, dms_entity_id: created.id, content_hash: hash, origin, ...lv, last_synced_at: new Date(), last_job_id: job.id }, { transaction: t });
            return created.adopted ? "skipped" : "created";
          });
          c[outcome] += 1;
        } catch (e) {
          await recordError(i, externalId !== null ? externalId : (e && e.externalId) || null, normalizeError(e));
        }
        c.processed += 1;
      }
      await flush();
      // Phase 17: cooperative stop between pages. A deactivated ERP, or whatever the caller's `shouldContinue` hook says (the scheduler passes "schedule
      // still enabled"), ends the run cleanly with the records already processed kept (idempotent) instead of running to the end unattended.
      const cur = await db.ErpConnection.findOne({ where: { id: conn.id, tenant_key: job.tenant_key }, attributes: ["status"] });
      if (!cur || cur.status === "INACTIVE") throw new ErpIntegrationError("INVALID_CONFIGURATION", { message: "The synchronisation was stopped because the ERP connection was deactivated." });
      if (deps.shouldContinue) { const d = await deps.shouldContinue(job); if (d && d.stop) throw new ErpIntegrationError("INVALID_CONFIGURATION", { message: String(d.reason || "The synchronisation was stopped.").slice(0, 200) }); }
      if (page.hasMore) {
        if (!page.nextCursor || String(page.nextCursor) === String(cursor)) throw new ErpIntegrationError("INVALID_RESPONSE", { message: "The ERP repeated the same page; the sync was stopped to avoid an endless loop." });
        cursor = page.nextCursor;
      } else cursor = null;
    } while (cursor !== null);
  } catch (e) {
    fatal = normalizeError(e);
    if (fatal.internal) log(`[erp-sync] job=${job.id} detail=${redact(fatal.internal)}`);
    // Phase 15: a run-level failure is also visible in the error monitor (record_index NULL = "whole run"); it does not count as a failed record.
    try { await writeError(null, null, fatal); } catch (_) { /* monitoring must never mask the job result */ }
  }

  const ok = c.created + c.updated + c.skipped;
  let status = "SUCCESS";
  if (fatal) status = ok > 0 ? "PARTIAL" : "FAILED";
  else if (c.failed > 0) status = ok > 0 ? "PARTIAL" : "FAILED";
  await flush({ status, completed_at: new Date(), active_key: null, error_code: fatal ? fatal.code : null, error_message: fatal ? String(fatal.message).slice(0, 255) : null });
  log(`[erp-sync] job=${job.id} cid=${job.correlation_id} ${status} total=${c.total} created=${c.created} updated=${c.updated} skipped=${c.skipped} failed=${c.failed}${fatal ? ` error=${fatal.code}` : ""} ${Date.now() - t0}ms`);
  return plain(job);
}

module.exports = { runSync, LIMITS, fetchWithRetry };
