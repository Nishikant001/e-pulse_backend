// services/erp/sync/targets.js — DMS TARGET registry: what each capability writes into, which fields a mapping may set, who owns each field,
// and how a record is created/updated. The engine only calls this interface; it knows nothing about Products, Customers or Payments.
// A capability that is not registered here CANNOT be synchronised (CAPABILITY_NOT_SUPPORTED) — nothing is invented.
//
//   Phase 14: PRODUCT_MASTER  → Product
//   Phase 15: CUSTOMER_MASTER → Customer (= Retailer)         DISTRIBUTOR_MASTER → Distributor
//             PRICING         → PricingMaster                 PAYMENT            → Payment (+ journal) via payments.service
//   NOT registered (see UNSUPPORTED below, each with the reason): STOCK, SALES, INVOICE, RETURN, DOCUMENT.
//
// Target interface (all optional hooks are called with the engine's context `ctx`):
//   capability, entityType, label, fields[], requiredFields[], allowedFields[], scopeFields[], ownership{}
//   ownTransaction   true → the target runs its own DB transaction (existing service owns the boundary); the engine does NOT wrap it.
//   resolveScope(db, scope)            → { scopeKey, ctx, scope }   (validates the admin-chosen scope; never trusts anything else)
//   validate(values, { creating })     → cleaned values (VALIDATION_ERROR / MAPPING_ERROR)
//   find(db, id, ctx, t)               → existing DMS row for a linked id
//   create(db, values, ctx, t, meta)   → new DMS row   (meta = { externalId })
//   update(db, entity, values, ctx, t) → updated DMS row
const { ErpIntegrationError } = require("../erpErrors");
const retailers = require("../../retailers.service");
const distributors = require("../../adminDistributors.service");
const payments = require("../../payments.service");
const codes = require("../../erpCodeMapping.service");
const inventory = require("../../inventory.service");

// Phase 18: every target may also provide  reconcile(db, values, ctx, { entity, link, hash, t }) → { status, erp, dms, difference, detail }  — a READ-ONLY comparison
// of the ERP's values with the DMS row (see services/erpReconciliation.service.js). It never writes. `create` may return { skip:true } (nothing to create, no link)
// or { id, adopted:true } (an existing DMS record was recognised as this ERP record — no new row, linked with origin DMS).
const bad = (m, code = "VALIDATION_ERROR") => new ErpIntegrationError(code, { message: m });
const str = (max) => (v, name) => { const s = String(v).trim(); if (s.length > max) throw bad(`${name} is longer than ${max} characters`); return s; };
const money = (v, name) => { const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > 99999999.99) throw bad(`${name} must be a non-negative amount`); return Math.round(n * 100) / 100; };
const posInt = (v, label, msg) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw bad(msg || `Choose ${label}.`, "INVALID_CONFIGURATION"); return n; };
const activeInactive = (v, name) => { const s = String(v).trim().toLowerCase(); if (!["active", "inactive"].includes(s)) throw bad(`${name} must be active or inactive`); return s; };

// Existing DMS services throw their own error classes (RetailerError, DistributorError, PaymentError, AccountingError) with
// business wording. Those become per-record VALIDATION_ERRORs; anything else stays an unexpected INTERNAL_ERROR.
function fromService(e) {
  if (e instanceof ErpIntegrationError) return e;
  if (e && typeof e.statusCode === "number" && typeof e.name === "string" && /(Retailer|Distributor|Payment|Accounting|Sales|Inventory|InsufficientStock)Error$/.test(e.name)) return bad(String(e.message).slice(0, 300));
  return e;
}
const guarded = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { throw fromService(e); } };

// Several DMS models derive a human code (material_code, customer_code, distributor_code) from "the last row": concurrent creates would collide, so
// creates are serialised in-process (one chain per process; the engine itself is sequential per job).
let createChain = Promise.resolve();
const serialised = (fn) => { const run = createChain.then(fn, fn); createChain = run.catch(() => {}); return run; };

// Strings that are blank are "not provided": an empty ERP value never blanks a DMS field.
const present = (v) => !(v === null || v === undefined || v === "");


// ───────────────────────────────────────── reconciliation helpers (Phase 18, read-only) ─────────────────────────────────────────
const dayOf = (d) => (d === null || d === undefined || d === "" ? null : (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10));
function sameValue(a, b) {
  const blank = (x) => x === null || x === undefined || x === "";
  if (blank(a) && blank(b)) return true;
  if (blank(a) || blank(b)) return false;
  if (typeof a === "number" || typeof b === "number") return Math.abs(Number(a) - Number(b)) < 0.005;
  return String(a).trim() === String(b).trim();
}
/** Flat field-by-field comparison of the ERP's mapped values with a DMS row. opts: { skip:[fields not compared], dates:[date fields], defaults:{field:valueWhenDmsBlank} } */
function flatReconcile(entity, values, link, opts = {}) {
  if (!entity) return { status: "MISSING_IN_DMS", detail: link ? "The linked DMS record no longer exists." : "This ERP record has not been imported into the DMS yet." };
  const skip = new Set(opts.skip || []); const dates = new Set(opts.dates || []);
  const diffs = [];
  for (const [k, v] of Object.entries(values)) {
    if (skip.has(k) || entity[k] === undefined) continue;
    const erp = dates.has(k) ? dayOf(v) : v; const dms = dates.has(k) ? dayOf(entity[k]) : entity[k];
    if (!sameValue(erp, dms !== null && dms !== undefined ? dms : (opts.defaults || {})[k])) diffs.push({ field: k, erp: erp === undefined ? null : erp, dms: dms === undefined ? null : dms });
  }
  if (!diffs.length) return { status: "MATCHED", detail: "All mapped fields agree." };
  return { status: "MISMATCH", differences: diffs.slice(0, 10), detail: `${diffs.length} field(s) differ: ${diffs.slice(0, 5).map((d) => d.field).join(", ")}.` };
}

// ───────────────────────────────────────── PRODUCT_MASTER (Phase 14) ─────────────────────────────────────────
// Only these Product columns can be written by a sync. DMS-managed columns (material_code, distributor_id, hsn_id, tax rates,
// reorder_level, timestamps) are deliberately absent: a mapping to them is rejected.
const PRODUCT_FIELDS = {
  name: { label: "Name", required: true, parse: str(255) },
  description: { label: "Description", parse: str(255) },
  unit: { label: "Unit of measure", parse: str(255) },
  category: { label: "Category", parse: str(255) },
  generic_name: { label: "Generic name", parse: str(150) },
  brand: { label: "Brand", parse: str(150) },
  dosage_form: { label: "Dosage form", parse: str(50) },
  strength: { label: "Strength", parse: str(50) },
  pack_size: { label: "Pack size", parse: str(50) },
  mrp: { label: "MRP", parse: money },
  sale_price: { label: "Sale price", parse: money },
  weight: { label: "Weight", parse: str(255) },
  mfg_by: { label: "Manufactured by", parse: str(255) },
  drug_licence_number: { label: "Drug licence number", parse: str(255) },
  country_of_origin: { label: "Country of origin", parse: str(255) },
  status: { label: "Status (active / inactive)", parse: activeInactive },
  // Phase 16: the ERP's HSN code. Resolved through a "HSN" code mapping (Code mappings); an unmapped code fails the record with BUSINESS_DECISION_REQUIRED.
  // It sets the product's HSN record only — GST rate columns on the product stay DMS-managed (tax.service reads those).
  hsn_code: { label: "ERP HSN code (needs an HSN code mapping)", parse: str(50) },
};
const fieldList = (defs) => Object.entries(defs).map(([name, f]) => ({ name, label: f.label, required: Boolean(f.required) }));

