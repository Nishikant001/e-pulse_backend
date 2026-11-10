// services/erpDecisionRegister.service.js — Phase 19. The BUSINESS DECISION REGISTER as data: every question the business must answer before a blocked / partial ERP
// capability can be completed. READ-ONLY and vendor-neutral: it never calls an ERP and never writes.
//
// Honesty rules (asserted by tests):
//   • The only thing the system can record is OWNERSHIP and DIRECTION of a capability (erp_connection_capabilities.ownership / .direction). That is reported as
//     CONFIGURED — "an administrator set it" — which is NOT proof of business approval; the register says so.
//   • Every other question has NO persistence mechanism, so it is always REQUIRED. No answer is invented, none is inferred from configuration, none is defaulted.
//   • `interim` states what the code does TODAY while the question is open (always the safe, refusing behaviour). It is a safeguard, not a decision.
//   • `blocks` lists the capabilities that stay blocked / partial until the question is answered.
const mech = { CONFIG: "CONFIG", NONE: "NONE" };
const q = (id, area, question, mechanism, blocks, interim, extra = {}) => ({ id, area, question, mechanism, blocks, interim, ...extra });

const REGISTER = [
  // ── Stock ──
  q("stock.owner", "Stock", "Who owns stock quantities (ERP, DMS or shared)?", mech.CONFIG, ["STOCK"], "Stock sync refuses to run while ownership is unset (BUSINESS_DECISION_REQUIRED).", { capability: "STOCK" }),
  q("stock.openingSnapshot", "Stock", "How should an ERP opening snapshot interact with stock the DMS already holds?", mech.NONE, ["STOCK"], "A first snapshot over existing DMS stock is refused per record (BUSINESS_DECISION_REQUIRED); reconciliation reports it as PENDING_REVIEW. No baseline-acceptance workflow exists."),
  q("stock.batchCreation", "Stock", "May ERP data create batches (expiry, MRP)?", mech.NONE, ["STOCK"], "Never. A sync never creates batches; an unknown batch fails the record."),
  q("stock.warehouseMappingOwner", "Stock", "Who owns and maintains the plant → warehouse (and batch) code mappings?", mech.NONE, ["STOCK"], "Mappings are entered by an administrator under Code mappings; an unmapped plant or ambiguous batch is never guessed (BUSINESS_DECISION_REQUIRED)."),
  // ── Sales ──
  q("sales.owner", "Sales", "Is the ERP or the DMS authoritative for sales orders?", mech.CONFIG, ["SALES"], "Sales sync refuses to run while ownership is unset.", { capability: "SALES" }),
  q("sales.autoConfirm", "Sales", "May an ERP order ever be confirmed automatically?", mech.NONE, ["SALES"], "Never. Imported orders are DRAFT with DMS pricing, schemes and GST; a person confirms them."),
  q("sales.dmsOrderRepresentation", "Sales", "How is a DMS-originated order represented in the ERP (header, lines, prices)?", mech.NONE, ["SALES"], "Outbound sales is not implemented (OUTBOUND_SYNC_BLOCKED)."),
  // ── Invoice ──
  q("invoice.owner", "Invoice", "Who owns invoice creation?", mech.CONFIG, ["INVOICE", "RETURN"], "Invoice sync is not implemented whatever the ownership says.", { capability: "INVOICE" }),
  q("invoice.erpAuthoritative", "Invoice", "Is an ERP invoice authoritative (number, date, prices, taxes, totals)?", mech.NONE, ["INVOICE", "RETURN"], "DMS invoices are computed by the DMS (number, date = now, prices from the order line, tax from the product's HSN). An ERP invoice's own figures cannot be stored on one, so 'authoritative' cannot currently be honoured."),
  q("invoice.deliveryMapping", "Invoice", "How does an ERP invoice map to a DMS delivery (a DMS invoice belongs to exactly one delivery, which has already moved stock OUT)?", mech.NONE, ["INVOICE", "RETURN"], "No rule exists. Creating the delivery would post a second stock decrease if the ERP also owns stock."),
  q("invoice.accountingReceivables", "Invoice", "How are journals and receivables created for an imported invoice (skip because the ERP books them, or run the DMS posting once)?", mech.NONE, ["INVOICE", "RETURN"], "Posting is part of the DMS invoice flow (salesinvoice.post: AR, Sales, Output GST, outstanding). Nothing imports, so nothing posts."),
  q("invoice.existingInvoice", "Invoice", "What happens when the ERP invoice already exists in the DMS (adopt, compare, refuse)?", mech.NONE, ["INVOICE"], "No rule exists. Reconciliation of invoices is not implemented."),
  q("invoice.duplicatePrevention", "Invoice", "Which stable ERP field is the external invoice identity (duplicate prevention)?", mech.NONE, ["INVOICE"], "Columns SalesInvoiceHeaders.external_source_type / external_source_id with a UNIQUE index per distributor exist; nothing writes them, and the invoice create path has no input for them."),
  // ── Return ──
  q("return.owner", "Return", "Who owns returns?", mech.CONFIG, ["RETURN"], "Return sync is not implemented whatever the ownership says.", { capability: "RETURN" }),
  q("return.invoiceDeliveryReference", "Return", "How must a return reference the original invoice, delivery, invoice line and batch?", mech.NONE, ["RETURN"], "A DMS return needs a POSTED invoice, an invoice line id and a batch id per line, and caps the quantity at what is still returnable. Without invoice sync there is nothing to reference."),
  q("return.creditNote", "Return", "How are credit notes created for an imported return?", mech.NONE, ["RETURN"], "The DMS posts a credit note and its accounting inside salesreturn.post, in the same transaction as the stock re-entry."),
  q("return.stockPosting", "Return", "How is returned stock posted (and what if the ERP also owns stock)?", mech.NONE, ["RETURN"], "salesreturn.post posts stock IN through inventory.postMovement. If the ERP is also stock owner the same return would be counted twice."),
  q("return.originalMissing", "Return", "What happens when the original invoice cannot be found?", mech.NONE, ["RETURN"], "Refuse. A return is never created without a POSTED invoice (no orphan returns)."),
  // ── Payment and pricing ──
  q("payment.autoAllocate", "Payment", "Should ERP payments be allocated to invoices automatically?", mech.NONE, ["PAYMENT"], "No. Payments are booked unallocated (an advance on the customer's account); allocation is a person's act."),
  q("pricing.manualOwner", "Pricing", "Who owns manually entered prices?", mech.NONE, ["PRICING"], "The sync never overwrites a price row it did not create (BUSINESS_DECISION_REQUIRED)."),
  // ── Documents ──
  q("document.storageProvider", "Documents", "Which tenant-isolated storage provider is approved?", mech.NONE, ["DOCUMENT"], "None registered. ingest() refuses (BUSINESS_DECISION_REQUIRED); the local uploads folder is never used."),
  q("document.malwareScanner", "Documents", "Which malware scanner is approved?", mech.NONE, ["DOCUMENT"], "None registered. ingest() refuses."),
  q("document.accessRetention", "Documents", "Which access-control and retention rules apply?", mech.NONE, ["DOCUMENT"], "No document record, download route, permission or retention policy exists."),
];

