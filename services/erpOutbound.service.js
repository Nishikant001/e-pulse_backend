// services/erpOutbound.service.js — Phase 16. DMS → ERP foundation. ERP-agnostic: this file builds a PLAIN payload and an idempotency key and calls the
// provider's create / update; URL shapes, CSRF tokens and cookies are the provider's business (SAP: services/erp/sapProvider.js).
//
// Safety rules (each one fails closed):
//   • ownership: the capability must allow outbound (DMS_OWNED or SHARED, direction DMS_TO_ERP or BIDIRECTIONAL)         → BUSINESS_DECISION_REQUIRED
//   • ERP-side idempotency: the capability config must attest `outbound.idempotencySupported` — otherwise                   → OUTBOUND_SYNC_BLOCKED
//     a retry after a timeout could create a second ERP document, so nothing is sent
//   • exactly-once on our side: erp_outbound_events.idempotency_key is UNIQUE; a SENT key is never sent again
//   • no echo: a record that came FROM this ERP is not sent back as a new record
//   • tenant: the connection is loaded by the session's tenant; a foreign connection is a 404 and no ERP call is made
// The field mapping of the capability is reused in REVERSE: the mapping's ERP field (source_field) receives the DMS value of dms_field. The key field
// is the ERP's id; transforms are not applied outbound.
const crypto = require("crypto");
const { ErpApiError } = require("./erp/erpApiError");
const { ErpIntegrationError, normalizeError, redact } = require("./erp/erpErrors");
const { buildProvider } = require("./erp/connectionManager");
const { getDescriptor, resolveProviderKey } = require("./erp/providerRegistry");
const { evaluate } = require("./erpOwnership.service");
const audit = require("./erpAudit.service");
const sync = require("./erpSync.service");
const V = require("../utils/erpValidate");
const reqctx = require("../utils/requestContext");
const { CAPABILITY_VALUES } = require("./erp/erpConstants");

const err = (status, code, message, details) => new ErpApiError(status, code, message, details);
const plain = (r) => (r ? r.get({ plain: true }) : null);
const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

const linkWhere = (conn, entityType, did, extra = {}) => ({ tenant_key: conn.tenant_key, connection_id: conn.id, entity_type: entityType, scope_key: `distributor:${did}`, ...extra });

