// controllers/accounting.controller.js
//
// Customer/Vendor Ledger, Trial Balance, and Balance Sheet — all derived
// exclusively from posted JournalEntry rows (there is no separate/
// competing "ledger" data source; every posting controller across the
// codebase writes here and only here). Tenant isolation comes from
// req.user.distributor_code (server-derived from the JWT), never from
// anything in the request body/params.
const db = require("../models");
const { Op } = require("sequelize");
const accounting = require("../services/accounting.service");
const JournalEntry = db.JournalEntry;

function dateRangeWhere(req) {
  const { from, to } = req.query;
  if (!from && !to) return {};
  const range = {};
  if (from) range[Op.gte] = new Date(from);
  if (to) range[Op.lte] = new Date(to);
  return { transaction_date: range };
}

// ================================
// 🔵 CUSTOMER LEDGER (Distributor-wise)
// ================================
exports.getCustomerLedger = async (req, res) => {
  try {
    const { customer_code } = req.params;
    const distributor_code = req.user.distributor_code;

    // Only the Accounts Receivable control-account postings represent
    // the customer's actual running balance. Sales/GST journal rows are
    // also tagged with customer_code for traceability/reporting, but
    // including them here would double-count — e.g. an invoice's Sales
    // and GST credit legs would incorrectly reduce the "amount owed"
    // figure alongside the real AR debit.
    const entries = await JournalEntry.findAll({
      where: { customer_code, distributor_code, ...dateRangeWhere(req) },
      include: [{ model: db.GLMaster, as: "gl", where: { gl_name: accounting.ACCOUNTS.RECEIVABLE }, attributes: ["gl_name", "gl_type"] }],
      order: [["transaction_date", "ASC"], ["id", "ASC"]],
    });

    // Opening balance is 0 in this phase — per-customer opening balances
    // are a Financial Year concept, deferred to Phase 20.
    let balance = 0;

    const result = entries.map((e) => {
      balance += Number(e.debit) - Number(e.credit);
      return {
        date: e.transaction_date,
        document: e.reference_type,
        reference: e.reference_no,
        account: e.gl?.gl_name || "Unknown",
        debit: Number(e.debit),
        credit: Number(e.credit),
        narration: e.narration,
        balance: Math.round(balance * 100) / 100,
      };
    });

    res.json({ opening_balance: 0, entries: result, closing_balance: result.length ? result[result.length - 1].balance : 0 });
  } catch (err) {
    console.error("Error fetching customer ledger:", err.message);
    res.status(500).json({ error: "Error fetching customer ledger" });
  }
};

// ================================
// 🔵 VENDOR LEDGER (Distributor-wise)
// ================================
exports.getVendorLedger = async (req, res) => {
  try {
    const { vendor_code } = req.params;
    const distributor_code = req.user.distributor_code;

    // Same principle as the customer ledger — only Accounts Payable
    // postings represent the vendor's actual running balance.
    const entries = await JournalEntry.findAll({
      where: { vendor_code, distributor_code, ...dateRangeWhere(req) },
      include: [{ model: db.GLMaster, as: "gl", where: { gl_name: accounting.ACCOUNTS.PAYABLE }, attributes: ["gl_name", "gl_type"] }],
      order: [["transaction_date", "ASC"], ["id", "ASC"]],
    });

    let balance = 0;

    const result = entries.map((e) => {
      balance += Number(e.credit) - Number(e.debit);
      return {
        date: e.transaction_date,
        document: e.reference_type,
        reference: e.reference_no,
        account: e.gl?.gl_name || "Unknown",
        debit: Number(e.debit),
        credit: Number(e.credit),
        narration: e.narration,
        balance: Math.round(balance * 100) / 100,
      };
    });

    res.json({ opening_balance: 0, entries: result, closing_balance: result.length ? result[result.length - 1].balance : 0 });
  } catch (err) {
    console.error("Error fetching vendor ledger:", err.message);
    res.status(500).json({ error: "Error fetching vendor ledger" });
  }
};

// ================================
// 🔵 TRIAL BALANCE (Distributor-wise)
// ================================
// Aggregates every JournalEntry for the distributor. There is no
// separate DRAFT/CANCELLED journal state to exclude — JournalEntry rows
// are only ever created at the moment a document is POSTED (see every
// controller's post() handler), so every row here already represents a
// posted transaction by construction.
exports.getTrialBalance = async (req, res) => {
  try {
    const distributor_code = req.user.distributor_code;

    const entries = await JournalEntry.findAll({
      where: { distributor_code, ...dateRangeWhere(req) },
      include: [{ model: db.GLMaster, as: "gl", attributes: ["gl_name", "gl_type"] }],
    });

    const summary = {};
    let totalDebit = 0, totalCredit = 0;

    for (const e of entries) {
      const accountName = e.gl ? e.gl.gl_name : "Unknown";
      if (!summary[accountName]) {
        summary[accountName] = { gl_type: e.gl?.gl_type || null, debit: 0, credit: 0 };
      }
      const debit = Number(e.debit);
      const credit = Number(e.credit);
      summary[accountName].debit += debit;
      summary[accountName].credit += credit;
      totalDebit += debit;
      totalCredit += credit;
    }

    res.json({
      accounts: summary,
      total_debit: Math.round(totalDebit * 100) / 100,
      total_credit: Math.round(totalCredit * 100) / 100,
      balanced: Math.abs(totalDebit - totalCredit) < 0.01,
    });
  } catch (err) {
    console.error("Error fetching trial balance:", err.message);
    res.status(500).json({ error: "Error fetching trial balance" });
  }
};

// ================================
// 🔵 BALANCE SHEET (Distributor-wise)
// ================================
// Equity is derived (Assets - Liabilities) rather than tracked via its
// own posted entries — no controller in this codebase posts directly to
// an "equity" GL account yet. This makes the identity
// Assets = Liabilities + Equity true by construction; a real
// independently-tracked equity ledger is Phase 20 (Financial Year/
// opening balances) territory.
exports.getBalanceSheet = async (req, res) => {
  try {
    const distributor_code = req.user.distributor_code;
    const where = { distributor_code, ...dateRangeWhere(req) };

    const assets = await db.JournalEntry.findAll({
      where,
      include: { model: db.GLMaster, as: "gl", where: { gl_type: "asset" }, attributes: [] },
    });
    const liabilities = await db.JournalEntry.findAll({
      where,
      include: { model: db.GLMaster, as: "gl", where: { gl_type: "liability" }, attributes: [] },
    });

    const assetTotal = assets.reduce((t, e) => t + (Number(e.debit) - Number(e.credit)), 0);
    const liabilityTotal = liabilities.reduce((t, e) => t + (Number(e.credit) - Number(e.debit)), 0);
    const equity = Math.round((assetTotal - liabilityTotal) * 100) / 100;

    res.json({
      assets: Math.round(assetTotal * 100) / 100,
      liabilities: Math.round(liabilityTotal * 100) / 100,
      equity,
      // Trivially true given equity is derived this way — kept explicit
      // so the invariant is visible in the API response, not just implied.
      balanced: true,
    });
  } catch (err) {
    console.error("Error fetching balance sheet:", err.message);
    res.status(500).json({ error: "Error fetching balance sheet" });
  }
};