const OWNERSHIP_CAPABILITIES = [...new Set(REGISTER.filter((r) => r.mechanism === mech.CONFIG).map((r) => r.capability))];

// Phase 20: which capability each area belongs to (a question's `blocks` may list more than one; this is the capability the question is ABOUT).
const AREA_CAPABILITY = Object.freeze({ Stock: "STOCK", Sales: "SALES", Invoice: "INVOICE", Return: "RETURN", Payment: "PAYMENT", Pricing: "PRICING", Documents: "DOCUMENT" });
const STATUSES = Object.freeze(["REQUIRED", "CONFIGURED"]); // BUSINESS_APPROVED is deliberately NOT a status: nothing in the system can record or verify an approval.
// Phase 20: the register states, in the data itself, that approval tracking does not exist, so no client has to guess or hard-code it.
const META = Object.freeze({
  statuses: STATUSES,
  approvalTracking: Object.freeze({
    implemented: false,
    reason: "No approval workflow, approver role or approval evidence exists in the system. CONFIGURED means an administrator set an ownership or direction on an ERP connection; it is not business approval and does not by itself enable any capability.",
  }),
});

/**
 * @param {Object<string, object[]>} capRows capability → the tenant's connection-capability rows (plain). Missing / empty ⇒ nothing configured.
 *   A row may carry `connection_id` and `connectionName` (Phase 20); they are only echoed back as id / name — never any other connection field.
 * @returns the register with a status per question: CONFIGURED (ownership set by an administrator — NOT business approval) or REQUIRED.
 *   Phase 20 adds (additively) `capability`, `mechanism`, `scope` and, for ownership questions, `connections[]` (which connection holds which ownership / direction).
 */
function build(capRows = {}) {
  return REGISTER.map((r) => {
    const capability = r.capability || AREA_CAPABILITY[r.area] || null;
    const base = { id: r.id, area: r.area, capability, question: r.question, blocks: r.blocks, interim: r.interim, mechanism: r.mechanism, scope: r.mechanism === mech.CONFIG ? "CONNECTION" : "TENANT", status: "REQUIRED", answer: null, approval: "NOT_RECORDED" };
    if (r.mechanism !== mech.CONFIG) return { ...base, persistence: "No configuration exists for this decision; it stays REQUIRED until the business answers and a mechanism records it." };
    const all = (capRows[r.capability] || []).filter(Boolean);
    const connections = all.map((c) => ({ connectionId: c.connection_id ?? null, connectionName: c.connectionName ?? null, enabled: Boolean(c.enabled), ownership: c.ownership || null, direction: c.direction || null }));
    const rows = all.filter((c) => c.ownership);
    if (!rows.length) return { ...base, connections, persistence: "Ownership is stored per connection and capability (erp_connection_capabilities.ownership); none is set." };
    const answers = [...new Set(rows.map((c) => `${c.ownership} / ${c.direction}`))];
    return { ...base, connections, status: "CONFIGURED", answer: answers, persistence: "An administrator configured this on a connection. The system cannot confirm that the business approved it; it does not by itself unblock anything the code does not implement." };
  });
}

const summary = (register) => register.reduce((o, r) => { o[r.status] = (o[r.status] || 0) + 1; return o; }, { REQUIRED: 0, CONFIGURED: 0 });

module.exports = { REGISTER, OWNERSHIP_CAPABILITIES, META, STATUSES, build, summary };