// ── builders: DMS row → values keyed by DMS field names (the same names inbound mappings use) ──
const BUILDERS = {
  CUSTOMER_MASTER: {
    entityType: "CUSTOMER", operations: ["CREATE", "UPDATE"],
    find: (db, id) => db.Customer.findByPk(id),
    async link(db, conn, row) { return db.ErpExternalLink.findOne({ where: linkWhere(conn, "CUSTOMER", row.distributor_id, { dms_entity_id: row.id }) }); },
    async build(db, conn, row) {
      const f = ["name", "contact_person", "phone_number", "alternatePhone", "email", "taxNumber", "pan", "street1", "street2", "street3", "city", "region", "pincode", "territory", "status"];
      const out = {}; for (const k of f) if (row[k] !== null && row[k] !== undefined && row[k] !== "") out[k] = row[k];
      return out;
    },
    async onCreated(db, conn, row, externalId, hash) { if (externalId) await db.ErpExternalLink.create({ ...linkWhere(conn, "CUSTOMER", row.distributor_id), external_id: externalId, dms_entity_id: row.id, content_hash: hash, origin: "DMS", last_synced_at: new Date() }); },
  },
  PAYMENT: {
    entityType: "PAYMENT", operations: ["CREATE"], // a posted payment is immutable
    find: (db, id) => db.Payment.findByPk(id),
    async link() { return null; },
    async build(db, conn, row) {
      if (String(row.reference_no || "").startsWith(`ERP${conn.id}-`)) throw new ErpIntegrationError("OUTBOUND_SYNC_BLOCKED", { message: "This payment came from this ERP; it is not sent back." });
      // Phase 18 source tracking: a payment that is linked to an ERP record (imported OR already sent) is never sent again as a new payment.
      const known = await db.ErpExternalLink.findOne({ where: linkWhere(conn, "PAYMENT", row.distributor_id, { dms_entity_id: row.id }) });
      if (known && known.origin !== "DMS") throw new ErpIntegrationError("OUTBOUND_SYNC_BLOCKED", { message: "This payment came from the ERP; it is not sent back." }); // a DMS-origin link = already sent by us: the SENT event answers "duplicate"
      const cust = await db.ErpExternalLink.findOne({ where: linkWhere(conn, "CUSTOMER", row.distributor_id, { dms_entity_id: row.customer_id }) });
      if (!cust) throw new ErpIntegrationError("BUSINESS_DECISION_REQUIRED", { message: "The customer of this payment is not linked to this ERP (no ERP customer id). Synchronise or create the customer in the ERP first." });
      const mode = await db.ErpExternalLink.findOne({ where: { tenant_key: conn.tenant_key, connection_id: conn.id, entity_type: "CODE_PAYMENT_MODE", dms_value: row.mode } });
      if (!mode) throw new ErpIntegrationError("BUSINESS_DECISION_REQUIRED", { message: `Payment mode ${row.mode} has no ERP code. Add a Payment mode code mapping; the DMS does not guess it.` });
      return { customer_external_id: cust.external_id, payment_date: day(row.payment_date), amount: Number(row.amount), mode: mode.external_id, reference_no: row.payment_number, remarks: row.remarks || undefined };
    },
    // Phase 18: remember the ERP id of a payment the DMS sent, so the ERP's own copy of it is recognised when it comes back (echo prevention) and the money is never booked twice.
    async onCreated(db, conn, row, externalId) {
      if (!externalId) return;
      try { await db.ErpExternalLink.create({ ...linkWhere(conn, "PAYMENT", row.distributor_id), external_id: externalId, dms_entity_id: row.id, content_hash: null, origin: "DMS", last_synced_at: new Date() }); } catch (e) { if (!(e instanceof db.Sequelize.UniqueConstraintError)) throw e; }
    },
  },
};
const OUTBOUND_CAPABILITIES = Object.keys(BUILDERS);
// Phase 18: why a capability that has NO outbound builder is refused (shown in the API error and the capability overview). Nothing is sent for these.
const OUTBOUND_BLOCKERS = {
  PRODUCT_MASTER: "Products are imported from the ERP; the DMS does not send them back.",
  DISTRIBUTOR_MASTER: "Distributors are imported from the ERP; the DMS does not send them back.",
  PRICING: "Prices are imported from the ERP; the DMS does not send them back.",
  STOCK: "Stock is posted only through the DMS inventory service; sending DMS stock to an ERP needs a decision on who owns the on-hand figure.",
  SALES: "Sending a DMS sales order needs line items in the ERP payload; the outbound mapping is flat (no line syntax) and the ERP order semantics are not decided.",
  INVOICE: "Invoice synchronisation is blocked: the business has not decided who owns invoices or how the ERP books them (BUSINESS_DECISION_REQUIRED).",
  RETURN: "Return synchronisation is blocked: it depends on invoice and delivery synchronisation, which are blocked.",
  DOCUMENT: "Document synchronisation is blocked: no secure, tenant-isolated document store is approved.",
};

function reverseMap(values, mappings) {
  const payload = {}; let keyField = null;
  for (const m of mappings) {
    if (m.is_key || m.dms_field === "external_id") { keyField = m.source_field; continue; }
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,59}$/.test(m.source_field || "")) continue; // flat ERP field names only outbound (no paths / line syntax)
    if (Object.prototype.hasOwnProperty.call(values, m.dms_field) && values[m.dms_field] !== undefined) payload[m.source_field] = values[m.dms_field];
  }
  return { payload, keyField };
}
const present = (e) => e && ({ id: e.id, connectionId: e.connection_id, capability: e.capability, entityType: e.entity_type, entityId: e.entity_id, operation: e.operation, status: e.status, attempt: e.attempt, externalId: e.external_id || null, errorCode: e.error_code || null, errorMessage: e.error_message || null, correlationId: e.correlation_id, sentAt: e.sent_at, createdAt: e.createdAt, updatedAt: e.updatedAt });

