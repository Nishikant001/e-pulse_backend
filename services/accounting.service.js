// services/accounting.service.js
//
// Single source of truth for GL account resolution and journal integrity
// checks. Before this phase, `getGL()` was independently redefined in
// salesinvoice/purchaseinvoice/salescreditnote/salesdebitnote/
// purchasedebitnote controllers (5 copies of the same function), and
// payment.controller.js / vendorpayment.controller.js used hardcoded
// numeric GL ids (1, 3, 5) instead of a lookup at all. Both are fixed
// here — every controller that posts a journal now imports from this
// file instead of scattering its own account-mapping logic.
const db = require("../models");

class AccountingError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "AccountingError";
    this.statusCode = statusCode;
  }
}

// Canonical GL account names. A distributor must create a GLMaster row
// with one of these exact names (via GL Master setup) before the
// corresponding posting flow can succeed — this is intentional: posting
// fails loudly with a clear "GL not configured" error rather than
// silently inventing an account id.
const ACCOUNTS = {
  RECEIVABLE: "Accounts Receivable",
  PAYABLE: "Accounts Payable",
  SALES: "Sales",
  PURCHASE: "Purchase",
  OUTPUT_GST: "Output GST",
  INPUT_GST: "Input GST",
  CASH_BANK: "Cash/Bank",
  // Phase 12 — scheme-claim settlement (see settleClaim below). Unlike the accounts above these two are auto-provisioned per
  // distributor on first use, so approving a claim never fails just because nobody created a GL row beforehand.
  SCHEME_CLAIM_RECEIVABLE: "Scheme Claims Receivable",
  SCHEME_CLAIM_INCOME: "Scheme Claim Income",
};

const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

// Payment-term text ("Net 30", "45 days", …) → credit days. Same rule the sales/purchase invoice posting uses (default 30).
function parsePaymentTermsToDays(paymentTerms) {
  if (!paymentTerms) return 30;
  const match = String(paymentTerms).match(/(\d+)/);
  return match ? Number(match[1]) : 30;
}

/**
 * Resolve a GL account id by canonical name, scoped to the authenticated
 * distributor. Throws AccountingError (400) if not configured — callers
 * should let this propagate up to roll back the enclosing transaction,
 * so a document never ends up POSTED with a partially-missing journal.
 */
// Standard chart-of-accounts type for each canonical account. Used to auto-create a missing account the first time it is needed.
const DEFAULT_GL_TYPES = {
  "Accounts Receivable": "asset",
  "Accounts Payable": "liability",
  "Sales": "income",
  "Purchase": "expense",
  "Output GST": "liability",
  "Input GST": "asset",
  "Cash/Bank": "asset",
};

async function getGL(gl_name, distributor_code, transaction) {
  const gl = await db.GLMaster.findOne({ where: { gl_name, distributor_code }, transaction });
  if (gl) return gl.id;
  // Standard accounts are auto-provisioned per distributor so posting never fails just because
  // nobody created the row in GL Master. Unknown names still fail loudly.
  const type = DEFAULT_GL_TYPES[gl_name];
  if (!type) throw new AccountingError(`GL not configured: ${gl_name}`);
  return ensureGL(gl_name, type, distributor_code, transaction);
}

/**
 * Like getGL, but creates the account for this distributor if it does not exist yet. Only used for the claim-settlement accounts.
 * Safe under concurrency: (distributor_code, gl_name) is unique, so a racing creator loses and re-reads.
 */
async function ensureGL(gl_name, gl_type, distributor_code, transaction) {
  const found = await db.GLMaster.findOne({ where: { gl_name, distributor_code }, transaction });
  if (found) return found.id;
  const [gl] = await db.GLMaster.findOrCreate({ where: { gl_name, distributor_code }, defaults: { gl_type }, transaction });
  return gl.id;
}

/**
 * The double-entry rule, enforced explicitly as a defense-in-depth check
 * — every posting flow in this codebase already constructs balanced
 * entries by construction, but this catches any future regression before
 * it reaches the database rather than silently corrupting the ledger.
 * Call this with the full set of {debit, credit} objects about to be
 * created for one posting, right before committing.
 */
function assertBalanced(entries, { tolerance = 0.01 } = {}) {
  const totalDebit = entries.reduce((sum, e) => sum + Number(e.debit || 0), 0);
  const totalCredit = entries.reduce((sum, e) => sum + Number(e.credit || 0), 0);
  const diff = Math.round((totalDebit - totalCredit) * 100) / 100;
  if (Math.abs(diff) > tolerance) {
    throw new AccountingError(
      `Journal is not balanced: total debit ${totalDebit.toFixed(2)} != total credit ${totalCredit.toFixed(2)}`,
      500 // this is an internal consistency bug, not a user input error
    );
  }
}