function baseValidate(defs, kind) {
  return (values, { creating }) => {
    const out = {};
    for (const [k, v] of Object.entries(values)) {
      const def = defs[k];
      if (!def) throw bad(`"${k}" is not a writable ${kind} field.`, "MAPPING_ERROR");
      if (!present(v)) continue;
      out[k] = def.parse(v, def.label);
    }
    if (creating) for (const [k, def] of Object.entries(defs)) if (def.required && !present(out[k])) throw bad(`${def.label} is required to create a ${kind}.`);
    return out;
  };
}

const productTarget = {
  capability: "PRODUCT_MASTER",
  entityType: "PRODUCT",
  label: "Product",
  fields: fieldList(PRODUCT_FIELDS),
  requiredFields: ["name"],
  scopeFields: [
    { name: "distributorId", label: "Distributor that receives the products", required: true },
    { name: "hsnId", label: "Default HSN / tax record for NEW products", required: true },
  ],
  allowedFields: Object.keys(PRODUCT_FIELDS),
  ownership: {
    erpOwned: ["name", "description", "unit", "category", "generic_name", "brand", "dosage_form", "strength", "pack_size", "mrp", "sale_price", "weight", "mfg_by", "drug_licence_number", "country_of_origin", "status"],
    dmsOwned: ["material_code", "distributor", "GST rate columns", "reorder level", "HSN — unless the ERP HSN code field is mapped AND its code has an HSN code mapping"],
    rule: "A mapped field is ERP-owned: a changed ERP value overwrites it. Unmapped fields and DMS-managed fields are never touched.",
  },

  async resolveScope(db, scope = {}) {
    const did = Number(scope.distributorId); const hid = Number(scope.hsnId);
    if (!Number.isInteger(did) || did <= 0) throw bad("Choose the distributor that receives the products.", "INVALID_CONFIGURATION");
    if (!Number.isInteger(hid) || hid <= 0) throw bad("Choose the default HSN record for new products.", "INVALID_CONFIGURATION");
    const distributor = await db.Distributor.findByPk(did);
    if (!distributor) throw bad("The selected distributor does not exist.", "INVALID_CONFIGURATION");
    const hsn = await db.HSNGroup.findOne({ where: { id: hid, distributor_id: did } });
    if (!hsn) throw bad("The selected HSN record does not belong to that distributor.", "INVALID_CONFIGURATION");
    return { scopeKey: `distributor:${did}`, ctx: { distributorId: did, hsnId: hid }, scope: { distributorId: did, hsnId: hid } };
  },
  validate: baseValidate(PRODUCT_FIELDS, "product"),
  async reconcile(db, values, ctx, { entity, link }) { return flatReconcile(entity, values, link, { skip: ["hsn_code"] }); },
  async find(db, id, ctx, t) { return db.Product.findOne({ where: { id, distributor_id: ctx.distributorId }, transaction: t }); },
  async create(db, values, ctx, t) {
    const { hsn_code: hsnCode, ...rest } = values;
    const hsnId = hsnCode ? (await codes.require(db, ctx, "HSN", hsnCode, ctx.distributorId, t)).dmsId : ctx.hsnId;
    if (hsnCode && !(await db.HSNGroup.findOne({ where: { id: hsnId, distributor_id: ctx.distributorId }, transaction: t }))) throw bad(`The HSN record mapped to "${hsnCode}" no longer exists for this distributor.`, "BUSINESS_DECISION_REQUIRED");
    return serialised(() => db.Product.create({ ...rest, distributor_id: ctx.distributorId, hsn_id: hsnId }, { transaction: t }));
  },
  async update(db, entity, values, ctx, t) {
    const { hsn_code: hsnCode, ...changes } = values;
    if (hsnCode) {
      const hit = await codes.require(db, ctx, "HSN", hsnCode, ctx.distributorId, t);
      if (!(await db.HSNGroup.findOne({ where: { id: hit.dmsId, distributor_id: ctx.distributorId }, transaction: t }))) throw bad(`The HSN record mapped to "${hsnCode}" no longer exists for this distributor.`, "BUSINESS_DECISION_REQUIRED");
      changes.hsn_id = hit.dmsId;
    }
    if (Object.keys(changes).length) await entity.update(changes, { transaction: t });
    return entity;
  },
};

// ───────────────────────────────────────── CUSTOMER_MASTER (Phase 15) ─────────────────────────────────────────
// A DMS "retailer" IS a Customer row (Phase 9). An ERP customer is NEVER assumed to be a retailer: the admin chooses, per sync, which
// distributor owns the imported customers and which customer group they join — without that choice the sync does not run.
// ERP customers that are really distributors use DISTRIBUTOR_MASTER instead. Field rules are the retailer module's own validators.
const CUSTOMER_FIELDS = {
  name: { label: "Business name", required: true },
  contact_person: { label: "Contact person" }, phone_number: { label: "Phone number" }, alternatePhone: { label: "Alternate phone" }, email: { label: "Email" },
  taxNumber: { label: "GSTIN" }, pan: { label: "PAN" }, street1: { label: "Address line 1" }, street2: { label: "Address line 2" }, street3: { label: "Address line 3" },
  city: { label: "City" }, region: { label: "State" }, pincode: { label: "PIN code" }, territory: { label: "Territory" },
  status: { label: "Status (active / inactive)" },
  customer_group_code: { label: "ERP customer group code (needs a Customer group code mapping; used for NEW customers)" },
};
const NEVER_BLANK_REQUIRED_ON_CREATE = ["name", "street1", "city", "region", "phone_number", "pincode"]; // the retailer module's own create rules

const customerTarget = {
  capability: "CUSTOMER_MASTER",
  entityType: "CUSTOMER",
  label: "Customer / retailer",
  fields: Object.entries(CUSTOMER_FIELDS).map(([name, f]) => ({ name, label: f.label, required: NEVER_BLANK_REQUIRED_ON_CREATE.includes(name) })),
  requiredFields: ["name"],
  scopeFields: [
    { name: "distributorId", label: "Distributor that owns the imported customers (retailers)", required: true },
    { name: "customerGroupId", label: "Customer group for NEW customers", required: true },
  ],
  allowedFields: Object.keys(CUSTOMER_FIELDS),
  ownership: {
    erpOwned: ["name", "contact_person", "phone_number", "alternatePhone", "email", "taxNumber", "pan", "street1", "street2", "street3", "city", "region", "pincode", "territory", "status (active/inactive only)"],
    dmsOwned: ["customer_code", "distributor", "customer group of an existing retailer (a NEW retailer uses the mapped ERP group code, else the sync's default group)", "credit limit", "shipping address", "pending status (admin approval)"],
    rule: "Mapped fields are ERP-owned. A retailer that is PENDING approval in the DMS is never activated/deactivated by a sync. A GSTIN already used by another retailer of the distributor is a per-record error, never a duplicate.",
  },

  async resolveScope(db, scope = {}) {
    const did = posInt(scope.distributorId, "the distributor that owns the customers");
    const gid = posInt(scope.customerGroupId, "the customer group for new customers");
    if (!(await db.Distributor.findByPk(did))) throw bad("The selected distributor does not exist.", "INVALID_CONFIGURATION");
    try { await retailers.assertGroupBelongsTo(db, gid, did); } catch (e) { throw bad("The selected customer group does not belong to that distributor.", "INVALID_CONFIGURATION"); }
    return { scopeKey: `distributor:${did}`, ctx: { distributorId: did, customerGroupId: gid }, scope: { distributorId: did, customerGroupId: gid } };
  },
  validate(values, { creating, ctx }) {
    const body = {}; let status; let groupCode;
    if (creating && ctx) body.customer_group_id = ctx.customerGroupId; // from the validated scope, never from the ERP; the retailer rules require it on create
    for (const [k, v] of Object.entries(values)) {
      if (!CUSTOMER_FIELDS[k]) throw bad(`"${k}" is not a writable customer field.`, "MAPPING_ERROR");
      if (!present(v)) continue;
      if (k === "status") status = activeInactive(v, CUSTOMER_FIELDS.status.label);
      else if (k === "customer_group_code") groupCode = String(v).trim().slice(0, 190);
      else body[k] = String(v).trim();
    }
    if (creating) for (const k of NEVER_BLANK_REQUIRED_ON_CREATE) if (!present(body[k])) throw bad(`${CUSTOMER_FIELDS[k].label} is required to create a retailer (retailer rules).`);
    const { values: clean, errors } = retailers.validateInput(body, { partial: !creating });
    if (Object.keys(errors).length) throw bad(Object.values(errors)[0]);
    delete clean.customer_group_id; // scope-owned: kept out of the values so the content hash only reflects ERP data (create() sets the group)
    return { ...clean, ...(status ? { status } : {}), ...(groupCode ? { customer_group_code: groupCode } : {}) };
  },
  async find(db, id, ctx, t) { return db.Customer.findOne({ where: { id, distributor_id: ctx.distributorId }, transaction: t }); },
  async reconcile(db, values, ctx, { entity, link }) { return flatReconcile(entity, values, link, { skip: ["customer_group_code", ...(entity && entity.status === "pending" ? ["status"] : [])] }); },
  create: guarded(async (db, values, ctx, t) => {
    const { status, customer_group_code: groupCode, ...rest } = values;
    let groupId = ctx.customerGroupId; // the admin's default group, unless the ERP's group code is mapped
    if (groupCode) {
      groupId = (await codes.require(db, ctx, "CUSTOMER_GROUP", groupCode, ctx.distributorId, t)).dmsId;
      try { await retailers.assertGroupBelongsTo(db, groupId, ctx.distributorId); } catch (e) { throw bad(`The customer group mapped to "${groupCode}" no longer exists for this distributor.`, "BUSINESS_DECISION_REQUIRED"); }
    }
    await retailers.assertUnique(db, rest, ctx.distributorId, null, t);
    return serialised(() => db.Customer.create({ ...rest, distributor_id: ctx.distributorId, customer_group_id: groupId, status: status || "active", status_changed_at: new Date() }, { transaction: t }));
  }),
  update: guarded(async (db, entity, values, ctx, t) => {
    const { status, customer_group_code: _group, ...rest } = values; // the group of an existing retailer stays DMS-owned
    await retailers.assertUnique(db, rest, ctx.distributorId, entity.id, t);
    const changes = { ...rest };
    if (status && entity.status !== "pending" && status !== entity.status) Object.assign(changes, { status, status_reason: status === "inactive" ? "Set by ERP synchronisation" : null, status_changed_at: new Date() });
    if (Object.keys(changes).length) await entity.update(changes, { transaction: t });
    return entity;
  }),
};

