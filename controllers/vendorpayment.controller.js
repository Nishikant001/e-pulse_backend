// controllers/vendorpayment.controller.js
const db = require("../models");
const accounting = require("../services/accounting.service");
const { ACCOUNTS } = accounting;
const JournalEntry = db.JournalEntry;
const Vendor = db.Vendor;

exports.payVendor = async (req, res) => {
  const { vendor_id, amount, reference_no, mode, paymentDate } = req.body;
  const distributorId = req.user.id;
  const distributorCode = req.user.distributor_code;

  if (!vendor_id || !amount || Number(amount) <= 0) {
    return res.status(400).json({ message: "vendor_id and a positive amount are required" });
  }

  const t = await db.sequelize.transaction();
  try {
    // Tenant isolation: vendor must belong to the authenticated distributor
    const vendor = await Vendor.findOne({
      where: { id: vendor_id, distributor_id: distributorId },
      transaction: t,
    });
    if (!vendor) {
      await t.rollback();
      return res.status(404).json({ message: "Vendor not found" });
    }

    const payableGL = await accounting.getGL(ACCOUNTS.PAYABLE, distributorCode, t);
    const cashBankGL = await accounting.getGL(ACCOUNTS.CASH_BANK, distributorCode, t);
    const transaction_date = paymentDate || new Date();

    const entries = [
      {
        distributor_code: distributorCode,
        gl_id: payableGL,
        reference_type: "VENDOR_PAYMENT",
        debit: amount,
        credit: 0,
        vendor_id: vendor.id,
        vendor_code: vendor.vendor_code,
        reference_no,
        transaction_date,
        narration: "Vendor payable cleared",
      },
      {
        distributor_code: distributorCode,
        gl_id: cashBankGL,
        reference_type: "VENDOR_PAYMENT",
        debit: 0,
        credit: amount,
        vendor_id: vendor.id,
        vendor_code: vendor.vendor_code,
        reference_no,
        transaction_date,
        narration: `Payment to vendor (${mode || "unspecified"})`,
      },
    ];

    accounting.assertBalanced(entries);
    for (const entry of entries) {
      await JournalEntry.create(entry, { transaction: t });
    }

    await t.commit();
    res.json({ message: "Vendor payment posted" });
  } catch (e) {
    await t.rollback();
    console.error("Error posting vendor payment:", e.message);
    const status = e instanceof accounting.AccountingError ? e.statusCode : 500;
    res.status(status).json({ message: status < 500 ? e.message : "Error posting vendor payment" });
  }
};