async function send(db, tenantKey, adminId, body = {}, deps = {}) {
  const conn = await sync.loadConnection(db, tenantKey, body.connectionId);
  if (!conn) return null; // foreign tenant / unknown id → 404, before anything else, no ERP call
  const capability = String(body.capability || "").toUpperCase();
  const builder = BUILDERS[capability];
  if (!builder) throw err(409, "OUTBOUND_SYNC_BLOCKED", `Sending ${capability || "this capability"} to an ERP is not available. ${OUTBOUND_BLOCKERS[capability] || ""} Supported: ${OUTBOUND_CAPABILITIES.join(", ")}.`.replace(/\s+/g, " "));
  const entityId = Number(body.entityId);
  if (!Number.isInteger(entityId) || entityId <= 0) throw err(400, "VALIDATION_FAILED", "entityId must be a positive integer", { field: "entityId" });
  const blocked = async (code, message, cap) => { // refused before any ERP call: recorded, audited, reported
    audit.record(db, { event: "ERP_OUTBOUND_BLOCKED", adminId, tenantKey, conn, capability, entityType: builder.entityType, entityId, status: "FAILED", metadata: { code, reason: message } });
    throw err(409, code, message);
  };
  if (conn.status === "INACTIVE") return blocked("INVALID_CONFIGURATION", "The ERP connection is inactive. Activate it first.");
  const cap = await db.ErpConnectionCapability.findOne({ where: { connection_id: conn.id, capability } });
  const own = evaluate(cap, capability, "outbound");
  if (!own.ok) return blocked(own.code, own.message);
  if (!cap.endpoint_path) return blocked("INVALID_CONFIGURATION", "No endpoint is configured for this capability.");
  const key = resolveProviderKey(conn); const desc = key ? getDescriptor(key) : null;
  if (!desc || desc.status !== "IMPLEMENTED") return blocked("PROVIDER_NOT_SUPPORTED", desc ? `The ${desc.label} provider is not implemented, so nothing can be sent.` : "No provider is selected for this ERP connection.");
  if (!((cap.config || {}).outbound || {}).idempotencySupported) return blocked("OUTBOUND_SYNC_BLOCKED", "Outbound sync is blocked: this capability has not been confirmed to support ERP-side idempotency keys (capability setting outbound.idempotencySupported). Without it a retry could create a duplicate ERP document.");
  const mappings = (await db.ErpEntityMapping.findAll({ where: { connection_id: conn.id, capability }, order: [["id", "ASC"]] })).map(plain);
  if (!mappings.length || !mappings.some((m) => m.is_key)) return blocked("MAPPING_NOT_CONFIGURED", "No field mapping (with a key field) is configured for this ERP and capability.");

  const row = await builder.find(db, entityId);
  if (!row) throw err(404, "NOT_FOUND", "Record not found");
  const correlationId = deps.correlationId || reqctx.currentCorrelationId() || crypto.randomUUID();
  const link = await builder.link(db, conn, row);
  const operation = link ? "UPDATE" : "CREATE";
  // Phase 18 ECHO PREVENTION (ERP → DMS → ERP): a record the ERP created is not pushed back until the DMS itself changed it after the last ERP sync.
  if (link && link.origin === "ERP" && link.last_synced_at && row.updatedAt && new Date(row.updatedAt).getTime() <= new Date(link.last_synced_at).getTime() + 1000) {
    return { id: null, connectionId: conn.id, capability, entityType: builder.entityType, entityId: String(entityId), operation, status: "SENT", unchanged: true, echoPrevented: true, externalId: link.external_id };
  }
  if (!builder.operations.includes(operation)) return blocked("OUTBOUND_SYNC_BLOCKED", `This record is already in the ERP (id ${link && link.external_id}) and a ${capability} cannot be changed after sending.`);

  let values;
  try { values = await builder.build(db, conn, row); } catch (e) { const n = normalizeError(e); return blocked(n.code, n.message); }
  const { payload } = reverseMap(values, mappings);
  if (!Object.keys(payload).length) return blocked("MAPPING_NOT_CONFIGURED", "None of the mapped fields can be sent to the ERP. Map at least one DMS field.");
  const hash = crypto.createHash("sha256").update(JSON.stringify(Object.keys(payload).sort().map((k) => [k, payload[k]]))).digest("hex").slice(0, 12);
  if (operation === "UPDATE" && link.content_hash === hash) return { id: null, connectionId: conn.id, capability, entityType: builder.entityType, entityId: String(entityId), operation, status: "SENT", unchanged: true, externalId: link.external_id }; // nothing changed since the last send
  const idem = operation === "CREATE" ? `${tenantKey}:${conn.id}:${capability}:${entityId}:create` : `${tenantKey}:${conn.id}:${capability}:${entityId}:update:${hash}`;

  let ev = await db.ErpOutboundEvent.findOne({ where: { idempotency_key: idem } });
  if (ev && ev.status === "SENT") return { ...present(ev), duplicate: true }; // exactly once: this exact write was already delivered
  if (!ev) {
    try { ev = await db.ErpOutboundEvent.create({ tenant_key: tenantKey, connection_id: conn.id, capability, entity_type: builder.entityType, entity_id: String(entityId), operation, idempotency_key: idem, status: "PENDING", attempt: 0, correlation_id: correlationId, requested_by_admin_id: adminId || null }); }
    catch (e) { ev = await db.ErpOutboundEvent.findOne({ where: { idempotency_key: idem } }); if (!ev) throw e; if (ev.status === "SENT") return { ...present(ev), duplicate: true }; }
  }
  await ev.update({ attempt: ev.attempt + 1, status: "PENDING", correlation_id: correlationId, error_code: null, error_message: null });
  audit.record(db, { event: "ERP_OUTBOUND_STARTED", adminId, tenantKey, conn, capability, entityType: builder.entityType, entityId, correlationId, metadata: { operation, attempt: ev.attempt } });

  try {
    const capsPlain = (await db.ErpConnectionCapability.findAll({ where: { connection_id: conn.id } })).map(plain);
    const provider = await buildProvider(plain(conn), { capabilities: capsPlain, fetchImpl: deps.fetchImpl, logger: deps.logger });
    if (!provider.supports[operation === "CREATE" ? "create" : "update"]) throw new ErpIntegrationError("OUTBOUND_SYNC_BLOCKED", { message: "This provider cannot write to the ERP." });
    const args = { endpointPath: cap.endpoint_path, payload, idempotencyKey: idem, config: cap.config || {}, correlationId };
    let res;
    try { res = operation === "CREATE" ? await provider.create(args) : await provider.update({ ...args, externalId: link.external_id }); } catch (e) { throw provider.handleError(e); }
    await ev.update({ status: "SENT", external_id: res.externalId || (link && link.external_id) || null, sent_at: new Date() });
    if (operation === "CREATE") await builder.onCreated(db, plain(conn), row, res.externalId, hash);
    else if (link) await link.update({ content_hash: hash, last_synced_at: new Date() });
    audit.record(db, { event: "ERP_OUTBOUND_COMPLETED", adminId, tenantKey, conn, capability, entityType: builder.entityType, entityId, correlationId, status: "OK", metadata: { operation, httpStatus: res.httpStatus, externalId: ev.external_id } });
  } catch (e) {
    const n = normalizeError(e);
    await ev.update({ status: n.code === "OUTBOUND_SYNC_BLOCKED" ? "BLOCKED" : "FAILED", error_code: n.code, error_message: String(n.message).slice(0, 255) });
    if (n.internal) (deps.logger || console.info)(`[erp-outbound] event=${ev.id} detail=${redact(n.internal)}`);
    audit.record(db, { event: n.code === "OUTBOUND_SYNC_BLOCKED" ? "ERP_OUTBOUND_BLOCKED" : "ERP_OUTBOUND_FAILED", adminId, tenantKey, conn, capability, entityType: builder.entityType, entityId, correlationId, status: "FAILED", metadata: { operation, code: n.code, retryable: n.retryable } });
  }
  return present(await db.ErpOutboundEvent.findByPk(ev.id));
}

async function list(db, tenantKey, q = {}) {
  const where = { tenant_key: tenantKey };
  const status = V.oneOf(q.status, ["PENDING", "SENT", "FAILED", "BLOCKED"], "status"); if (status) where.status = status;
  const capability = V.oneOf(q.capability, CAPABILITY_VALUES, "capability"); if (capability) where.capability = capability;
  const connectionId = V.posInt(q.connectionId, "connectionId"); if (connectionId) where.connection_id = connectionId;
  const { page, pageSize, offset } = V.paging(q, { defaultSize: 25, maxSize: 100 });
  const { rows, count } = await db.ErpOutboundEvent.findAndCountAll({ where, order: [["id", "DESC"]], limit: pageSize, offset });
  return { items: rows.map(present), page, pageSize, total: count, supportedCapabilities: OUTBOUND_CAPABILITIES };
}

module.exports = { send, list, OUTBOUND_CAPABILITIES, OUTBOUND_BLOCKERS, reverseMap, BUILDERS };
