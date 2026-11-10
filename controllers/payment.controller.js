const db = require("../models");
const accounting = require("../services/accounting.service");
const { ACCOUNTS } = accounting;
const JournalEntry = db.JournalEntry;
const Customer = db.Customer;

exports.receivePayment = async (req, res) => {
  const { customer_id, amount, reference_no, mode, paymentDate } = req.body;
  const distributorId = req.user.id;
  const distributorCode = req.user.distributor_code;

  if (!customer_id || !amount || Number(amount) <= 0) {
    return res.status(400).json({ error: "customer_id and a positive amount are required" });
  }

  const t = await db.sequelize.transaction();
  try {
    const customer = await Customer.findOne({
      where: { id: customer_id, distributor_id: distributorId },
      transaction: t,
    });
    if (!customer) {
      await t.rollback();
      return res.status(404).json({ error: "Customer not found" });
    }

    const cashBankGL = await accounting.getGL(ACCOUNTS.CASH_BANK, distributorCode, t);
    const receivableGL = await accounting.getGL(ACCOUNTS.RECEIVABLE, distributorCode, t);
    const transaction_date = paymentDate || new Date();

    const entries = [
      {
        distributor_code: distributorCode,
        gl_id: cashBankGL,
        reference_type: "CUSTOMER_PAYMENT",
        debit: amount,
        credit: 0,
        reference_no,
        customer_id: customer.id,
        customer_code: customer.customer_code,
        transaction_date,
        narration: `Payment Received (${mode || "unspecified"})`,
      },
      {
        distributor_code: distributorCode,
        gl_id: receivableGL,
        reference_type: "CUSTOMER_PAYMENT",
        debit: 0,
        credit: amount,
        reference_no,
        customer_id: customer.id,
        customer_code: customer.customer_code,
        transaction_date,
        narration: "Customer Balance Reduced",
      },
    ];

    accounting.assertBalanced(entries);
    for (const entry of entries) {
      await JournalEntry.create(entry, { transaction: t });
    }

    await t.commit();
    res.json({ message: "Payment received & ledger updated" });
  } catch (error) {
    await t.rollback();
    console.error("Error receiving payment:", error.message);
    const status = error instanceof accounting.AccountingError ? error.statusCode : 500;
    res.status(status).json({ error: status < 500 ? error.message : "Error receiving payment" });
  }
};