// ───────────────────────────────────────── DISTRIBUTOR_MASTER (Phase 15) ─────────────────────────────────────────
// Reuses the Phase 8 Distributor table and its validators. Business-controlled fields (credit limit, payment terms, status, login password) are
// NOT writable. New distributors are created PENDING with no password/login — exactly like Admin → Add distributor. E-mail (also the login
// identity) is set at creation only; an existing distributor's e-mail is never rewritten by a sync.
const DISTRIBUTOR_FIELDS = {
  name: { label: "Business name", required: true },
  contact_person: { label: "Contact person" }, email: { label: "Email (set at creation only)" }, phone_number: { label: "Phone number" },
  tax_no: { label: "GSTIN" }, pan: { label: "PAN" }, street1: { label: "Address line 1" }, street2: { label: "Address line 2" }, street3: { label: "Address line 3" }, street4: { label: "Address line 4" },
  city: { label: "City" }, region: { label: "State" }, postal_code: { label: "Postal code" }, country: { label: "Country" }, territory: { label: "Territory" },
};
const DISTRIBUTOR_CREATE_REQUIRED = ["name", "email", "phone_number", "street1", "city", "region", "postal_code"];

const distributorTarget = {
  capability: "DISTRIBUTOR_MASTER",
  entityType: "DISTRIBUTOR",
  label: "Distributor",
  fields: Object.entries(DISTRIBUTOR_FIELDS).map(([name, f]) => ({ name, label: f.label, required: DISTRIBUTOR_CREATE_REQUIRED.includes(name) })),
  requiredFields: ["name"],
  scopeFields: [],
  allowedFields: Object.keys(DISTRIBUTOR_FIELDS),
  ownership: {
    erpOwned: ["name", "contact_person", "phone_number", "tax_no", "pan", "address lines", "city", "region", "postal_code", "country", "territory", "email (creation only)"],
    dmsOwned: ["distributor_code", "credit_limit", "payment_terms", "status", "password / login"],
    rule: "Credit limit, payment terms, status and login are business-controlled and never written by a sync. A distributor that already exists in the DMS is only changed once it has been linked by a sync that created it; a clashing e-mail/GSTIN is a per-record error.",
  },

  async resolveScope() { return { scopeKey: "", ctx: {}, scope: {} }; },
  validate(values, { creating }) {
    const body = {};
    for (const [k, v] of Object.entries(values)) {
      if (!DISTRIBUTOR_FIELDS[k]) throw bad(`"${k}" is not a writable distributor field.`, "MAPPING_ERROR");
      if (present(v)) body[k] = String(v).trim();
    }
    if (creating) for (const k of DISTRIBUTOR_CREATE_REQUIRED) if (!present(body[k])) throw bad(`${DISTRIBUTOR_FIELDS[k].label.replace(/ \(.*\)/, "")} is required to create a distributor (distributor rules).`);
    const { values: clean, errors } = distributors.validateInput(body, { partial: !creating });
    if (Object.keys(errors).length) throw bad(Object.values(errors)[0]);
    return clean;
  },
  async find(db, id, ctx, t) { return db.Distributor.findOne({ where: { id }, transaction: t }); },
  async reconcile(db, values, ctx, { entity, link }) { return flatReconcile(entity, values, link, { skip: ["email"] }); },
  create: guarded(async (db, values, ctx, t) => {
    await distributors.assertUnique(db, values, null, t);
    return serialised(() => db.Distributor.create({ country: "India", ...values, status: "pending", password: null, status_changed_at: new Date() }, { transaction: t }));
  }),
  update: guarded(async (db, entity, values, ctx, t) => {
    const { email, ...changes } = values; // e-mail is the login identity: never rewritten on an existing distributor
    await distributors.assertUnique(db, changes, entity.id, t);
    if (Object.keys(changes).length) await entity.update(changes, { transaction: t });
    return entity;
  }),
};

// ───────────────────────────────────────── PRICING (Phase 15) ─────────────────────────────────────────
// PricingMaster has ONE row per (product, customer group, distributor) — see its unique index; tax (HSN) and schemes are applied AFTER the price is resolved
// (pricing.service → tax.service / schemeEngine), so this target only writes the list price, discount % and validity window.
// OWNERSHIP RULE (the only one that is safe without a business decision): a sync creates a row only when none exists, and afterwards only
// updates rows it created itself (those are linked in erp_external_links). A price that was configured by hand — or by another ERP — is never
// overwritten: that record fails with BUSINESS_DECISION_REQUIRED.
const dateStr = (v, name) => { const s = String(v).trim().slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(new Date(`${s}T00:00:00Z`).getTime())) throw bad(`${name} must be a date`); return s; };
const PRICING_FIELDS = {
  product_external_id: { label: "ERP product id (as synced by PRODUCT_MASTER)", required: true, parse: str(190) },
  base_price: { label: "Base price", required: true, parse: (v, n) => { const x = money(v, n); if (x <= 0) throw bad(`${n} must be greater than zero`); return x; } },
  discount_percent: { label: "Discount %", parse: (v, n) => { const x = Number(v); if (!Number.isFinite(x) || x < 0 || x > 100) throw bad(`${n} must be between 0 and 100`); return Math.round(x * 100) / 100; } },
  valid_from: { label: "Valid from", required: true, parse: dateStr },
  valid_to: { label: "Valid to", parse: dateStr },
};

