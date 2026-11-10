const {
  db, resetDb, mockRes,
  seedDistributor, seedProduct, seedBatch, seedCustomer, seedVendor,
  seedSalesOrder, seedGLAccounts,
} = require("./helpers");

const salesDeliveryController = require("../controllers/salesdelivery.controller");
const salesInvoiceController = require("../controllers/salesinvoice.controller");
const paymentController = require("../controllers/payment.controller");
const vendorPaymentController = require("../controllers/vendorpayment.controller");
const glMasterController = require("../controllers/glmaster.controller");
const accountingController = require("../controllers/accounting.controller");
const accounting = require("../services/accounting.service");
const inventory = require("../services/inventory.service");

beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await db.sequelize.close();
});

function reqFor(distributor, body, params = {}, query = {}) {
  return { user: { id: distributor.id, distributor_code: distributor.distributor_code }, body, params, query };
}

// ===================== ACCOUNTING SERVICE ===================== //
describe("accounting.service — GL lookup and balance assertion", () => {
  test("1. getGL auto-creates a missing STANDARD account (right type); an unknown name still throws AccountingError", async () => {
    const distributor = await seedDistributor();
    const id = await accounting.getGL("Sales", distributor.distributor_code);
    const row = await db.GLMaster.findByPk(id);
    expect(row.gl_name).toBe("Sales");
    expect(row.gl_type).toBe("income");
    expect(await accounting.getGL("Sales", distributor.distributor_code)).toBe(id); // second call reuses it
    await expect(
      accounting.getGL("Not A Standard Account", distributor.distributor_code)
    ).rejects.toBeInstanceOf(accounting.AccountingError);
  });

  test("2. getGL resolves the correct id once configured", async () => {
    const distributor = await seedDistributor();
    await seedGLAccounts(distributor);
    const id = await accounting.getGL("Sales", distributor.distributor_code);
    expect(typeof id).toBe("number");
  });

  test("3. assertBalanced rejects an unbalanced set of entries", () => {
    expect(() => accounting.assertBalanced([{ debit: 100, credit: 0 }, { debit: 0, credit: 90 }]))
      .toThrow(accounting.AccountingError);
  });

  test("4. assertBalanced accepts a balanced set", () => {
    expect(() => accounting.assertBalanced([{ debit: 100, credit: 0 }, { debit: 0, credit: 100 }]))
      .not.toThrow();
  });
});

