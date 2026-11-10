const {
  db, resetDb, mockRes,
  seedDistributor, seedProduct, seedBatch, seedCustomer, seedVendor,
  seedSalesOrder, seedGLAccounts,
} = require("./helpers");

const salesOrderController = require("../controllers/salesOrder.controller");
const salesDeliveryController = require("../controllers/salesdelivery.controller");
const salesInvoiceController = require("../controllers/salesinvoice.controller");
const purchaseOrderController = require("../controllers/purchaseorder.controller");
const purchaseDeliveryController = require("../controllers/purchasedelivery.controller");
const purchaseInvoiceController = require("../controllers/purchaseinvoice.controller");
const salesCreditNoteController = require("../controllers/salescreditnote.controller");
const salesDebitNoteController = require("../controllers/salesdebitnote.controller");
const salesReturnController = require("../controllers/salesreturn.controller");
const purchaseReturnController = require("../controllers/purchasereturn.controller");
const purchaseDebitNoteController = require("../controllers/purchasedebitnote.controller");
const inventory = require("../services/inventory.service");

beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await db.sequelize.close();
});

function reqFor(distributor, body, params = {}) {
  return { user: { id: distributor.id, distributor_code: distributor.distributor_code }, body, params };
}

// ---------- Composite setup helpers (build a POSTED invoice end to end) ----------
async function postedSalesInvoice(distributor, { qty = 20, rate = 15 } = {}) {
  await seedGLAccounts(distributor);
  const product = await seedProduct(distributor.id, { cgst: 6, sgst: 6 });
  const batch = await seedBatch(distributor.id, product.id, { exp_date: new Date("2030-01-01") });
  await inventory.postMovement({
    distributorId: distributor.id, productId: product.id, batchId: batch.id,
    movementType: "IN", quantity: qty + 50, referenceType: "OPENING",
  });
  const so = await seedSalesOrder(distributor, { productId: product.id, quantity: qty, pricePerUnit: rate, status: "CONFIRMED" });
  const delRes = mockRes();
  await salesDeliveryController.create(reqFor(distributor, {
    order_number: so.order_number, deliveryDate: new Date(),
    lines: [{ orderLineId: so.lines[0].id, quantityDelivered: qty, batchId: batch.id }],
  }), delRes);
  const deliveryId = delRes.jsonBody.delivery.id;

  const createRes = mockRes();
  await salesInvoiceController.create(reqFor(distributor, { deliveryId }), createRes);
  const invoice = createRes.jsonBody.invoice;
  await salesInvoiceController.post(reqFor(distributor, {}, { id: invoice.id }), mockRes());

  const full = await db.SalesInvoiceHeader.findByPk(invoice.id, { include: [{ model: db.SalesInvoiceLine, as: "lines" }] });
  return { invoice: full, product, batch, customer: await db.Customer.findByPk(full.customer_id) };
}

async function postedPurchaseInvoice(distributor, { qty = 20, rate = 10 } = {}) {
  await seedGLAccounts(distributor);
  const product = await seedProduct(distributor.id);
  const batch = await seedBatch(distributor.id, product.id);
  const vendor = await seedVendor(distributor.id);

  const poRes = mockRes();
  await purchaseOrderController.create(reqFor(distributor, {
    orderDate: new Date(), vendorId: vendor.id,
    lines: [{ productId: product.id, quantity: qty, pricePerUnit: rate }],
  }), poRes);
  const po = await db.PurchaseOrderHeader.findByPk(poRes.jsonBody.header.id, { include: [{ model: db.PurchaseOrderLine, as: "lines" }] });
  await purchaseOrderController.confirm(reqFor(distributor, {}, { id: po.id }), mockRes());

  const delRes = mockRes();
  await purchaseDeliveryController.create(reqFor(distributor, {
    order_number: po.order_number, deliveryDate: new Date(),
    lines: [{ orderLineId: po.lines[0].id, quantityReceived: qty, batchId: batch.id }],
  }), delRes);
  const deliveryId = delRes.jsonBody.delivery.id;

  const createRes = mockRes();
  await purchaseInvoiceController.create(reqFor(distributor, { deliveryId }), createRes);
  const invoice = createRes.jsonBody.invoice;
  await purchaseInvoiceController.post(reqFor(distributor, {}, { id: invoice.id }), mockRes());

  const full = await db.PurchaseInvoiceHeader.findByPk(invoice.id, { include: [{ model: db.PurchaseInvoiceLine, as: "lines" }] });
  return { invoice: full, product, batch, vendor };
}

