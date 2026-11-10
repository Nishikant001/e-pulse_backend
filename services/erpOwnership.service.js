// services/erpOwnership.service.js — Phase 16. The DATA-OWNERSHIP gate. Pure (no DB): given a capability row it says whether a sync in a
// direction may run, or which business decision is missing. Nothing here knows about any ERP vendor.
//
//   direction  ERP_TO_DMS | DMS_TO_ERP | BIDIRECTIONAL | DISABLED      who sends data to whom
//   ownership  ERP_OWNED  | DMS_OWNED  | SHARED         | (null)        which system is the book of record
//
// An inbound sync (ERP → DMS) needs ERP_OWNED or SHARED, an outbound one (DMS → ERP) needs DMS_OWNED or SHARED.
// STOCK, SALES, INVOICE, RETURN, DOCUMENT are new in Phase 16 and need an EXPLICIT ownership: unset → BUSINESS_DECISION_REQUIRED.
// PRODUCT / CUSTOMER / DISTRIBUTOR / PRICING / PAYMENT predate ownership: when unset, the direction the admin chose in Phase 14/15 is the
// decision (ERP_TO_DMS ⇒ ERP-owned, DMS_TO_ERP ⇒ DMS-owned) and the result is flagged `implied` so the UI can show it.
const { OWNERSHIPS, OWNERSHIP_REQUIRED } = require("./erp/erpConstants");

const DECISIONS = {
  STOCK: "Decide who owns on-hand stock (ERP, DMS or shared) and map every ERP plant / storage location to a DMS warehouse.",
  SALES: "Decide which system owns sales orders (ERP, DMS or shared). Imported orders are created as DRAFT and then follow the normal DMS order lifecycle.",
  INVOICE: "Decide which system owns invoices. DMS invoices are created from deliveries and post accounting; an ERP invoice cannot be imported until an external invoice id exists on the invoice and the business defines the accounting rule.",
  RETURN: "Decide which system owns returns. A return must reference a delivered invoice and drives stock re-entry and credit notes.",
  DOCUMENT: "Decide which system owns documents and approve a secure, tenant-isolated document store.",
};

/** @returns {{ok:true, ownership:string, implied:boolean} | {ok:false, code:string, message:string}} */
function evaluate(cap, capability, mode /* "inbound" | "outbound" */) {
  if (!cap || !cap.enabled || cap.direction === "DISABLED") return { ok: false, code: "CAPABILITY_NOT_SUPPORTED", message: "This capability is not enabled for this ERP connection." };
  const inbound = mode === "inbound";
  const dirOk = inbound ? ["ERP_TO_DMS", "BIDIRECTIONAL"].includes(cap.direction) : ["DMS_TO_ERP", "BIDIRECTIONAL"].includes(cap.direction);
  if (!dirOk) return { ok: false, code: "CAPABILITY_NOT_SUPPORTED", message: inbound ? "This capability is configured DMS → ERP, so nothing is read from the ERP." : "This capability is configured ERP → DMS, so nothing is sent to the ERP." };
  let ownership = cap.ownership || null;
  let implied = false;
  if (!ownership) {
    if (OWNERSHIP_REQUIRED.includes(capability)) return { ok: false, code: "BUSINESS_DECISION_REQUIRED", message: `Data ownership is not defined for ${capability}. ${DECISIONS[capability] || "Choose who owns this data."}` };
    ownership = cap.direction === "DMS_TO_ERP" ? "DMS_OWNED" : "ERP_OWNED"; implied = true;
  }
  if (!OWNERSHIPS.includes(ownership)) return { ok: false, code: "INVALID_CONFIGURATION", message: "The configured ownership is not recognised." };
  const allowed = inbound ? ["ERP_OWNED", "SHARED"] : ["DMS_OWNED", "SHARED"];
  if (!allowed.includes(ownership)) return { ok: false, code: "BUSINESS_DECISION_REQUIRED", message: `${capability} is ${ownership.replace("_", " ").toLowerCase()}, which conflicts with ${inbound ? "importing from" : "sending to"} the ERP. Change the ownership to ${allowed.join(" or ")}, or the direction, after the business confirms.` };
  return { ok: true, ownership, implied };
}

module.exports = { evaluate, DECISIONS };