// ===================== GL MASTER ===================== //
describe("GL Master", () => {
  test("5. createGL is tenant-scoped and rejects duplicates for the same distributor", async () => {
    const distributor = await seedDistributor();
    const res1 = mockRes();
    await glMasterController.createGL(reqFor(distributor, { gl_name: "Sales", gl_type: "income" }), res1);
    expect(res1.status).toHaveBeenCalledWith(201);

    const res2 = mockRes();
    await glMasterController.createGL(reqFor(distributor, { gl_name: "Sales", gl_type: "income" }), res2);
    expect(res2.status).toHaveBeenCalledWith(400);
  });

  test("6. two distributors can each have their own 'Sales' GL without colliding", async () => {
    const distributorA = await seedDistributor();
    const distributorB = await seedDistributor();
    await glMasterController.createGL(reqFor(distributorA, { gl_name: "Sales", gl_type: "income" }), mockRes());
    const res = mockRes();
    await glMasterController.createGL(reqFor(distributorB, { gl_name: "Sales", gl_type: "income" }), res);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  test("7. updateGL cannot reassign distributor_code via mass assignment", async () => {
    const distributorA = await seedDistributor();
    const distributorB = await seedDistributor();
    const createRes = mockRes();
    await glMasterController.createGL(reqFor(distributorA, { gl_name: "Sales", gl_type: "income" }), createRes);
    const glId = createRes.jsonBody.gl.id;

    await glMasterController.updateGL(
      reqFor(distributorA, { distributor_code: distributorB.distributor_code, gl_name: "Sales Renamed" }, { id: glId }),
      mockRes()
    );

    const gl = await db.GLMaster.findByPk(glId);
    expect(gl.distributor_code).toBe(distributorA.distributor_code); // unchanged
    expect(gl.gl_name).toBe("Sales Renamed"); // legitimate field still updates
  });

  test("8. distributor A cannot fetch/update/delete distributor B's GL account", async () => {
    const distributorA = await seedDistributor();
    const distributorB = await seedDistributor();
    const createRes = mockRes();
    await glMasterController.createGL(reqFor(distributorB, { gl_name: "Sales", gl_type: "income" }), createRes);
    const glId = createRes.jsonBody.gl.id;

    const updateRes = mockRes();
    await glMasterController.updateGL(reqFor(distributorA, { gl_name: "Hacked" }, { id: glId }), updateRes);
    expect(updateRes.status).toHaveBeenCalledWith(404);

    const deleteRes = mockRes();
    await glMasterController.deleteGL(reqFor(distributorA, {}, { id: glId }), deleteRes);
    expect(deleteRes.status).toHaveBeenCalledWith(404);
  });

  test("9. cannot delete a GL account that already has journal entries", async () => {
    const distributor = await seedDistributor();
    await seedGLAccounts(distributor);
    const gl = await db.GLMaster.findOne({ where: { gl_name: "Sales", distributor_code: distributor.distributor_code } });
    await db.JournalEntry.create({
      distributor_code: distributor.distributor_code, gl_id: gl.id, reference_type: "TEST", reference_no: "1",
      debit: 0, credit: 100, transaction_date: new Date(),
    });

    const res = mockRes();
    await glMasterController.deleteGL(reqFor(distributor, {}, { id: gl.id }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

// ===================== END-TO-END POSTING + LEDGERS ===================== //
async function postedSalesInvoiceWithPayment(distributor) {
  await seedGLAccounts(distributor);
  const product = await seedProduct(distributor.id, { cgst: 6, sgst: 6 });
  const batch = await seedBatch(distributor.id, product.id, { exp_date: new Date("2030-01-01") });
  await inventory.postMovement({
    distributorId: distributor.id, productId: product.id, batchId: batch.id,
    movementType: "IN", quantity: 100, referenceType: "OPENING",
  });
  const so = await seedSalesOrder(distributor, { productId: product.id, quantity: 10, pricePerUnit: 20, status: "CONFIRMED" });
  const delRes = mockRes();
  await salesDeliveryController.create(reqFor(distributor, {
    order_number: so.order_number, deliveryDate: new Date(),
    lines: [{ orderLineId: so.lines[0].id, quantityDelivered: 10, batchId: batch.id }],
  }), delRes);
  const deliveryId = delRes.jsonBody.delivery.id;

  const createRes = mockRes();
  await salesInvoiceController.create(reqFor(distributor, { deliveryId }), createRes);
  const invoice = createRes.jsonBody.invoice;
  await salesInvoiceController.post(reqFor(distributor, {}, { id: invoice.id }), mockRes());

  const customer = await db.Customer.findByPk(invoice.customer_id);
  return { invoice, customer };
}

describe("End-to-end: invoice posting, payment, ledgers, trial balance, balance sheet", () => {
  test("10. sales invoice posting produces a balanced journal (AR Dr / Sales Cr / GST Cr)", async () => {
    const distributor = await seedDistributor();
    const { invoice } = await postedSalesInvoiceWithPayment(distributor);

    const entries = await db.JournalEntry.findAll({ where: { reference_no: invoice.id, reference_type: "SALES_INVOICE" } });
    const debit = entries.reduce((s, e) => s + Number(e.debit), 0);
    const credit = entries.reduce((s, e) => s + Number(e.credit), 0);
    expect(debit).toBe(credit);
    expect(debit).toBe(224); // 200 + 12 + 12
    expect(entries.every((e) => e.transaction_date)).toBe(true); // real date, not left null
  });

  test("11. customer payment reduces receivable with a balanced journal, no hardcoded GL ids required to exist", async () => {
    const distributor = await seedDistributor();
    const { customer } = await postedSalesInvoiceWithPayment(distributor);

    const res = mockRes();
    await paymentController.receivePayment(reqFor(distributor, { customer_id: customer.id, amount: 100, mode: "NEFT" }), res);
    expect(res.status).not.toHaveBeenCalledWith(500);

    const entries = await db.JournalEntry.findAll({ where: { reference_type: "CUSTOMER_PAYMENT", distributor_code: distributor.distributor_code } });
    const debit = entries.reduce((s, e) => s + Number(e.debit), 0);
    const credit = entries.reduce((s, e) => s + Number(e.credit), 0);
    expect(debit).toBe(credit);
    expect(debit).toBe(100);
  });

  test("12. customer payment fails cleanly (no entries) when a GL lookup fails", async () => {
    const distributor = await seedDistributor();
    const customer = await seedCustomer(distributor.id);
    const spy = jest.spyOn(accounting, "getGL").mockRejectedValueOnce(new accounting.AccountingError("GL not configured: Cash/Bank"));

    const res = mockRes();
    await paymentController.receivePayment(reqFor(distributor, { customer_id: customer.id, amount: 50 }), res);
    spy.mockRestore();
    expect(res.status).toHaveBeenCalledWith(400);
    const count = await db.JournalEntry.count();
    expect(count).toBe(0);
  });

  test("12b. customer payment works with no GL set up — the standard accounts are auto-created", async () => {
    const distributor = await seedDistributor(); // no GL accounts
    const customer = await seedCustomer(distributor.id);
    const res = mockRes();
    await paymentController.receivePayment(reqFor(distributor, { customer_id: customer.id, amount: 50 }), res);
    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(await db.GLMaster.count({ where: { distributor_code: distributor.distributor_code, gl_name: ["Cash/Bank", "Accounts Receivable"] } })).toBe(2);
  });

  test("13. vendor payment produces a balanced journal via GL lookup (no hardcoded ids)", async () => {
    const distributor = await seedDistributor();
    await seedGLAccounts(distributor);
    const vendor = await seedVendor(distributor.id);

    const res = mockRes();
    await vendorPaymentController.payVendor(reqFor(distributor, { vendor_id: vendor.id, amount: 75, mode: "Cheque" }), res);
    expect(res.status).not.toHaveBeenCalledWith(500);

    const entries = await db.JournalEntry.findAll({ where: { reference_type: "VENDOR_PAYMENT", distributor_code: distributor.distributor_code } });
    const debit = entries.reduce((s, e) => s + Number(e.debit), 0);
    const credit = entries.reduce((s, e) => s + Number(e.credit), 0);
    expect(debit).toBe(credit);
    expect(debit).toBe(75);
  });

  test("14. customer ledger reflects invoice + payment with a running balance, tenant isolated", async () => {
    const distributorA = await seedDistributor();
    const distributorB = await seedDistributor();
    const { customer } = await postedSalesInvoiceWithPayment(distributorA);
    await paymentController.receivePayment(reqFor(distributorA, { customer_id: customer.id, amount: 100 }), mockRes());

    const res = mockRes();
    await accountingController.getCustomerLedger(reqFor(distributorA, {}, { customer_code: customer.customer_code }), res);
    expect(res.jsonBody.entries.length).toBeGreaterThan(0);
    expect(res.jsonBody.closing_balance).toBe(124); // 224 invoiced - 100 paid

    // Distributor B looking up the same customer_code sees nothing (tenant isolation)
    const resB = mockRes();
    await accountingController.getCustomerLedger(reqFor(distributorB, {}, { customer_code: customer.customer_code }), resB);
    expect(resB.jsonBody.entries.length).toBe(0);
  });

  test("15. trial balance totals are balanced and tenant isolated", async () => {
    const distributorA = await seedDistributor();
    const distributorB = await seedDistributor();
    await postedSalesInvoiceWithPayment(distributorA);

    const resA = mockRes();
    await accountingController.getTrialBalance(reqFor(distributorA, {}), resA);
    expect(resA.jsonBody.balanced).toBe(true);
    expect(resA.jsonBody.total_debit).toBe(resA.jsonBody.total_credit);
    expect(resA.jsonBody.total_debit).toBeGreaterThan(0);

    const resB = mockRes();
    await accountingController.getTrialBalance(reqFor(distributorB, {}), resB);
    expect(resB.jsonBody.total_debit).toBe(0); // distributor B has posted nothing
  });

  test("16. balance sheet satisfies Assets = Liabilities + Equity and is tenant isolated", async () => {
    const distributorA = await seedDistributor();
    const distributorB = await seedDistributor();
    await postedSalesInvoiceWithPayment(distributorA);

    const resA = mockRes();
    await accountingController.getBalanceSheet(reqFor(distributorA, {}), resA);
    const { assets, liabilities, equity } = resA.jsonBody;
    expect(Math.round((assets - (liabilities + equity)) * 100) / 100).toBe(0);

    const resB = mockRes();
    await accountingController.getBalanceSheet(reqFor(distributorB, {}), resB);
    expect(resB.jsonBody.assets).toBe(0);
    expect(resB.jsonBody.liabilities).toBe(0);
  });

  test("17. posting the same invoice twice is rejected, not duplicated", async () => {
    const distributor = await seedDistributor();
    const { invoice } = await postedSalesInvoiceWithPayment(distributor);

    const res = mockRes();
    await salesInvoiceController.post(reqFor(distributor, {}, { id: invoice.id }), res);
    expect(res.status).toHaveBeenCalledWith(400);

    const entries = await db.JournalEntry.findAll({ where: { reference_no: invoice.id, reference_type: "SALES_INVOICE" } });
    // Still exactly the entries from the first (successful) posting — no duplicates
    const debit = entries.reduce((s, e) => s + Number(e.debit), 0);
    expect(debit).toBe(224);
  });
});

// ===================== JOURNAL REVERSAL HELPER ===================== //
describe("accounting.service.reverseJournal", () => {
  test("18. produces a balanced mirror-image set of entries referencing the original", async () => {
    const distributor = await seedDistributor();
    await seedGLAccounts(distributor);
    const salesGL = await accounting.getGL("Sales", distributor.distributor_code);
    const arGL = await accounting.getGL("Accounts Receivable", distributor.distributor_code);

    await db.JournalEntry.create({
      distributor_code: distributor.distributor_code, gl_id: arGL, reference_type: "TEST_DOC", reference_no: "500",
      debit: 100, credit: 0, transaction_date: new Date(), narration: "Original",
    });
    await db.JournalEntry.create({
      distributor_code: distributor.distributor_code, gl_id: salesGL, reference_type: "TEST_DOC", reference_no: "500",
      debit: 0, credit: 100, transaction_date: new Date(), narration: "Original",
    });

    await accounting.reverseJournal({
      distributor_code: distributor.distributor_code,
      sourceReferenceType: "TEST_DOC", sourceReferenceNo: "500",
      newReferenceType: "TEST_DOC_REVERSAL", newReferenceNo: "501",
    });

    const reversed = await db.JournalEntry.findAll({ where: { reference_type: "TEST_DOC_REVERSAL", reference_no: "501" } });
    expect(reversed).toHaveLength(2);
    const debit = reversed.reduce((s, e) => s + Number(e.debit), 0);
    const credit = reversed.reduce((s, e) => s + Number(e.credit), 0);
    expect(debit).toBe(credit);
    expect(debit).toBe(100);

    // Original rows are untouched
    const original = await db.JournalEntry.findAll({ where: { reference_type: "TEST_DOC", reference_no: "500" } });
    expect(original).toHaveLength(2);
  });
});

// ===================== REGRESSION ===================== //
describe("Regression — Phases 1-5 intact", () => {
  test("19. tenant isolation on inventory still holds", async () => {
    const distributorA = await seedDistributor();
    const distributorB = await seedDistributor();
    const product = await seedProduct(distributorA.id);
    const batch = await seedBatch(distributorA.id, product.id);

    await expect(
      inventory.postMovement({
        distributorId: distributorB.id, productId: product.id, batchId: batch.id,
        movementType: "IN", quantity: 5, referenceType: "OPENING",
      })
    ).rejects.toBeInstanceOf(inventory.InventoryValidationError);
  });
});