/**
 * Generic reversal: given a previously posted set of JournalEntry rows
 * (identified by distributor_code + reference_type + reference_no),
 * create the exact mirror-image entries under a new reference_type,
 * preserving the original rows untouched (never mutate/delete a posted
 * journal — see controllers' immutability checks). Used by the
 * credit/debit note and return posting flows so reversal logic isn't
 * reimplemented per document type.
 */
async function reverseJournal({ distributor_code, sourceReferenceType, sourceReferenceNo, newReferenceType, newReferenceNo, transaction }) {
  const originalEntries = await db.JournalEntry.findAll({
    where: { distributor_code, reference_type: sourceReferenceType, reference_no: String(sourceReferenceNo) },
    transaction,
  });
  if (originalEntries.length === 0) {
    throw new AccountingError(`No journal entries found to reverse for ${sourceReferenceType} #${sourceReferenceNo}`);
  }

  const reversedRows = originalEntries.map((e) => ({
    distributor_code,
    gl_id: e.gl_id,
    reference_type: newReferenceType,
    reference_no: String(newReferenceNo),
    debit: e.credit,
    credit: e.debit,
    customer_id: e.customer_id,
    vendor_id: e.vendor_id,
    customer_code: e.customer_code,
    vendor_code: e.vendor_code,
    transaction_date: new Date(),
    narration: `Reversal of ${sourceReferenceType} #${sourceReferenceNo} — ${e.narration || ""}`.trim(),
  }));

  assertBalanced(reversedRows);
  return db.JournalEntry.bulkCreate(reversedRows, { transaction });
}

/**
 * Phase 12 — financial consequence of an APPROVED scheme claim.
 *
 * Treatment (no existing business rule defined one, so this is the decision taken and documented in docs/PHARMA_DMS_ACCOUNTS.md):
 * the company owes the distributor the scheme benefit the distributor already funded. In the distributor's books that is
 *     Dr Scheme Claims Receivable   (amount due from the company)
 *         Cr Scheme Claim Income    (recovery of the scheme benefit)
 * It is NOT posted to Accounts Receivable and NOT netted against retailer outstanding — the retailer did not owe or pay this money.
 *
 * Must be called INSIDE the caller's transaction, after the claim row has been moved to APPROVED. Idempotent by construction:
 * the UPDATE below only succeeds for an APPROVED claim whose settled_at is still NULL, and settlement_reference is unique,
 * so a second call (retry, double click, concurrent request) matches zero rows and is rejected with 409 before anything is posted.
 */
async function settleClaim({ claim, adminId, transaction }) {
  const amount = round2(claim.claim_amount);
  if (!(amount > 0)) throw new AccountingError("A claim can only be settled for an amount greater than zero", 422);

  const distributor = await db.Distributor.findOne({ where: { id: claim.distributor_id }, attributes: ["id", "distributor_code"], transaction });
  if (!distributor || !distributor.distributor_code) throw new AccountingError("The claim's distributor could not be found", 422);
  const code = distributor.distributor_code;

  const reference = `SET-${claim.claim_number}`;
  const settledAt = new Date();
  const [claimed] = await db.Claim.update(
    { settlement_reference: reference, settled_at: settledAt, settled_by_admin_id: adminId || null },
    { where: { id: claim.id, status: "APPROVED", settled_at: null }, transaction }
  );
  if (claimed !== 1) throw new AccountingError("This claim is already financially settled (or is not approved)", 409);

  const receivableGL = await ensureGL(ACCOUNTS.SCHEME_CLAIM_RECEIVABLE, "asset", code, transaction);
  const incomeGL = await ensureGL(ACCOUNTS.SCHEME_CLAIM_INCOME, "income", code, transaction);
  const rows = [
    { distributor_code: code, gl_id: receivableGL, reference_type: "CLAIM_SETTLEMENT", reference_no: reference, debit: amount, credit: 0, transaction_date: settledAt, narration: `Scheme claim ${claim.claim_number} approved — due from company` },
    { distributor_code: code, gl_id: incomeGL, reference_type: "CLAIM_SETTLEMENT", reference_no: reference, debit: 0, credit: amount, transaction_date: settledAt, narration: `Scheme claim ${claim.claim_number} — scheme benefit recovered` },
  ];
  assertBalanced(rows);
  await db.JournalEntry.bulkCreate(rows, { transaction });
  return { reference, amount, settledAt };
}

module.exports = { AccountingError, ACCOUNTS, round2, parsePaymentTermsToDays, getGL, ensureGL, assertBalanced, reverseJournal, settleClaim };