async function linkedId(db, ctx, entityType, externalId, scopeKey, t) {
  const link = await db.ErpExternalLink.findOne({ where: { connection_id: ctx.connectionId, tenant_key: ctx.tenantKey, entity_type: entityType, external_id: String(externalId), scope_key: scopeKey }, transaction: t });
  return link ? link.dms_entity_id : null;
}

const pricingTarget = {
  capability: "PRICING",
  entityType: "PRICING",
  label: "Price",
  fields: fieldList(PRICING_FIELDS),
  requiredFields: ["product_external_id", "base_price", "valid_from"],
  scopeFields: [
    { name: "distributorId", label: "Distributor the prices belong to", required: true },
    { name: "customerGroupId", label: "Customer group the prices apply to", required: true },
  ],
  allowedFields: Object.keys(PRICING_FIELDS),
  ownership: {
    erpOwned: ["base_price", "discount_percent", "valid_from", "valid_to — but ONLY on price rows that the sync itself created"],
    dmsOwned: ["every price row configured manually or by another ERP", "tax (HSN) rates", "scheme benefits"],
    rule: "A sync never overwrites an existing manual price: it fails that record with BUSINESS_DECISION_REQUIRED until the business defines ownership. Products must already be synchronised (PRODUCT_MASTER) so the ERP product id resolves to a DMS product.",
  },

  async resolveScope(db, scope = {}) {
    const did = posInt(scope.distributorId, "the distributor the prices belong to");
    const gid = posInt(scope.customerGroupId, "the customer group the prices apply to");
    if (!(await db.Distributor.findByPk(did))) throw bad("The selected distributor does not exist.", "INVALID_CONFIGURATION");
    if (!(await db.CustomerGroup.findOne({ where: { id: gid, distributor_id: did } }))) throw bad("The selected customer group does not belong to that distributor.", "INVALID_CONFIGURATION");
    return { scopeKey: `distributor:${did}:group:${gid}`, ctx: { distributorId: did, customerGroupId: gid }, scope: { distributorId: did, customerGroupId: gid } };
  },
  validate(values) {
    const out = baseValidate(PRICING_FIELDS, "price")(values, { creating: true }); // a price row is never partial
    if (out.valid_to && out.valid_to < out.valid_from) throw bad("Valid to cannot be before valid from.");
    return out;
  },
  async find(db, id, ctx, t) { return db.PricingMaster.findOne({ where: { id, distributor_id: ctx.distributorId, customer_group_id: ctx.customerGroupId }, transaction: t }); },
  async reconcile(db, values, ctx, { entity, link }) { return flatReconcile(entity, values, link, { skip: ["product_external_id"], dates: ["valid_from", "valid_to"], defaults: { discount_percent: 0 } }); },
  create: guarded(async (db, values, ctx, t) => {
    const productId = await resolveProduct(db, values, ctx, t);
    await assertNoManualPrice(db, productId, ctx, null, t);
    return db.PricingMaster.create(rowFrom(values, productId, ctx), { transaction: t });
  }),
  update: guarded(async (db, entity, values, ctx, t) => {
    const productId = await resolveProduct(db, values, ctx, t);
    await assertNoManualPrice(db, productId, ctx, entity.id, t);
    await entity.update(rowFrom(values, productId, ctx), { transaction: t });
    return entity;
  }),
};
async function resolveProduct(db, values, ctx, t) {
  const pid = await linkedId(db, ctx, "PRODUCT", values.product_external_id, `distributor:${ctx.distributorId}`, t);
  const product = pid ? await db.Product.findOne({ where: { id: pid, distributor_id: ctx.distributorId }, transaction: t }) : null;
  if (!product) throw bad(`Product "${values.product_external_id}" has not been synchronised for this distributor. Run the Product master sync first.`);
  return product.id;
}
async function assertNoManualPrice(db, productId, ctx, selfId, t) {
  const { Op } = db.Sequelize;
  const clash = await db.PricingMaster.findOne({ where: { productId, customer_group_id: ctx.customerGroupId, distributor_id: ctx.distributorId, ...(selfId ? { id: { [Op.ne]: selfId } } : {}) }, transaction: t });
  if (clash) throw bad("A price for this product and customer group already exists in the DMS and was not created by this ERP. It is not overwritten until the business defines price ownership.", "BUSINESS_DECISION_REQUIRED");
}
const rowFrom = (v, productId, ctx) => ({ productId, customer_group_id: ctx.customerGroupId, distributor_id: ctx.distributorId, base_price: v.base_price, discount_percent: v.discount_percent ?? 0, valid_from: new Date(`${v.valid_from}T00:00:00.000Z`), valid_to: v.valid_to ? new Date(`${v.valid_to}T00:00:00.000Z`) : null });

