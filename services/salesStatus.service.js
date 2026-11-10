// services/salesStatus.service.js
//
// ONE place that defines how Sales Order / Sales Invoice / SAP statuses are presented and which actions are allowed.
// The frontend renders whatever `allowedActions` the API returns — it contains no status conditions of its own.
//
// It does not change the existing state machines (salesOrder.controller.js ALLOWED_TRANSITIONS and the invoice rules);
// it mirrors them for presentation/authorisation and the existing controllers remain the final authority.

const ORDER_RAW = ["DRAFT", "CONFIRMED", "PARTIALLY_DELIVERED", "FULLY_DELIVERED", "CANCELLED", "CLOSED"];
const INVOICE_RAW = ["DRAFT", "POSTED", "PARTIALLY_PAID", "PAID", "CANCELLED"];
const SAP_STATUSES = ["PENDING", "SYNCED", "FAILED", "PARTIAL"];

// Presentation statuses for orders (the pharma vocabulary): draft · confirmed · processing · invoiced · cancelled · synced
const ORDER_DISPLAY = ["draft", "confirmed", "processing", "invoiced", "cancelled", "synced"];

// SQL twin of deriveOrderDisplayStatus (used for server-side filtering). Both are verified against each other in tests.
// Expects columns: raw_status, deliveries, uninvoiced_deliveries, sap_raw.
const ORDER_DISPLAY_SQL = `CASE
  WHEN x.raw_status NOT IN ('DRAFT','CANCELLED') AND x.sap_raw = 'SYNCED' THEN 'synced'
  WHEN x.raw_status = 'DRAFT' THEN 'draft'
  WHEN x.raw_status = 'CANCELLED' THEN 'cancelled'
  WHEN x.raw_status = 'CONFIRMED' THEN 'confirmed'
  WHEN x.raw_status = 'CLOSED' THEN 'invoiced'
  WHEN x.raw_status = 'FULLY_DELIVERED' AND x.deliveries > 0 AND x.uninvoiced_deliveries = 0 THEN 'invoiced'
  ELSE 'processing' END`;

function deriveOrderDisplayStatus({ status, deliveries = 0, uninvoicedDeliveries = 0, sapStatus = null }) {
  if (status !== "DRAFT" && status !== "CANCELLED" && sapStatus === "SYNCED") return "synced";
  if (status === "DRAFT") return "draft";
  if (status === "CANCELLED") return "cancelled";
  if (status === "CONFIRMED") return "confirmed";
  if (status === "CLOSED") return "invoiced";
  if (status === "FULLY_DELIVERED" && deliveries > 0 && uninvoicedDeliveries === 0) return "invoiced";
  return "processing";
}

// SAP status only applies to documents that have left DRAFT (and were not cancelled). No row ⇒ PENDING (never sent).
const orderSapApplicable = (rawStatus) => rawStatus !== "DRAFT" && rawStatus !== "CANCELLED";
const invoiceSapApplicable = (rawStatus) => ["POSTED", "PARTIALLY_PAID", "PAID"].includes(rawStatus);
function effectiveSapStatus(applicable, sapRaw) {
  if (!applicable) return null;
  return SAP_STATUSES.includes(sapRaw) ? sapRaw : "PENDING";
}

// ───────── allowed actions (single source of truth for the UI) ─────────
// facts: { status, remainingQty, uninvoicedDeliveries }
function allowedOrderActions({ status, remainingQty = 0, uninvoicedDeliveries = 0 }) {
  const actions = ["view"];
  if (status === "DRAFT") actions.push("edit", "confirm", "cancel");
  if (status === "CONFIRMED") actions.push("cancel");
  if (["CONFIRMED", "PARTIALLY_DELIVERED", "FULLY_DELIVERED"].includes(status) && (remainingQty > 0 || uninvoicedDeliveries > 0)) actions.push("create_invoice");
  return actions;
}

function allowedInvoiceActions({ status }) {
  const actions = ["view", "print", "download"];
  if (status === "DRAFT") actions.push("post", "cancel");
  return actions;
}

// Transition guard used before delegating to the existing controllers (which re-validate).
const ORDER_ACTION_TARGET = { confirm: "CONFIRMED", cancel: "CANCELLED" };
function assertOrderActionAllowed(action, facts) {
  if (!allowedOrderActions(facts).includes(action)) {
    const err = new Error(`The action "${action}" is not allowed for an order with status ${facts.status}.`);
    err.statusCode = 409;
    err.code = "INVALID_TRANSITION";
    throw err;
  }
}
function assertInvoiceActionAllowed(action, facts) {
  if (!allowedInvoiceActions(facts).includes(action)) {
    const err = new Error(`The action "${action}" is not allowed for an invoice with status ${facts.status}.`);
    err.statusCode = 409;
    err.code = "INVALID_TRANSITION";
    throw err;
  }
}

module.exports = {
  ORDER_RAW, INVOICE_RAW, SAP_STATUSES, ORDER_DISPLAY, ORDER_DISPLAY_SQL, ORDER_ACTION_TARGET,
  deriveOrderDisplayStatus, orderSapApplicable, invoiceSapApplicable, effectiveSapStatus,
  allowedOrderActions, allowedInvoiceActions, assertOrderActionAllowed, assertInvoiceActionAllowed,
};
