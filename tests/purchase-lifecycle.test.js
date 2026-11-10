const {
  db, resetDb, mockRes,
  seedDistributor, seedProduct, seedBatch, seedVendor, seedGLAccounts,
} = require("./helpers");

const purchaseOrderController = require("../controllers/purchaseorder.controller");
const purchaseDeliveryController = require("../controllers/purchasedelivery.controller");
const purchaseInvoiceController = require("../controllers/purchaseinvoice.controller");
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

// ===================== PURCHASE ORDER TESTS ===================== //
describe("Purchase Order — creation & validation", () => {
  test("1. creates a valid PO in DRAFT status", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const vendor = await seedVendor(distributor.id);

    const res = mockRes();
    await purchaseOrderController.create(reqFor(distributor, {
      orderDate: new Date(), vendorId: vendor.id,
      lines: [{ productId: product.id, quantity: 100, pricePerUnit: 10 }],
    }), res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.jsonBody.header.status).toBe("DRAFT");
    expect(Number(res.jsonBody.header.netValue)).toBe(1000);
  });

  test("2. rejects zero/negative quantity", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const vendor = await seedVendor(distributor.id);

    const res = mockRes();
    await purchaseOrderController.create(reqFor(distributor, {
      orderDate: new Date(), vendorId: vendor.id,
      lines: [{ productId: product.id, quantity: 0, pricePerUnit: 10 }],
    }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("3. rejects negative price", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const vendor = await seedVendor(distributor.id);

    const res = mockRes();
    await purchaseOrderController.create(reqFor(distributor, {
      orderDate: new Date(), vendorId: vendor.id,
      lines: [{ productId: product.id, quantity: 10, pricePerUnit: -5 }],
    }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("4. rejects cross-tenant vendor", async () => {
    const distributorA = await seedDistributor();
    const distributorB = await seedDistributor();
    const product = await seedProduct(distributorA.id);
    const vendorB = await seedVendor(distributorB.id);

    const res = mockRes();
    await purchaseOrderController.create(reqFor(distributorA, {
      orderDate: new Date(), vendorId: vendorB.id,
      lines: [{ productId: product.id, quantity: 10, pricePerUnit: 10 }],
    }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test("5. rejects cross-tenant product", async () => {
    const distributorA = await seedDistributor();
    const distributorB = await seedDistributor();
    const productB = await seedProduct(distributorB.id);
    const vendorA = await seedVendor(distributorA.id);

    const res = mockRes();
    await purchaseOrderController.create(reqFor(distributorA, {
      orderDate: new Date(), vendorId: vendorA.id,
      lines: [{ productId: productB.id, quantity: 10, pricePerUnit: 10 }],
    }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe("Purchase Order — state machine", () => {
  async function makeDraftPO(distributor, product) {
    const vendor = await seedVendor(distributor.id);
    const res = mockRes();
    await purchaseOrderController.create(reqFor(distributor, {
      orderDate: new Date(), vendorId: vendor.id,
      lines: [{ productId: product.id, quantity: 50, pricePerUnit: 10 }],
    }), res);
    return db.PurchaseOrderHeader.findByPk(res.jsonBody.header.id);
  }

  test("6. DRAFT -> CONFIRMED succeeds", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const po = await makeDraftPO(distributor, product);

    const res = mockRes();
    await purchaseOrderController.confirm(reqFor(distributor, {}, { id: po.id }), res);
    expect(res.jsonBody.header.status).toBe("CONFIRMED");
  });

  test("7. invalid transition CANCELLED -> CONFIRMED rejected", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const po = await makeDraftPO(distributor, product);
    await purchaseOrderController.cancel(reqFor(distributor, {}, { id: po.id }), mockRes());

    const res = mockRes();
    await purchaseOrderController.confirm(reqFor(distributor, {}, { id: po.id }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("8. cannot delete a CONFIRMED PO (must cancel instead)", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const po = await makeDraftPO(distributor, product);
    await purchaseOrderController.confirm(reqFor(distributor, {}, { id: po.id }), mockRes());

    const res = mockRes();
    await purchaseOrderController.delete(reqFor(distributor, {}, { id: po.id }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("9. line editing is blocked once PO is CONFIRMED", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const po = await makeDraftPO(distributor, product);
    await purchaseOrderController.confirm(reqFor(distributor, {}, { id: po.id }), mockRes());

    const res = mockRes();
    await purchaseOrderController.update(reqFor(distributor, {
      lines: [{ productId: product.id, quantity: 999, pricePerUnit: 1 }],
    }, { id: po.id }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

// ===================== PURCHASE DELIVERY / RECEIVING TESTS ===================== //
async function makeConfirmedPO(distributor, product, quantity = 100, pricePerUnit = 10) {
  const vendor = await seedVendor(distributor.id);
  const createRes = mockRes();
  await purchaseOrderController.create(reqFor(distributor, {
    orderDate: new Date(), vendorId: vendor.id,
    lines: [{ productId: product.id, quantity, pricePerUnit }],
  }), createRes);
  const po = await db.PurchaseOrderHeader.findByPk(createRes.jsonBody.header.id, {
    include: [{ model: db.PurchaseOrderLine, as: "lines" }],
  });
  await purchaseOrderController.confirm(reqFor(distributor, {}, { id: po.id }), mockRes());
  return po;
}

describe("Purchase Delivery — receiving lifecycle", () => {
  test("10. cannot deliver against a DRAFT PO", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const batch = await seedBatch(distributor.id, product.id);
    const vendor = await seedVendor(distributor.id);
    const createRes = mockRes();
    await purchaseOrderController.create(reqFor(distributor, {
      orderDate: new Date(), vendorId: vendor.id,
      lines: [{ productId: product.id, quantity: 50, pricePerUnit: 10 }],
    }), createRes);
    const po = await db.PurchaseOrderHeader.findByPk(createRes.jsonBody.header.id, {
      include: [{ model: db.PurchaseOrderLine, as: "lines" }],
    });

    const res = mockRes();
    await purchaseDeliveryController.create(reqFor(distributor, {
      order_number: po.order_number, deliveryDate: new Date(),
      lines: [{ orderLineId: po.lines[0].id, quantityReceived: 50, batchId: batch.id }],
    }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("11. partial receiving -> PARTIALLY_RECEIVED, second delivery -> FULLY_RECEIVED", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const batch = await seedBatch(distributor.id, product.id);
    const po = await makeConfirmedPO(distributor, product, 100);

    const res1 = mockRes();
    await purchaseDeliveryController.create(reqFor(distributor, {
      order_number: po.order_number, deliveryDate: new Date(),
      lines: [{ orderLineId: po.lines[0].id, quantityReceived: 30, batchId: batch.id }],
    }), res1);
    expect(res1.status).toHaveBeenCalledWith(201);
    let header = await db.PurchaseOrderHeader.findByPk(po.id);
    expect(header.status).toBe("PARTIALLY_RECEIVED");

    await purchaseDeliveryController.create(reqFor(distributor, {
      order_number: po.order_number, deliveryDate: new Date(),
      lines: [{ orderLineId: po.lines[0].id, quantityReceived: 70, batchId: batch.id }],
    }), mockRes());
    header = await db.PurchaseOrderHeader.findByPk(po.id);
    expect(header.status).toBe("FULLY_RECEIVED");

    const available = await inventory.getBatchAvailableQty({ batchId: batch.id, distributorId: distributor.id });
    expect(available).toBe(100);
  });

  test("12. over-receipt is rejected with a clear message and no stock posted", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const batch = await seedBatch(distributor.id, product.id);
    const po = await makeConfirmedPO(distributor, product, 100);

    await purchaseDeliveryController.create(reqFor(distributor, {
      order_number: po.order_number, deliveryDate: new Date(),
      lines: [{ orderLineId: po.lines[0].id, quantityReceived: 80, batchId: batch.id }],
    }), mockRes());

    const res = mockRes();
    await purchaseDeliveryController.create(reqFor(distributor, {
      order_number: po.order_number, deliveryDate: new Date(),
      lines: [{ orderLineId: po.lines[0].id, quantityReceived: 30, batchId: batch.id }],
    }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.jsonBody.error).toMatch(/remain to be received/);

    const available = await inventory.getBatchAvailableQty({ batchId: batch.id, distributorId: distributor.id });
    expect(available).toBe(80); // only the first, valid delivery posted
  });

  test("13. StockLedger IN is created with correct reference and batch", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const batch = await seedBatch(distributor.id, product.id);
    const po = await makeConfirmedPO(distributor, product, 40);

    const res = mockRes();
    await purchaseDeliveryController.create(reqFor(distributor, {
      order_number: po.order_number, deliveryDate: new Date(),
      lines: [{ orderLineId: po.lines[0].id, quantityReceived: 40, batchId: batch.id }],
    }), res);

    const rows = await db.StockLedger.findAll({ where: { batchId: batch.id, movement_type: "IN" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].reference_type).toBe("PURCHASE");
    expect(rows[0].reference_id).toBe(res.jsonBody.delivery.id);
  });

  test("14. regression: GET /po-delivery (getAll) no longer crashes on the missing Batch association", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const batch = await seedBatch(distributor.id, product.id);
    const po = await makeConfirmedPO(distributor, product, 20);
    await purchaseDeliveryController.create(reqFor(distributor, {
      order_number: po.order_number, deliveryDate: new Date(),
      lines: [{ orderLineId: po.lines[0].id, quantityReceived: 20, batchId: batch.id }],
    }), mockRes());

    const res = mockRes();
    await purchaseDeliveryController.getAll(reqFor(distributor, {}), res);
    expect(res.json).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(500);
  });

  test("15. regression: PurchaseDeliveryLine.pricePerUnit is actually persisted now", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const batch = await seedBatch(distributor.id, product.id);
    const po = await makeConfirmedPO(distributor, product, 10, 25);

    await purchaseDeliveryController.create(reqFor(distributor, {
      order_number: po.order_number, deliveryDate: new Date(),
      lines: [{ orderLineId: po.lines[0].id, quantityReceived: 10, batchId: batch.id }],
    }), mockRes());

    const line = await db.PurchaseDeliveryLine.findOne({ where: { orderLineId: po.lines[0].id } });
    expect(Number(line.pricePerUnit)).toBe(25);
  });

  test("16. cross-tenant batch is rejected", async () => {
    const distributorA = await seedDistributor();
    const distributorB = await seedDistributor();
    const product = await seedProduct(distributorA.id);
    const batchB = await seedBatch(distributorB.id, await (async () => (await seedProduct(distributorB.id)).id)());
    const po = await makeConfirmedPO(distributorA, product, 10);

    const res = mockRes();
    await purchaseDeliveryController.create(reqFor(distributorA, {
      order_number: po.order_number, deliveryDate: new Date(),
      lines: [{ orderLineId: po.lines[0].id, quantityReceived: 10, batchId: batchB.id }],
    }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("17. cancelling a delivery reverses stock and recomputes PO status", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const batch = await seedBatch(distributor.id, product.id);
    const po = await makeConfirmedPO(distributor, product, 50);

    const createRes = mockRes();
    await purchaseDeliveryController.create(reqFor(distributor, {
      order_number: po.order_number, deliveryDate: new Date(),
      lines: [{ orderLineId: po.lines[0].id, quantityReceived: 50, batchId: batch.id }],
    }), createRes);
    const deliveryId = createRes.jsonBody.delivery.id;

    let available = await inventory.getBatchAvailableQty({ batchId: batch.id, distributorId: distributor.id });
    expect(available).toBe(50);

    await purchaseDeliveryController.cancel(reqFor(distributor, {}, { id: deliveryId }), mockRes());

    available = await inventory.getBatchAvailableQty({ batchId: batch.id, distributorId: distributor.id });
    expect(available).toBe(0);
    const header = await db.PurchaseOrderHeader.findByPk(po.id);
    expect(header.status).toBe("CONFIRMED");
  });
});

// ===================== PURCHASE INVOICE TESTS ===================== //
async function receiveFullPO(distributor, product, batch, qty = 20, price = 15) {
  const po = await makeConfirmedPO(distributor, product, qty, price);
  const res = mockRes();
  await purchaseDeliveryController.create(reqFor(distributor, {
    order_number: po.order_number, deliveryDate: new Date(),
    lines: [{ orderLineId: po.lines[0].id, quantityReceived: qty, batchId: batch.id }],
  }), res);
  return { po, deliveryId: res.jsonBody.delivery.id };
}

describe("Purchase Invoice — creation, posting, accounting", () => {
  test("18. creates a DRAFT invoice with correct totals (no tax when HSN rate is 0)", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const batch = await seedBatch(distributor.id, product.id);
    const { deliveryId } = await receiveFullPO(distributor, product, batch, 20, 15);

    const res = mockRes();
    await purchaseInvoiceController.create(reqFor(distributor, { deliveryId }), res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.jsonBody.invoice.status).toBe("DRAFT");
    expect(Number(res.jsonBody.invoice.netValue)).toBe(300); // 20 * 15
    expect(res.jsonBody.invoice.invoice_number).toMatch(/-PINV-\d{4}$/);
  });

  test("19. duplicate invoice for the same delivery is rejected", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const batch = await seedBatch(distributor.id, product.id);
    const { deliveryId } = await receiveFullPO(distributor, product, batch);

    await purchaseInvoiceController.create(reqFor(distributor, { deliveryId }), mockRes());
    const res2 = mockRes();
    await purchaseInvoiceController.create(reqFor(distributor, { deliveryId }), res2);
    expect(res2.status).toHaveBeenCalledWith(400);
  });

  test("20. cross-tenant invoice creation rejected", async () => {
    const distributorA = await seedDistributor();
    const distributorB = await seedDistributor();
    const product = await seedProduct(distributorA.id);
    const batch = await seedBatch(distributorA.id, product.id);
    const { deliveryId } = await receiveFullPO(distributorA, product, batch);

    const res = mockRes();
    await purchaseInvoiceController.create(reqFor(distributorB, { deliveryId }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test("21. posting creates balanced GL entries (debit == credit) and updates status/outstanding", async () => {
    const distributor = await seedDistributor();
    await seedGLAccounts(distributor);
    const product = await seedProduct(distributor.id);
    const batch = await seedBatch(distributor.id, product.id);
    const { deliveryId } = await receiveFullPO(distributor, product, batch, 20, 15);

    const createRes = mockRes();
    await purchaseInvoiceController.create(reqFor(distributor, { deliveryId }), createRes);
    const invoiceId = createRes.jsonBody.invoice.id;

    const postRes = mockRes();
    await purchaseInvoiceController.post(reqFor(distributor, {}, { id: invoiceId }), postRes);
    expect(postRes.jsonBody.invoice.status).toBe("POSTED");
    // netValue 300 + 12% IGST (seedProduct's default HSN rate, no vendor/
    // distributor state on either model so it's always treated as
    // inter-state — see Phase 4 report) = 336
    expect(Number(postRes.jsonBody.invoice.outstandingAmount)).toBe(336);

    const entries = await db.JournalEntry.findAll({ where: { reference_no: invoiceId } });
    const debit = entries.reduce((s, e) => s + Number(e.debit || 0), 0);
    const credit = entries.reduce((s, e) => s + Number(e.credit || 0), 0);
    expect(debit).toBe(credit);
    expect(debit).toBe(336);
  });

  test("22. posting fails cleanly (no status change, no entries) when a GL lookup fails", async () => {
    const distributor = await seedDistributor();
    await seedGLAccounts(distributor);
    const product = await seedProduct(distributor.id);
    const batch = await seedBatch(distributor.id, product.id);
    const { deliveryId } = await receiveFullPO(distributor, product, batch);

    const createRes = mockRes();
    await purchaseInvoiceController.create(reqFor(distributor, { deliveryId }), createRes);
    const invoiceId = createRes.jsonBody.invoice.id;

    const spy = jest.spyOn(require("../services/accounting.service"), "getGL").mockRejectedValueOnce(new (require("../services/accounting.service").AccountingError)("GL not configured: Purchase"));
    const postRes = mockRes();
    await purchaseInvoiceController.post(reqFor(distributor, {}, { id: invoiceId }), postRes);
    spy.mockRestore();
    expect(postRes.status).toHaveBeenCalledWith(400);

    const invoice = await db.PurchaseInvoiceHeader.findByPk(invoiceId);
    expect(invoice.status).toBe("DRAFT");
    const count = await db.JournalEntry.count({ where: { reference_no: invoiceId } });
    expect(count).toBe(0);
  });

  test("23. posted invoice cannot be edited or deleted", async () => {
    const distributor = await seedDistributor();
    await seedGLAccounts(distributor);
    const product = await seedProduct(distributor.id);
    const batch = await seedBatch(distributor.id, product.id);
    const { deliveryId } = await receiveFullPO(distributor, product, batch);

    const createRes = mockRes();
    await purchaseInvoiceController.create(reqFor(distributor, { deliveryId }), createRes);
    const invoiceId = createRes.jsonBody.invoice.id;
    await purchaseInvoiceController.post(reqFor(distributor, {}, { id: invoiceId }), mockRes());

    const updateRes = mockRes();
    await purchaseInvoiceController.update(reqFor(distributor, { paymentTerms: "Net 90" }, { id: invoiceId }), updateRes);
    expect(updateRes.status).toHaveBeenCalledWith(400);

    const deleteRes = mockRes();
    await purchaseInvoiceController.delete(reqFor(distributor, {}, { id: invoiceId }), deleteRes);
    expect(deleteRes.status).toHaveBeenCalledWith(400);
  });

  test("24. cannot invoice a cancelled delivery", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const batch = await seedBatch(distributor.id, product.id);
    const { deliveryId } = await receiveFullPO(distributor, product, batch);
    await purchaseDeliveryController.cancel(reqFor(distributor, {}, { id: deliveryId }), mockRes());

    const res = mockRes();
    await purchaseInvoiceController.create(reqFor(distributor, { deliveryId }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

// ===================== TRANSACTION ROLLBACK ===================== //
describe("Transaction integrity", () => {
  test("25. a failing second line rolls back the whole delivery (no partial stock/PO state change)", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const batch = await seedBatch(distributor.id, product.id);
    const po = await makeConfirmedPO(distributor, product, 50);

    const res = mockRes();
    await purchaseDeliveryController.create(reqFor(distributor, {
      order_number: po.order_number, deliveryDate: new Date(),
      lines: [
        { orderLineId: po.lines[0].id, quantityReceived: 20, batchId: batch.id },
        { orderLineId: 999999, quantityReceived: 5, batchId: batch.id }, // invalid line
      ],
    }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    const available = await inventory.getBatchAvailableQty({ batchId: batch.id, distributorId: distributor.id });
    expect(available).toBe(0); // first line's stock IN was rolled back too
    const header = await db.PurchaseOrderHeader.findByPk(po.id);
    expect(header.status).toBe("CONFIRMED"); // unchanged
    const deliveries = await db.PurchaseDeliveryHeader.count();
    expect(deliveries).toBe(0);
  });
});

describe("Purchase Invoice — intra-state vs inter-state GST split", () => {
  test("27. same-region vendor/distributor splits GST into CGST+SGST", async () => {
    const distributor = await seedDistributor({ region: "Karnataka" });
    const product = await seedProduct(distributor.id);
    const batch = await seedBatch(distributor.id, product.id);
    const vendor = await seedVendor(distributor.id, { region: "Karnataka" });

    const createRes = mockRes();
    await purchaseOrderController.create(reqFor(distributor, {
      orderDate: new Date(), vendorId: vendor.id,
      lines: [{ productId: product.id, quantity: 10, pricePerUnit: 20 }],
    }), createRes);

    // netValue 200, HSN gst_rate 12% (seedProduct default) -> CGST 6% + SGST 6%
    expect(Number(createRes.jsonBody.header.cgstAmount)).toBe(12);
    expect(Number(createRes.jsonBody.header.sgstAmount)).toBe(12);
    expect(Number(createRes.jsonBody.header.igstAmount)).toBe(0);
  });

  test("28. different-region vendor/distributor charges IGST only", async () => {
    const distributor = await seedDistributor({ region: "Karnataka" });
    const product = await seedProduct(distributor.id);
    const vendor = await seedVendor(distributor.id, { region: "Maharashtra" });

    const createRes = mockRes();
    await purchaseOrderController.create(reqFor(distributor, {
      orderDate: new Date(), vendorId: vendor.id,
      lines: [{ productId: product.id, quantity: 10, pricePerUnit: 20 }],
    }), createRes);

    expect(Number(createRes.jsonBody.header.igstAmount)).toBe(24);
    expect(Number(createRes.jsonBody.header.cgstAmount)).toBe(0);
    expect(Number(createRes.jsonBody.header.sgstAmount)).toBe(0);
  });
});

// ===================== REGRESSION ===================== //
describe("Regression — Phase 1-3 behavior intact", () => {
  test("26. sales-side tenant isolation from earlier phases still holds", async () => {
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