// ───────────────────────────────────────── PAYMENT (Phase 15) ─────────────────────────────────────────
// Goes through payments.createPayment — the SAME transaction that writes the Payment row, the balanced journal (Dr Cash/Bank, Cr Accounts
// Receivable) and the stored invoice balances. No second accounting engine. Idempotency: the DMS reference number is derived from the ERP
// connection + ERP payment id, and (distributor, reference_no) is UNIQUE — a repeated sync can never record the money twice, even if the
// link row could not be written after the payment committed (the retry recognises the payment and re-links it).
// The payment is booked UNALLOCATED (an advance on the retailer's account): which invoice an ERP clearing belongs to is not something an ERP payload
// states reliably, so no allocation is guessed. Posted payments are immutable: a changed ERP record is reported, not rewritten.
const REF_OK = /^[A-Za-z0-9][A-Za-z0-9._/#-]{0,59}$/;
const PAYMENT_FIELDS = {
  customer_external_id: { label: "ERP customer id (as synced by CUSTOMER_MASTER)", required: true, parse: str(190) },
  payment_date: { label: "Payment date", required: true, parse: dateStr },
  amount: { label: "Amount", required: true, parse: (v, n) => { const x = money(v, n); if (x <= 0) throw bad(`${n} must be greater than zero`); return x; } },
  // Phase 18: the ERP's own mode code is kept as sent (trimmed). create() resolves it: a configured "Payment mode" code mapping first, else an exact DMS mode name,
  // else BUSINESS_DECISION_REQUIRED — an unknown ERP code is never guessed.
  mode: { label: "Payment mode (an ERP code with a Payment mode code mapping, or CASH, BANK_TRANSFER, UPI, CHEQUE, OTHER)", parse: str(40) },
  reference_no: { label: "ERP's own reference (kept in the remarks)", parse: str(120) },
  remarks: { label: "Remarks", parse: str(300) },
};

const paymentTarget = {
  capability: "PAYMENT",
  entityType: "PAYMENT",
  label: "Payment",
  ownTransaction: true,
  fields: fieldList(PAYMENT_FIELDS),
  requiredFields: ["customer_external_id", "payment_date", "amount"],
  scopeFields: [
    { name: "distributorId", label: "Distributor whose books receive the payments", required: true },
    { name: "defaultMode", label: "Payment mode when the ERP record has none (optional)", required: false },
  ],
  allowedFields: Object.keys(PAYMENT_FIELDS),
  ownership: {
    erpOwned: ["every payment this sync records (immutable once posted)"],
    dmsOwned: ["payments entered in the DMS", "invoice allocation", "outstanding / ledger (written only through the Accounts service)"],
    rule: "Only enable ERP → DMS for PAYMENT when the ERP is the book of record for receipts; otherwise the same money would be recorded twice. Payments are booked unallocated; reversal is not supported.",
  },

  async resolveScope(db, scope = {}) {
    const did = posInt(scope.distributorId, "the distributor whose books receive the payments");
    if (!(await db.Distributor.findByPk(did))) throw bad("The selected distributor does not exist.", "INVALID_CONFIGURATION");
    let defaultMode = null;
    if (scope.defaultMode !== undefined && scope.defaultMode !== null && scope.defaultMode !== "") {
      defaultMode = String(scope.defaultMode).toUpperCase();
      if (!db.PAYMENT_MODES.includes(defaultMode)) throw bad(`defaultMode must be one of ${db.PAYMENT_MODES.join(", ")}.`, "INVALID_CONFIGURATION");
    }
    return { scopeKey: `distributor:${did}`, ctx: { distributorId: did, defaultMode }, scope: { distributorId: did, ...(defaultMode ? { defaultMode } : {}) } };
  },
  validate(values) {
    return baseValidate(PAYMENT_FIELDS, "payment")(values, { creating: true });
  },
  async find(db, id, ctx, t) { return db.Payment.findOne({ where: { id, distributor_id: ctx.distributorId } }); },
  // A posted payment is immutable, so any difference is reported as BLOCKED (needs a business decision / reversal process), never rewritten.
  async reconcile(db, values, ctx, { entity, link }) {
    const r = flatReconcile(entity, values, link, { skip: ["customer_external_id", "mode", "reference_no", "remarks"], dates: ["payment_date"] });
    if (r.status === "MISMATCH") return { ...r, status: "BLOCKED", code: "BUSINESS_DECISION_REQUIRED", detail: `The ERP payment differs from the posted DMS payment (${r.detail.replace(/\.$/, "")}). A posted payment is never rewritten; decide how to correct it.` };
    return r;
  },
  create: guarded(async (db, values, ctx, t, meta) => {
    const reference = `ERP${ctx.connectionId}-${meta.externalId}`;
    if (!REF_OK.test(reference)) throw bad("The ERP payment id cannot be used as a DMS reference (letters, digits and . _ / # - only, max 60 characters in total).");
    const customerId = await linkedId(db, ctx, "CUSTOMER", values.customer_external_id, `distributor:${ctx.distributorId}`, undefined);
    const customer = customerId ? await db.Customer.findOne({ where: { id: customerId, distributor_id: ctx.distributorId } }) : null;
    if (!customer) throw bad(`Customer "${values.customer_external_id}" has not been synchronised for this distributor. Run the Customer master sync first.`);
    // Phase 18 ECHO PREVENTION: when the ERP's own reference IS the number of a payment the DMS already holds (the DMS sent it out with its payment number),
    // it is that payment coming back — adopted and linked, never recorded a second time.
    if (values.reference_no) {
      const mine = await db.Payment.findOne({ where: { distributor_id: ctx.distributorId, payment_number: values.reference_no } });
      if (mine) {
        if (Number(mine.customer_id) === Number(customer.id) && Math.abs(Number(mine.amount) - values.amount) < 0.005) return { id: mine.id, adopted: true };
        throw bad(`The ERP reference ${values.reference_no} is the number of a DMS payment with a different customer or amount. Nothing was recorded; the business must decide which is right.`, "BUSINESS_DECISION_REQUIRED");
      }
    }
    // Payment mode: configured ERP code mapping → exact DMS mode name → the sync's default mode → BUSINESS_DECISION_REQUIRED. Never guessed.
    let mode = null;
    if (values.mode) {
      const hit = await codes.resolve(db, ctx, "PAYMENT_MODE", values.mode, null, t);
      if (hit && hit.dmsValue) mode = hit.dmsValue;
      else if (db.PAYMENT_MODES.includes(String(values.mode).toUpperCase())) mode = String(values.mode).toUpperCase();
      else throw bad(`ERP payment mode "${values.mode}" has no DMS mapping. Add it under Code mappings (Payment mode); the DMS does not guess it.`, "BUSINESS_DECISION_REQUIRED");
      if (!db.PAYMENT_MODES.includes(mode)) throw bad(`The payment mode mapped to "${values.mode}" is not a DMS payment mode.`, "BUSINESS_DECISION_REQUIRED");
    } else mode = ctx.defaultMode;
    if (!mode) throw bad("No payment mode: map one, or choose a default mode when starting the sync. The DMS does not guess it.", "BUSINESS_DECISION_REQUIRED");
    const remarks = [values.reference_no ? `ERP ref ${values.reference_no}` : null, values.remarks || null, `Synced from ERP (job ${ctx.jobId})`].filter(Boolean).join(" · ").slice(0, 500);
    try {
      const made = await payments.createPayment(ctx.adminId || null, { customerId: customer.id, distributorId: ctx.distributorId, amount: values.amount, paymentDate: values.payment_date, mode, referenceNo: reference, remarks });
      return { id: made.id };
    } catch (e) {
      if (e && e.code === "DUPLICATE_REFERENCE") { // already recorded (e.g. link write failed last time): re-link only if it is the same money
        const prev = await db.Payment.findOne({ where: { distributor_id: ctx.distributorId, reference_no: reference } });
        if (prev && Number(prev.customer_id) === Number(customer.id) && Math.abs(Number(prev.amount) - values.amount) < 0.005) return { id: prev.id };
        throw bad("A different payment with this reference already exists in the DMS.");
      }
      throw e;
    }
  }),
  update: guarded(async () => { throw bad("A posted payment cannot be changed by a sync (reversal is not supported). The ERP record changed after it was recorded."); }),
};


// ───────────────────────────────────────── STOCK (Phase 16) ─────────────────────────────────────────
// The ledger is the ONLY source of stock and `inventory.postAdjustment` the only writer (no direct StockLedger/Batch quantity writes, no new
// batches → FEFO is untouched). The ERP value is treated as an on-hand SNAPSHOT per (product, plant, batch) and only the CHANGE since the last
// ERP snapshot is posted:  delta = ERP qty − previous ERP qty  (kept on the link row as dms_value).
// → DMS operational movements (sales, returns, transfers) are never overwritten or double-counted: ERP-sourced movements are separate ledger rows
//   (reference_type CORRECTION, reason "ERP-SYNC …"; the FIRST snapshot is booked as OPENING).
// FIRST snapshot safety: it is only booked when the DMS holds NO stock for that batch + warehouse; otherwise the record fails with
//   BUSINESS_DECISION_REQUIRED (the business must reconcile the existing DMS stock first). Ownership of STOCK must be ERP_OWNED or SHARED.
// Needs mappings the sync never guesses: ERP plant → DMS warehouse (code mapping WAREHOUSE) and a batch that already exists in the DMS (found by
// BATCH code mapping "<ERP product id>|<batch no>", else by exact batch number for that product). A missing batch is an error — batches carry
// expiry / MRP that an ERP stock row does not reliably state, so none is invented.
// The mapped KEY field must identify one product + plant + batch row of the ERP.
const STOCK_FIELDS = {
  product_external_id: { label: "ERP product id (as synced by PRODUCT_MASTER)", required: true, parse: str(190) },
  plant_code: { label: "ERP plant / storage location code (needs a Warehouse code mapping)", required: true, parse: str(190) },
  batch_no: { label: "ERP batch number", required: true, parse: str(190) },
  quantity: { label: "ERP on-hand quantity (whole units)", required: true, parse: (v, n) => { const x = Number(v); if (!Number.isInteger(x) || x < 0 || x > 1000000000) throw bad(`${n} must be a whole number, zero or more`); return x; } },
};
const stockTarget = {
  capability: "STOCK",
  entityType: "STOCK",
  label: "Stock snapshot",
  ownTransaction: false,
  fields: fieldList(STOCK_FIELDS),
  requiredFields: ["product_external_id", "plant_code", "batch_no", "quantity"],
  scopeFields: [{ name: "distributorId", label: "Distributor whose stock the ERP snapshot describes", required: true }],
  allowedFields: Object.keys(STOCK_FIELDS),
  ownership: {
    erpOwned: ["the CHANGE in ERP on-hand quantity since the previous sync (posted as ERP-SYNC ledger adjustments)"],
    dmsOwned: ["sales / return / transfer / purchase movements", "batches (never created or edited by a sync)", "FEFO allocation"],
    rule: "Stock ownership must be ERP_OWNED or SHARED. Only the ERP's change is posted, through inventory.postAdjustment. The first snapshot is refused when DMS stock already exists for the batch and warehouse.",
  },

  async resolveScope(db, scope = {}) {
    const did = posInt(scope.distributorId, "the distributor the stock belongs to");
    if (!(await db.Distributor.findByPk(did))) throw bad("The selected distributor does not exist.", "INVALID_CONFIGURATION");
    return { scopeKey: `distributor:${did}`, ctx: { distributorId: did }, scope: { distributorId: did } };
  },
  validate(values) { return baseValidate(STOCK_FIELDS, "stock record")(values, { creating: true }); },
  async find(db, id, ctx, t) { return db.Batch.findOne({ where: { id, distributor_id: ctx.distributorId }, transaction: t }); },
  // READ-ONLY comparison: ERP on-hand vs the DMS ledger quantity of the same batch + warehouse. Nothing is posted, whatever the difference.
  //   MATCHED         the two quantities agree
  //   MISMATCH        linked record: the quantities differ (DMS movements since the last ERP snapshot, or an ERP change not synced yet)
  //   MISSING_IN_DMS  not linked and the DMS holds nothing there: the next sync books the ERP quantity as the OPENING snapshot
  //   PENDING_REVIEW  not linked and the DMS ALREADY holds stock there: the first snapshot is refused until the business decides (BUSINESS_DECISION_REQUIRED)
  //   BLOCKED         the mapping needed to compare is missing (product, batch or plant → warehouse)
  async reconcile(db, values, ctx, { link, t }) {
    const { batch } = await resolveStockBatch(db, values, ctx, t);
    const wh = await codes.require(db, ctx, "WAREHOUSE", values.plant_code, ctx.distributorId, t);
    const warehouse = await db.Warehouse.findOne({ where: { id: wh.dmsId, distributor_id: ctx.distributorId }, transaction: t });
    if (!warehouse) throw bad(`The warehouse mapped to plant "${values.plant_code}" no longer exists for this distributor.`, "BUSINESS_DECISION_REQUIRED");
    const dms = await inventory.getBatchAvailableQty({ batchId: batch.id, distributorId: ctx.distributorId, warehouseId: warehouse.id, transaction: t });
    const erp = values.quantity; const difference = erp - dms;
    const prev = link && link.dms_value !== null && link.dms_value !== undefined ? Number(link.dms_value) : null;
    const base = { erp: { quantity: erp }, dms: { quantity: dms, batch: batch.batch_no, warehouse: warehouse.code }, difference, lastSyncedQuantity: prev };
    if (prev === null) {
      if (dms === 0) return { ...base, status: erp === 0 ? "MATCHED" : "MISSING_IN_DMS", detail: erp === 0 ? "Both systems hold nothing." : `The DMS holds nothing here; the next sync books ${erp} as the OPENING snapshot.` };
      return { ...base, status: "PENDING_REVIEW", code: "BUSINESS_DECISION_REQUIRED", detail: `The DMS already holds ${dms} unit(s) and the ERP reports ${erp}. The first ERP snapshot is not booked on top of existing stock: the business must decide the baseline.` };
    }
    if (difference === 0) return { ...base, status: "MATCHED", detail: "ERP and DMS quantities agree." };
    return { ...base, status: "MISMATCH", detail: `ERP ${erp} vs DMS ${dms} (difference ${difference > 0 ? "+" : ""}${difference}). ${erp !== prev ? "The ERP quantity changed since the last sync." : "DMS stock movements since the last sync explain the difference."}` };
  },
  create: guarded(async (db, values, ctx, t) => applyStock(db, values, ctx, t, null)),
  update: guarded(async (db, entity, values, ctx, t, meta) => applyStock(db, values, ctx, t, { batch: entity, link: meta && meta.link })),
};
async function resolveStockBatch(db, values, ctx, t) {
  const productId = await linkedId(db, ctx, "PRODUCT", values.product_external_id, `distributor:${ctx.distributorId}`, t);
  const product = productId ? await db.Product.findOne({ where: { id: productId, distributor_id: ctx.distributorId }, transaction: t }) : null;
  if (!product) throw bad(`Product "${values.product_external_id}" has not been synchronised for this distributor. Run the Product master sync first.`);
  const mapped = await codes.resolve(db, ctx, "BATCH", `${values.product_external_id}|${values.batch_no}`, ctx.distributorId, t);
  let batch = null;
  if (mapped) batch = await db.Batch.findOne({ where: { id: mapped.dmsId, productId: product.id, distributor_id: ctx.distributorId }, transaction: t });
  else {
    const found = await db.Batch.findAll({ where: { productId: product.id, distributor_id: ctx.distributorId, batch_no: values.batch_no }, limit: 2, transaction: t });
    if (found.length > 1) throw bad(`Batch "${values.batch_no}" matches more than one DMS batch. Add a Batch code mapping for "${values.product_external_id}|${values.batch_no}".`, "BUSINESS_DECISION_REQUIRED");
    batch = found[0] || null;
  }
  if (!batch) throw bad(`Batch "${values.batch_no}" of product "${values.product_external_id}" does not exist in the DMS. Create it (expiry, MRP) or add a Batch code mapping; a sync never creates batches.`);
  return { product, batch };
}
async function applyStock(db, values, ctx, t, existing) {
  const { product, batch } = await resolveStockBatch(db, values, ctx, t);
  if (existing && existing.batch.id !== batch.id) throw bad("The ERP record now resolves to a different DMS batch than the one it was linked to. It was not changed.");
  const wh = await codes.require(db, ctx, "WAREHOUSE", values.plant_code, ctx.distributorId, t);
  const warehouse = await db.Warehouse.findOne({ where: { id: wh.dmsId, distributor_id: ctx.distributorId }, transaction: t });
  if (!warehouse) throw bad(`The warehouse mapped to plant "${values.plant_code}" no longer exists for this distributor.`, "BUSINESS_DECISION_REQUIRED");
  const reason = `ERP-SYNC job ${ctx.jobId} connection ${ctx.connectionId}`.slice(0, 190);
  const onHand = await inventory.getBatchAvailableQty({ batchId: batch.id, distributorId: ctx.distributorId, warehouseId: warehouse.id, transaction: t });
  let delta; let reasonType;
  const prev = existing && existing.link && existing.link.dms_value !== null && existing.link.dms_value !== undefined ? Number(existing.link.dms_value) : null;
  if (prev === null) {
    if (onHand !== 0) throw bad(`The DMS already holds ${onHand} unit(s) of batch ${batch.batch_no} in warehouse ${warehouse.code}. The first ERP snapshot is not booked on top of existing stock: reconcile it first.`, "BUSINESS_DECISION_REQUIRED");
    delta = values.quantity; reasonType = "OPENING";
  } else { delta = values.quantity - prev; reasonType = "CORRECTION"; }
  if (delta !== 0) {
    await inventory.postAdjustment({ distributorId: ctx.distributorId, productId: product.id, batchId: batch.id, quantity: Math.abs(delta), direction: delta > 0 ? "IN" : "OUT", reasonType, reason, warehouseId: warehouse.id, userId: ctx.adminId || null, transaction: t });
  }
  return { id: batch.id, linkValue: String(values.quantity) };
}


// ───────────────────────────────────────── SALES (Phase 16) ─────────────────────────────────────────
// An ERP sales order is imported as a DMS DRAFT order through adminSalesOrder.createOrder — the SAME path as Admin → New order: PricingMaster is the
// only price source (the ERP's prices/totals are never read), schemes, GST and stock availability are validated by that service. The sync NEVER
// confirms, delivers or invoices: credit-limit and approval rules still apply when a person confirms the order, and the normal status lifecycle runs.
// Identity: generic columns SalesOrderHeader.external_source_type ("ERP:<connection id>") + external_source_id, UNIQUE per distributor, plus the
// link row → re-running never creates a second order. The order remarks carry a marker so a crash between "order created" and "order stamped"
// is recognised (and re-stamped) on the next run instead of duplicating the order.
// Update: only while the DMS order is still DRAFT. Once a person confirmed it, the ERP change is reported (BUSINESS_DECISION_REQUIRED), not applied.
// Lines are mapped with the line syntax:  lines.product_external_id  ←  "Items.results[].Material",  lines.quantity ← "Items.results[].Qty".
const salesOrders = require("../../adminSalesOrder.service");
const SALES_FIELDS = {
  customer_external_id: { label: "ERP customer id (as synced by CUSTOMER_MASTER)", required: true, parse: str(190) },
  order_date: { label: "Order date", required: true, parse: dateStr },
  payment_terms: { label: "Payment terms (e.g. CREDIT; else the sync's default)", parse: str(40) },
  remarks: { label: "Remarks", parse: str(300) },
  // Phase 18: the ERP's cancellation flag/status (true / false). A cancelled ERP order is never imported; a DRAFT DMS order is cancelled through the DMS
  // service; an order that was already confirmed is NEVER cancelled by a sync (BUSINESS_DECISION_REQUIRED).
  cancelled: { label: "ERP cancelled flag (true / false)", parse: (v, n) => { const x = String(v).trim().toLowerCase(); if (["true", "1", "y", "yes", "x", "cancelled", "canceled"].includes(x)) return true; if (["false", "0", "n", "no"].includes(x)) return false; throw bad(`${n} must be true or false`); } },
};
const SALES_LINE_FIELDS = { product_external_id: "ERP product id (as synced by PRODUCT_MASTER)", quantity: "Ordered quantity (whole units)" };
const salesTarget = {
  capability: "SALES",
  entityType: "SALES_ORDER",
  label: "Sales order",
  ownTransaction: true,
  fields: [...fieldList(SALES_FIELDS), ...Object.entries(SALES_LINE_FIELDS).map(([k, label]) => ({ name: `lines.${k}`, label: `Line: ${label}`, required: true }))],
  requiredFields: ["customer_external_id", "order_date", "lines.product_external_id", "lines.quantity"],
  scopeFields: [
    { name: "distributorId", label: "Distributor that receives the orders", required: true },
    { name: "defaultPaymentTerms", label: "Payment terms when the ERP order has none (optional)", required: false },
  ],
  allowedFields: [...Object.keys(SALES_FIELDS), ...Object.keys(SALES_LINE_FIELDS).map((k) => `lines.${k}`)],
  ownership: {
    erpOwned: ["customer, date, remarks and line product / quantity of a DRAFT order the sync created"],
    dmsOwned: ["prices, schemes, tax (recomputed by DMS)", "order status (never confirmed / delivered / invoiced by a sync)", "credit-limit and approval checks", "any order after it leaves DRAFT"],
    rule: "SALES ownership must be ERP_OWNED or SHARED. Orders arrive as DRAFT with DMS pricing. A changed ERP order is applied only while the DMS order is still DRAFT.",
  },

  async resolveScope(db, scope = {}) {
    const did = posInt(scope.distributorId, "the distributor that receives the orders");
    if (!(await db.Distributor.findByPk(did))) throw bad("The selected distributor does not exist.", "INVALID_CONFIGURATION");
    const terms = scope.defaultPaymentTerms ? String(scope.defaultPaymentTerms).trim().slice(0, 40) : null;
    return { scopeKey: `distributor:${did}`, ctx: { distributorId: did, defaultPaymentTerms: terms }, scope: { distributorId: did, ...(terms ? { defaultPaymentTerms: terms } : {}) } };
  },
  validate(values) {
    const { lines, ...head } = values;
    const out = baseValidate(SALES_FIELDS, "sales order")(head, { creating: true });
    if (!Array.isArray(lines) || !lines.length) throw bad("The ERP order has no lines (map lines.product_external_id and lines.quantity).");
    if (lines.length > 200) throw bad("The ERP order has more than 200 lines.");
    out.lines = lines.map((l, i) => {
      const pid = present(l.product_external_id) ? String(l.product_external_id).trim().slice(0, 190) : null;
      const q = Number(l.quantity);
      if (!pid) throw bad(`Line ${i + 1}: product is missing.`);
      if (!Number.isInteger(q) || q <= 0 || q > 1000000) throw bad(`Line ${i + 1}: quantity must be a positive whole number.`);
      return { product_external_id: pid, quantity: q };
    });
    return out;
  },
  async find(db, id, ctx, t) { return db.SalesOrderHeader.findOne({ where: { id, distributor_id: ctx.distributorId } }); },
  // READ-ONLY: is the DMS order still what the ERP says? Never changes the order.
  async reconcile(db, values, ctx, { entity, link, hash }) {
    if (!entity) return values.cancelled ? { status: "MATCHED", detail: "Cancelled in the ERP; nothing was imported." } : { status: "MISSING_IN_DMS", detail: link ? "The linked DMS order no longer exists." : "This ERP order has not been imported into the DMS yet." };
    const dmsStatus = entity.status; const dmsInfo = { orderNumber: entity.order_number, status: dmsStatus };
    if (values.cancelled) {
      if (dmsStatus === "CANCELLED") return { status: "MATCHED", dms: dmsInfo, detail: "Cancelled in both systems." };
      if (dmsStatus === "DRAFT") return { status: "MISMATCH", dms: dmsInfo, detail: "The ERP cancelled this order; the next sync cancels the DRAFT in the DMS." };
      return { status: "BLOCKED", code: "BUSINESS_DECISION_REQUIRED", dms: dmsInfo, detail: `The ERP cancelled this order but the DMS order is ${dmsStatus}. A sync never cancels a confirmed order; the business must decide.` };
    }
    if (link && link.content_hash === hash) return dmsStatus === "CANCELLED" ? { status: "MISMATCH", dms: dmsInfo, detail: "The DMS order was cancelled but the ERP order is still open." } : { status: "MATCHED", dms: dmsInfo, detail: "The ERP order is unchanged since the last sync." };
    if (dmsStatus === "DRAFT") return { status: "MISMATCH", dms: dmsInfo, detail: "The ERP order changed since the last sync; the next sync updates the DRAFT." };
    return { status: "BLOCKED", code: "BUSINESS_DECISION_REQUIRED", dms: dmsInfo, detail: `The ERP order changed but the DMS order is ${dmsStatus}. It is not overwritten; the business must decide.` };
  },
  create: guarded(async (db, values, ctx, t, meta) => {
    const source = `ERP:${ctx.connectionId}`;
    const marker = `[ERP ${ctx.connectionId}#${meta.externalId}]`;
    const stamped = await db.SalesOrderHeader.findOne({ where: { distributor_id: ctx.distributorId, external_source_type: source, external_source_id: meta.externalId } });
    if (stamped) return { id: stamped.id };
    const { Op } = db.Sequelize;
    const crashed = await db.SalesOrderHeader.findOne({ where: { distributor_id: ctx.distributorId, external_source_id: null, description: { [Op.like]: `%${marker}%` } } });
    if (crashed) { await crashed.update({ external_source_type: source, external_source_id: meta.externalId }); return { id: crashed.id }; }
    if (values.cancelled) return { skip: true }; // cancelled in the ERP before it was ever imported: nothing to create, no link
    const input = await salesInput(db, values, ctx, marker);
    const made = await salesOrders.createOrder(input);
    await db.SalesOrderHeader.update({ external_source_type: source, external_source_id: meta.externalId }, { where: { id: made.id } });
    return { id: made.id };
  }),
  update: guarded(async (db, entity, values, ctx, t, meta) => {
    if (values.cancelled) { // the ERP cancelled the order
      if (entity.status === "CANCELLED") return entity;
      if (entity.status !== "DRAFT") throw bad(`The ERP cancelled this order but the DMS order ${entity.order_number} is already ${entity.status}. It was not cancelled by the sync.`, "BUSINESS_DECISION_REQUIRED");
      await salesOrders.cancelOrder(entity.id); // the normal DMS cancel (status rules apply)
      return entity;
    }
    if (entity.status !== "DRAFT") throw bad(`The DMS order ${entity.order_number} is already ${entity.status}. The changed ERP order was not applied.`, "BUSINESS_DECISION_REQUIRED");
    // A person edited the DRAFT in the DMS after the last sync: the ERP does not silently overwrite that work.
    const last = meta && meta.link && meta.link.last_synced_at ? new Date(meta.link.last_synced_at).getTime() : null;
    if (last && entity.updatedAt && new Date(entity.updatedAt).getTime() - last > 2000) throw bad(`The DMS order ${entity.order_number} was edited in the DMS after the last ERP sync. The changed ERP order was not applied over those edits.`, "BUSINESS_DECISION_REQUIRED");
    const marker = `[ERP ${ctx.connectionId}#${entity.external_source_id}]`;
    await salesOrders.updateOrder(entity.id, await salesInput(db, values, ctx, marker));
    return entity;
  }),
};
async function salesInput(db, values, ctx, marker) {
  const scopeKey = `distributor:${ctx.distributorId}`;
  const cid = await linkedId(db, ctx, "CUSTOMER", values.customer_external_id, scopeKey, undefined);
  if (!cid) throw bad(`Customer "${values.customer_external_id}" has not been synchronised for this distributor. Run the Customer master sync first.`);
  const paymentTerms = values.payment_terms || ctx.defaultPaymentTerms;
  if (!paymentTerms) throw bad("No payment terms: map them, or choose default payment terms when starting the sync. The DMS does not guess them.", "BUSINESS_DECISION_REQUIRED");
  const lines = [];
  for (const l of values.lines) {
    const pid = await linkedId(db, ctx, "PRODUCT", l.product_external_id, scopeKey, undefined);
    if (!pid) throw bad(`Product "${l.product_external_id}" has not been synchronised for this distributor. Run the Product master sync first.`);
    lines.push({ productId: pid, quantity: l.quantity });
  }
  return { distributorId: ctx.distributorId, customerId: cid, orderDate: values.order_date, paymentTerms, remarks: [values.remarks, marker].filter(Boolean).join(" ").slice(0, 500), lines };
}


// ───────────────────────────────────────── identity + change policy (Phase 18, documentation the UI and API expose) ─────────────────────────────────────────
// identity   = the NATURAL external identity used for duplicate detection (never a name, never a random id)
// change     = what happens when the ERP changes a record that was already synchronised
const META = {
  PRODUCT_MASTER: { identity: "ERP connection + ERP product id + distributor", change: { update: "ALLOWED", protects: "DMS-managed columns (material code, distributor, GST rates, reorder level)", onConflict: "ERP wins for mapped fields only" } },
  CUSTOMER_MASTER: { identity: "ERP connection + ERP customer id + distributor", change: { update: "ALLOWED", protects: "customer code, group of an existing retailer, credit limit, pending approval status", onConflict: "ERP wins for mapped fields; GSTIN clash is a per-record error" } },
  DISTRIBUTOR_MASTER: { identity: "ERP connection + ERP distributor id", change: { update: "ALLOWED", protects: "credit limit, payment terms, status, login (and e-mail after creation)", onConflict: "ERP wins for mapped fields only" } },
  PRICING: { identity: "ERP connection + ERP price key + distributor + customer group", change: { update: "ONLY_SYNC_CREATED_ROWS", protects: "manually configured prices, tax and schemes", onConflict: "BUSINESS_DECISION_REQUIRED" } },
  PAYMENT: { identity: "ERP connection + ERP payment id + distributor (DMS reference ERP<connection>-<id> is UNIQUE per distributor)", change: { update: "BLOCKED", protects: "every posted payment (immutable)", onConflict: "reported, never rewritten" } },
  STOCK: { identity: "ERP connection + ERP row key (one product + plant + batch) + distributor; the last ERP quantity is the snapshot kept on the link", change: { update: "DELTA_ONLY", protects: "sales / return / transfer movements, batches, FEFO", onConflict: "first snapshot over existing DMS stock → BUSINESS_DECISION_REQUIRED" } },
  SALES: { identity: "ERP connection + ERP order id + distributor (also SalesOrderHeader.external_source_type / external_source_id, UNIQUE per distributor)", change: { update: "ONLY_WHILE_DRAFT", protects: "prices, schemes, tax, status, any order that left DRAFT, DMS edits made after the last sync", onConflict: "BUSINESS_DECISION_REQUIRED" } },
};
for (const [k, m] of Object.entries(META)) Object.assign({ PRODUCT_MASTER: productTarget, CUSTOMER_MASTER: customerTarget, DISTRIBUTOR_MASTER: distributorTarget, PRICING: pricingTarget, PAYMENT: paymentTarget, STOCK: stockTarget, SALES: salesTarget }[k], { identity: m.identity, changePolicy: m.change });

// ───────────────────────────────────────── not synchronisable (documented, never faked) ─────────────────────────────────────────
// `code` is what the API reports. BUSINESS_DECISION_REQUIRED = the DMS could do it technically, but the business must first decide ownership/mapping.
const UNSUPPORTED = {
  INVOICE: { code: "BUSINESS_DECISION_REQUIRED", reason: "Blocked — decisions and dependencies missing (Phase 19 audit of the actual code). (1) Invoice ownership / authority is not decided. (2) The DMS invoice flow cannot represent an ERP invoice: salesinvoice.create builds an invoice from ONE existing delivery (UNIQUE), numbers it itself, dates it now and recomputes prices and tax from the order line and the product's HSN, so the ERP's own number, date, prices, taxes and totals cannot be stored; and it has no input for the external invoice id. (3) The delivery that an invoice needs has already moved stock OUT, so creating deliveries for ERP invoices would decrease stock a second time when the ERP also owns stock. (4) The accounting rule is not decided (skip because the ERP books it, or run salesinvoice.post once: AR / Sales / Output GST journals and outstanding). (5) There is no rule for an invoice that already exists in the DMS. Nothing imports; the external-id columns exist only as a foundation." },
  RETURN: { code: "CAPABILITY_NOT_SUPPORTED", reason: "Blocked — depends on INVOICE (blocked). salesreturn.create needs a delivered DMS invoice that is POSTED, an invoice-line id and a batch id per line and caps quantities at what is still returnable; salesreturn.post posts stock IN (inventory.postMovement) and a credit note with its accounting in one transaction. Without an ERP invoice linked to a DMS invoice there is nothing a return can reference, and an orphan return is never created. Also undecided: return ownership, the original-invoice-not-found rule, and stock posting when the ERP also owns stock (the same return would be counted twice)." },
  DOCUMENT: { code: "CAPABILITY_NOT_SUPPORTED", reason: "Not supported: there is no tenant-isolated document store (allow-list, size limit, safe filenames, path-traversal protection, malware-scan hook, external document id, duplicate detection). Fetching files from an ERP without those controls would be unsafe." },
};

const TARGETS = { PRODUCT_MASTER: productTarget, CUSTOMER_MASTER: customerTarget, DISTRIBUTOR_MASTER: distributorTarget, PRICING: pricingTarget, PAYMENT: paymentTarget, STOCK: stockTarget, SALES: salesTarget };
const getTarget = (capability) => (Object.prototype.hasOwnProperty.call(TARGETS, capability) ? TARGETS[capability] : null);
const getUnsupported = (capability) => (Object.prototype.hasOwnProperty.call(UNSUPPORTED, capability) ? UNSUPPORTED[capability] : null);
const describeTargets = () => Object.values(TARGETS).map((t) => ({ capability: t.capability, entityType: t.entityType, label: t.label, fields: t.fields, requiredFields: t.requiredFields, scopeFields: t.scopeFields, ownership: t.ownership, identity: t.identity, changePolicy: t.changePolicy }));
const describeUnsupported = () => Object.entries(UNSUPPORTED).map(([capability, u]) => ({ capability, code: u.code, reason: u.reason }));

module.exports = { getTarget, getUnsupported, describeTargets, describeUnsupported, TARGETS, UNSUPPORTED };