// ===================== SALES CREDIT NOTE ===================== //
describe("Sales Credit Note", () => {
  test("1. creates a standalone DRAFT credit note against a POSTED invoice", async () => {
    const distributor = await seedDistributor();
    const { invoice } = await postedSalesInvoice(distributor, { qty: 20, rate: 15 });

    const res = mockRes();
    await salesCreditNoteController.create(reqFor(distributor, {
      invoiceId: invoice.id,
      lines: [{ invoiceLineId: invoice.lines[0].id, quantity: 5 }],
      reason: "Damaged goods",
    }), res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.jsonBody.creditNote.status).toBe("DRAFT");
    expect(Number(res.jsonBody.creditNote.netValue)).toBe(75); // 5 * 15
  });

  test("2. rejects crediting more than the remaining creditable quantity", async () => {
    const distributor = await seedDistributor();
    const { invoice } = await postedSalesInvoice(distributor, { qty: 20 });

    await salesCreditNoteController.create(reqFor(distributor, {
      invoiceId: invoice.id, lines: [{ invoiceLineId: invoice.lines[0].id, quantity: 15 }],
    }), mockRes());

    const res = mockRes();
    await salesCreditNoteController.create(reqFor(distributor, {
      invoiceId: invoice.id, lines: [{ invoiceLineId: invoice.lines[0].id, quantity: 10 }], // only 5 remain
    }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.jsonBody.error).toMatch(/remaining creditable quantity/);
  });

  test("3. posting creates balanced GL entries and reduces receivable", async () => {
    const distributor = await seedDistributor();
    await seedGLAccounts(distributor);
    const { invoice } = await postedSalesInvoice(distributor, { qty: 20, rate: 15 });

    const createRes = mockRes();
    await salesCreditNoteController.create(reqFor(distributor, {
      invoiceId: invoice.id, lines: [{ invoiceLineId: invoice.lines[0].id, quantity: 10 }],
    }), createRes);
    const noteId = createRes.jsonBody.creditNote.id;

    const postRes = mockRes();
    await salesCreditNoteController.post(reqFor(distributor, {}, { id: noteId }), postRes);
    expect(postRes.jsonBody.creditNote.status).toBe("POSTED");

    const entries = await db.JournalEntry.findAll({ where: { reference_no: noteId, reference_type: "SALES_CREDIT_NOTE" } });
    const debit = entries.reduce((s, e) => s + Number(e.debit || 0), 0);
    const credit = entries.reduce((s, e) => s + Number(e.credit || 0), 0);
    expect(debit).toBe(credit);
    expect(debit).toBe(Number(postRes.jsonBody.creditNote.totalAmount));
  });

  test("4. cross-tenant credit note creation rejected", async () => {
    const distributorA = await seedDistributor();
    const distributorB = await seedDistributor();
    const { invoice } = await postedSalesInvoice(distributorA);

    const res = mockRes();
    await salesCreditNoteController.create(reqFor(distributorB, {
      invoiceId: invoice.id, lines: [{ invoiceLineId: invoice.lines[0].id, quantity: 1 }],
    }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test("5. posted credit note cannot be edited or deleted", async () => {
    const distributor = await seedDistributor();
    await seedGLAccounts(distributor);
    const { invoice } = await postedSalesInvoice(distributor);

    const createRes = mockRes();
    await salesCreditNoteController.create(reqFor(distributor, {
      invoiceId: invoice.id, lines: [{ invoiceLineId: invoice.lines[0].id, quantity: 2 }],
    }), createRes);
    const noteId = createRes.jsonBody.creditNote.id;
    await salesCreditNoteController.post(reqFor(distributor, {}, { id: noteId }), mockRes());

    const updateRes = mockRes();
    await salesCreditNoteController.update(reqFor(distributor, { reason: "changed" }, { id: noteId }), updateRes);
    expect(updateRes.status).toHaveBeenCalledWith(400);

    const deleteRes = mockRes();
    await salesCreditNoteController.delete(reqFor(distributor, {}, { id: noteId }), deleteRes);
    expect(deleteRes.status).toHaveBeenCalledWith(400);
  });
});

// ===================== SALES DEBIT NOTE ===================== //
describe("Sales Debit Note", () => {
  test("6. creates and posts with balanced GL entries", async () => {
    const distributor = await seedDistributor();
    await seedGLAccounts(distributor);
    const { invoice } = await postedSalesInvoice(distributor);

    const createRes = mockRes();
    await salesDebitNoteController.create(reqFor(distributor, {
      invoiceId: invoice.id, taxableValue: 100, cgstAmount: 6, sgstAmount: 6, reason: "Additional charge",
    }), createRes);
    expect(createRes.status).toHaveBeenCalledWith(201);
    const noteId = createRes.jsonBody.debitNote.id;

    const postRes = mockRes();
    await salesDebitNoteController.post(reqFor(distributor, {}, { id: noteId }), postRes);
    expect(postRes.jsonBody.debitNote.status).toBe("POSTED");

    const entries = await db.JournalEntry.findAll({ where: { reference_no: noteId, reference_type: "SALES_DEBIT_NOTE" } });
    const debit = entries.reduce((s, e) => s + Number(e.debit || 0), 0);
    const credit = entries.reduce((s, e) => s + Number(e.credit || 0), 0);
    expect(debit).toBe(credit);
    expect(debit).toBe(112);
  });

  test("7. rejects negative taxableValue", async () => {
    const distributor = await seedDistributor();
    const { invoice } = await postedSalesInvoice(distributor);
    const res = mockRes();
    await salesDebitNoteController.create(reqFor(distributor, {
      invoiceId: invoice.id, taxableValue: -5,
    }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

// ===================== SALES RETURN ===================== //
describe("Sales Return", () => {
  test("8. full lifecycle: create, post -> StockLedger IN + linked posted credit note", async () => {
    const distributor = await seedDistributor();
    await seedGLAccounts(distributor);
    const { invoice, batch } = await postedSalesInvoice(distributor, { qty: 20, rate: 15 });

    const beforeAvailable = await inventory.getBatchAvailableQty({ batchId: batch.id, distributorId: distributor.id });

    const createRes = mockRes();
    await salesReturnController.create(reqFor(distributor, {
      invoiceId: invoice.id,
      lines: [{ invoiceLineId: invoice.lines[0].id, quantity: 8, batchId: batch.id, reason: "Damaged" }],
    }), createRes);
    expect(createRes.status).toHaveBeenCalledWith(201);
    const returnId = createRes.jsonBody.salesReturn.id;

    const postRes = mockRes();
    await salesReturnController.post(reqFor(distributor, {}, { id: returnId }), postRes);
    expect(postRes.status).not.toBe(400);
    expect(postRes.jsonBody.salesReturn.status).toBe("POSTED");
    expect(postRes.jsonBody.creditNote.status).toBe("POSTED"); // financial adjustment applied atomically

    const afterAvailable = await inventory.getBatchAvailableQty({ batchId: batch.id, distributorId: distributor.id });
    expect(afterAvailable).toBe(beforeAvailable + 8);

    const stockRows = await db.StockLedger.findAll({ where: { batchId: batch.id, movement_type: "IN", reference_type: "RETURN" } });
    expect(stockRows).toHaveLength(1);
    expect(stockRows[0].reference_id).toBe(returnId);
  });

  test("9. cumulative over-return across multiple returns is rejected (100 -> 20 -> 50 -> 30 -> reject)", async () => {
    const distributor = await seedDistributor();
    await seedGLAccounts(distributor);
    const { invoice, batch } = await postedSalesInvoice(distributor, { qty: 100, rate: 10 });
    const lineId = invoice.lines[0].id;

    async function makeAndPostReturn(qty) {
      const cRes = mockRes();
      await salesReturnController.create(reqFor(distributor, {
        invoiceId: invoice.id, lines: [{ invoiceLineId: lineId, quantity: qty, batchId: batch.id }],
      }), cRes);
      if (cRes.statusCode >= 400) return cRes;
      const pRes = mockRes();
      await salesReturnController.post(reqFor(distributor, {}, { id: cRes.jsonBody.salesReturn.id }), pRes);
      return pRes;
    }

    const r1 = await makeAndPostReturn(20);
    expect(r1.jsonBody.salesReturn?.status).toBe("POSTED");
    const r2 = await makeAndPostReturn(50);
    expect(r2.jsonBody.salesReturn?.status).toBe("POSTED");
    const r3 = await makeAndPostReturn(30);
    expect(r3.jsonBody.salesReturn?.status).toBe("POSTED"); // exactly 100 consumed now

    const r4 = await makeAndPostReturn(1); // nothing left
    expect(r4.statusCode).toBe(400);
  });

  test("10. a credit note and a return against the same line share the same consumable pool", async () => {
    const distributor = await seedDistributor();
    await seedGLAccounts(distributor);
    const { invoice, batch } = await postedSalesInvoice(distributor, { qty: 20, rate: 10 });
    const lineId = invoice.lines[0].id;

    // Credit 12 units via a standalone credit note (no physical return)
    await salesCreditNoteController.create(reqFor(distributor, {
      invoiceId: invoice.id, lines: [{ invoiceLineId: lineId, quantity: 12 }],
    }), mockRes());

    // Only 8 remain — a return for 10 must be rejected
    const res = mockRes();
    await salesReturnController.create(reqFor(distributor, {
      invoiceId: invoice.id, lines: [{ invoiceLineId: lineId, quantity: 10, batchId: batch.id }],
    }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("11. rejects cross-tenant batch on return line", async () => {
    const distributorA = await seedDistributor();
    const distributorB = await seedDistributor();
    const { invoice } = await postedSalesInvoice(distributorA, { qty: 10 });
    const otherProduct = await seedProduct(distributorB.id);
    const batchB = await seedBatch(distributorB.id, otherProduct.id);

    const res = mockRes();
    await salesReturnController.create(reqFor(distributorA, {
      invoiceId: invoice.id, lines: [{ invoiceLineId: invoice.lines[0].id, quantity: 1, batchId: batchB.id }],
    }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("12. transaction rollback: a failing second line leaves stock and return state untouched", async () => {
    const distributor = await seedDistributor();
    await seedGLAccounts(distributor);
    const { invoice, batch } = await postedSalesInvoice(distributor, { qty: 20 });

    const before = await inventory.getBatchAvailableQty({ batchId: batch.id, distributorId: distributor.id });

    const res = mockRes();
    await salesReturnController.create(reqFor(distributor, {
      invoiceId: invoice.id,
      lines: [
        { invoiceLineId: invoice.lines[0].id, quantity: 5, batchId: batch.id },
        { invoiceLineId: 999999, quantity: 1, batchId: batch.id }, // invalid
      ],
    }), res);
    expect(res.status).toHaveBeenCalledWith(400);

    const count = await db.SalesReturn.count();
    expect(count).toBe(0);
    const after = await inventory.getBatchAvailableQty({ batchId: batch.id, distributorId: distributor.id });
    expect(after).toBe(before);
  });
});

// ===================== PURCHASE RETURN ===================== //
describe("Purchase Return", () => {
  test("13. full lifecycle: create, post -> StockLedger OUT + linked posted debit note", async () => {
    const distributor = await seedDistributor();
    await seedGLAccounts(distributor);
    const { invoice, batch } = await postedPurchaseInvoice(distributor, { qty: 20, rate: 10 });

    const before = await inventory.getBatchAvailableQty({ batchId: batch.id, distributorId: distributor.id });

    const createRes = mockRes();
    await purchaseReturnController.create(reqFor(distributor, {
      invoiceId: invoice.id,
      lines: [{ invoiceLineId: invoice.lines[0].id, quantity: 5, batchId: batch.id, reason: "Wrong item" }],
    }), createRes);
    expect(createRes.status).toHaveBeenCalledWith(201);
    const returnId = createRes.jsonBody.purchaseReturn.id;

    const postRes = mockRes();
    await purchaseReturnController.post(reqFor(distributor, {}, { id: returnId }), postRes);
    expect(postRes.jsonBody.purchaseReturn.status).toBe("POSTED");
    expect(postRes.jsonBody.debitNote.status).toBe("POSTED");

    const after = await inventory.getBatchAvailableQty({ batchId: batch.id, distributorId: distributor.id });
    expect(after).toBe(before - 5);

    const entries = await db.JournalEntry.findAll({ where: { reference_no: postRes.jsonBody.debitNote.id, reference_type: "PURCHASE_DEBIT_NOTE" } });
    const debit = entries.reduce((s, e) => s + Number(e.debit || 0), 0);
    const credit = entries.reduce((s, e) => s + Number(e.credit || 0), 0);
    expect(debit).toBe(credit);
  });

  test("14. cannot return more than received quantity", async () => {
    const distributor = await seedDistributor();
    await seedGLAccounts(distributor);
    const { invoice, batch } = await postedPurchaseInvoice(distributor, { qty: 20 });

    await purchaseReturnController.create(reqFor(distributor, {
      invoiceId: invoice.id, lines: [{ invoiceLineId: invoice.lines[0].id, quantity: 15, batchId: batch.id }],
    }), mockRes());

    const res = mockRes();
    await purchaseReturnController.create(reqFor(distributor, {
      invoiceId: invoice.id, lines: [{ invoiceLineId: invoice.lines[0].id, quantity: 10, batchId: batch.id }], // only 5 remain
    }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("15. cannot return more than currently available stock (already partially consumed elsewhere)", async () => {
    const distributor = await seedDistributor();
    await seedGLAccounts(distributor);
    const { invoice, batch, product } = await postedPurchaseInvoice(distributor, { qty: 20 });

    // Consume 18 of the 20 units via an unrelated OUT movement (simulating a sale)
    await inventory.postMovement({
      distributorId: distributor.id, productId: product.id, batchId: batch.id,
      movementType: "OUT", quantity: 18, referenceType: "SALES",
    });

    // Only 2 physically remain, but 20 are still "eligible" per the PO
    const res = mockRes();
    await purchaseReturnController.create(reqFor(distributor, {
      invoiceId: invoice.id, lines: [{ invoiceLineId: invoice.lines[0].id, quantity: 5, batchId: batch.id }],
    }), res);
    // creation succeeds (eligible qty check only) — posting must fail on insufficient stock
    expect(res.status).toHaveBeenCalledWith(201);

    const postRes = mockRes();
    await purchaseReturnController.post(reqFor(distributor, {}, { id: res.jsonBody.purchaseReturn.id }), postRes);
    expect(postRes.status).toHaveBeenCalledWith(400);

    const header = await db.PurchaseReturn.findByPk(res.jsonBody.purchaseReturn.id);
    expect(header.status).toBe("DRAFT"); // unchanged — no partial posting
  });

  test("16. cross-tenant purchase return creation rejected", async () => {
    const distributorA = await seedDistributor();
    const distributorB = await seedDistributor();
    const { invoice } = await postedPurchaseInvoice(distributorA);

    const res = mockRes();
    await purchaseReturnController.create(reqFor(distributorB, {
      invoiceId: invoice.id, lines: [{ invoiceLineId: invoice.lines[0].id, quantity: 1, batchId: 1 }],
    }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

// ===================== REGRESSION ===================== //
describe("Regression — Phases 1-4 intact", () => {
  test("17. sales/purchase tenant isolation and inventory invariants unaffected", async () => {
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
