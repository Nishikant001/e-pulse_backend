const {
  db, resetDb, mockRes,
  seedDistributor, seedProduct, seedBatch, seedCustomer,
  seedSalesOrder, seedPricing, seedGLAccounts,
} = require("./helpers");

const salesOrderController = require("../controllers/salesOrder.controller");
const salesDeliveryController = require("../controllers/salesdelivery.controller");
const salesInvoiceController = require("../controllers/salesinvoice.controller");
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

async function stockIn(distributor, product, batch, qty) {
  await inventory.postMovement({
    distributorId: distributor.id, productId: product.id, batchId: batch.id,
    movementType: "IN", quantity: qty, referenceType: "OPENING",
  });
}

// ===================== SALES ORDER TESTS ===================== //
describe("Sales Order — creation & validation", () => {
  test("1. creates a valid order with manual price (no PricingMaster configured)", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const customer = await seedCustomer(distributor.id);

    const res = mockRes();
    await salesOrderController.create(reqFor(distributor, {
      orderDate: new Date(), customerId: customer.id,
      lines: [{ productId: product.id, quantity: 10, pricePerUnit: 20 }],
    }), res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.jsonBody.header.status).toBe("DRAFT");
  });

  test("2. creates a multi-line order and sums totals correctly", async () => {
    const distributor = await seedDistributor();
    const p1 = await seedProduct(distributor.id);
    const p2 = await seedProduct(distributor.id);
    const customer = await seedCustomer(distributor.id);

    const res = mockRes();
    await salesOrderController.create(reqFor(distributor, {
      orderDate: new Date(), customerId: customer.id,
      lines: [
        { productId: p1.id, quantity: 10, pricePerUnit: 20 },
        { productId: p2.id, quantity: 5, pricePerUnit: 40 },
      ],
    }), res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(Number(res.jsonBody.header.netValue)).toBe(400); // 10*20 + 5*40
  });

  test("3. rejects zero/negative quantity", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const customer = await seedCustomer(distributor.id);

    const res = mockRes();
    await salesOrderController.create(reqFor(distributor, {
      orderDate: new Date(), customerId: customer.id,
      lines: [{ productId: product.id, quantity: 0, pricePerUnit: 20 }],
    }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("4. rejects negative rate", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const customer = await seedCustomer(distributor.id);

    const res = mockRes();
    await salesOrderController.create(reqFor(distributor, {
      orderDate: new Date(), customerId: customer.id,
      lines: [{ productId: product.id, quantity: 5, pricePerUnit: -1 }],
    }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("5. rejects invalid/nonexistent customer", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);

    const res = mockRes();
    await salesOrderController.create(reqFor(distributor, {
      orderDate: new Date(), customerId: 999999,
      lines: [{ productId: product.id, quantity: 5, pricePerUnit: 20 }],
    }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("6. rejects cross-tenant customer", async () => {
    const distributorA = await seedDistributor();
    const distributorB = await seedDistributor();
    const product = await seedProduct(distributorA.id);
    const customerB = await seedCustomer(distributorB.id);

    const res = mockRes();
    await salesOrderController.create(reqFor(distributorA, {
      orderDate: new Date(), customerId: customerB.id,
      lines: [{ productId: product.id, quantity: 5, pricePerUnit: 20 }],
    }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("7. rejects cross-tenant product", async () => {
    const distributorA = await seedDistributor();
    const distributorB = await seedDistributor();
    const productB = await seedProduct(distributorB.id);
    const customerA = await seedCustomer(distributorA.id);

    const res = mockRes();
    await salesOrderController.create(reqFor(distributorA, {
      orderDate: new Date(), customerId: customerA.id,
      lines: [{ productId: productB.id, quantity: 5, pricePerUnit: 20 }],
    }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("8. authoritative pricing: PricingMaster overrides client-supplied price", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const customer = await seedCustomer(distributor.id);
    await seedPricing(distributor, product, customer.customer_group_id, { basePrice: 100, discountPercent: 10 });

    const res = mockRes();
    await salesOrderController.create(reqFor(distributor, {
      orderDate: new Date(), customerId: customer.id,
      // client tries to lowball the price — PricingMaster must win
      lines: [{ productId: product.id, quantity: 2, pricePerUnit: 1 }],
    }), res);

    expect(res.status).toHaveBeenCalledWith(201);
    // 100 - 10% = 90/unit * 2 = 180
    expect(Number(res.jsonBody.header.netValue)).toBe(180);
  });
});

describe("Sales Order — state machine", () => {
  test("9. DRAFT -> CONFIRMED succeeds", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const so = await seedSalesOrder(distributor, { productId: product.id, status: "DRAFT" });

    const res = mockRes();
    await salesOrderController.confirm(reqFor(distributor, {}, { id: so.id }), res);
    expect(res.jsonBody.header.status).toBe("CONFIRMED");
  });

  test("10. CONFIRMED -> CANCELLED succeeds", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const so = await seedSalesOrder(distributor, { productId: product.id, status: "CONFIRMED" });

    const res = mockRes();
    await salesOrderController.cancel(reqFor(distributor, {}, { id: so.id }), res);
    expect(res.jsonBody.header.status).toBe("CANCELLED");
  });

  test("11. invalid transition CONFIRMED -> DRAFT-only-op (re-confirm) is rejected", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const so = await seedSalesOrder(distributor, { productId: product.id, status: "CONFIRMED" });

    const res = mockRes();
    await salesOrderController.confirm(reqFor(distributor, {}, { id: so.id }), res); // already CONFIRMED
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("12. invalid transition CANCELLED -> CONFIRMED is rejected", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const so = await seedSalesOrder(distributor, { productId: product.id, status: "CANCELLED" });

    const res = mockRes();
    await salesOrderController.confirm(reqFor(distributor, {}, { id: so.id }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("13. invalid transition FULLY_DELIVERED -> CONFIRMED (regression) is rejected", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const so = await seedSalesOrder(distributor, { productId: product.id, status: "FULLY_DELIVERED" });

    const res = mockRes();
    await salesOrderController.confirm(reqFor(distributor, {}, { id: so.id }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

// ===================== DELIVERY LIFECYCLE TESTS ===================== //
describe("Sales Delivery — lifecycle against order status", () => {
  test("14. cannot deliver a DRAFT order", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const batch = await seedBatch(distributor.id, product.id, { exp_date: new Date("2030-01-01") });
    await stockIn(distributor, product, batch, 100);
    const so = await seedSalesOrder(distributor, { productId: product.id, quantity: 10, status: "DRAFT" });

    const res = mockRes();
    await salesDeliveryController.create(reqFor(distributor, {
      order_number: so.order_number, deliveryDate: new Date(),
      lines: [{ orderLineId: so.lines[0].id, quantityDelivered: 10, batchId: batch.id }],
    }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("15. cannot deliver a CANCELLED order", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const batch = await seedBatch(distributor.id, product.id, { exp_date: new Date("2030-01-01") });
    await stockIn(distributor, product, batch, 100);
    const so = await seedSalesOrder(distributor, { productId: product.id, quantity: 10, status: "CANCELLED" });

    const res = mockRes();
    await salesDeliveryController.create(reqFor(distributor, {
      order_number: so.order_number, deliveryDate: new Date(),
      lines: [{ orderLineId: so.lines[0].id, quantityDelivered: 10, batchId: batch.id }],
    }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("16. partial delivery sets PARTIALLY_DELIVERED, second delivery completes it", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const batch = await seedBatch(distributor.id, product.id, { exp_date: new Date("2030-01-01") });
    await stockIn(distributor, product, batch, 100);
    const so = await seedSalesOrder(distributor, { productId: product.id, quantity: 100, status: "CONFIRMED" });

    const res1 = mockRes();
    await salesDeliveryController.create(reqFor(distributor, {
      order_number: so.order_number, deliveryDate: new Date(),
      lines: [{ orderLineId: so.lines[0].id, quantityDelivered: 60, batchId: batch.id }],
    }), res1);
    expect(res1.status).toHaveBeenCalledWith(201);

    let order = await db.SalesOrderHeader.findByPk(so.id);
    expect(order.status).toBe("PARTIALLY_DELIVERED");

    const res2 = mockRes();
    await salesDeliveryController.create(reqFor(distributor, {
      order_number: so.order_number, deliveryDate: new Date(),
      lines: [{ orderLineId: so.lines[0].id, quantityDelivered: 40, batchId: batch.id }],
    }), res2);
    expect(res2.status).toHaveBeenCalledWith(201);

    order = await db.SalesOrderHeader.findByPk(so.id);
    expect(order.status).toBe("FULLY_DELIVERED");
  });

  test("17. over-delivery across multiple deliveries is rejected with a clear message", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const batch = await seedBatch(distributor.id, product.id, { exp_date: new Date("2030-01-01") });
    await stockIn(distributor, product, batch, 200);
    const so = await seedSalesOrder(distributor, { productId: product.id, quantity: 100, status: "CONFIRMED" });

    await salesDeliveryController.create(reqFor(distributor, {
      order_number: so.order_number, deliveryDate: new Date(),
      lines: [{ orderLineId: so.lines[0].id, quantityDelivered: 60, batchId: batch.id }],
    }), mockRes());

    const res2 = mockRes();
    await salesDeliveryController.create(reqFor(distributor, {
      order_number: so.order_number, deliveryDate: new Date(),
      lines: [{ orderLineId: so.lines[0].id, quantityDelivered: 50, batchId: batch.id }],
    }), res2);

    expect(res2.status).toHaveBeenCalledWith(400);
    expect(res2.jsonBody.error).toMatch(/remain to be delivered/);
  });

  test("18. cancelling a delivery reverses stock and recomputes order status", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const batch = await seedBatch(distributor.id, product.id, { exp_date: new Date("2030-01-01") });
    await stockIn(distributor, product, batch, 100);
    const so = await seedSalesOrder(distributor, { productId: product.id, quantity: 100, status: "CONFIRMED" });

    const createRes = mockRes();
    await salesDeliveryController.create(reqFor(distributor, {
      order_number: so.order_number, deliveryDate: new Date(),
      lines: [{ orderLineId: so.lines[0].id, quantityDelivered: 100, batchId: batch.id }],
    }), createRes);
    const deliveryId = createRes.jsonBody.delivery.id;

    let available = await inventory.getBatchAvailableQty({ batchId: batch.id, distributorId: distributor.id });
    expect(available).toBe(0);

    const cancelRes = mockRes();
    await salesDeliveryController.cancel(reqFor(distributor, {}, { id: deliveryId }), cancelRes);
    expect(cancelRes.jsonBody.message).toBe("Delivery cancelled");

    available = await inventory.getBatchAvailableQty({ batchId: batch.id, distributorId: distributor.id });
    expect(available).toBe(100);

    const order = await db.SalesOrderHeader.findByPk(so.id);
    expect(order.status).toBe("CONFIRMED");
  });
});

// ===================== INVOICE TESTS ===================== //
async function deliverFullOrder(distributor, product, batch, qty = 10, rate = 20) {
  await stockIn(distributor, product, batch, qty + 50);
  const so = await seedSalesOrder(distributor, { productId: product.id, quantity: qty, pricePerUnit: rate, status: "CONFIRMED" });
  const res = mockRes();
  await salesDeliveryController.create(reqFor(distributor, {
    order_number: so.order_number, deliveryDate: new Date(),
    lines: [{ orderLineId: so.lines[0].id, quantityDelivered: qty, batchId: batch.id }],
  }), res);
  return { so, deliveryId: res.jsonBody.delivery.id };
}

describe("Sales Invoice — creation, tax, posting, accounting", () => {
  test("19. creates a valid DRAFT invoice from a delivery with correct line + totals", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id, { cgst: 6, sgst: 6 });
    const batch = await seedBatch(distributor.id, product.id, { exp_date: new Date("2030-01-01") });
    const { deliveryId } = await deliverFullOrder(distributor, product, batch, 10, 20);

    const res = mockRes();
    await salesInvoiceController.create(reqFor(distributor, { deliveryId }), res);

    expect(res.status).toHaveBeenCalledWith(201);
    const invoice = res.jsonBody.invoice;
    expect(invoice.status).toBe("DRAFT");
    expect(Number(invoice.netValue)).toBe(200); // 10 * 20
    expect(Number(invoice.cgstAmount)).toBe(12); // 6% of 200
    expect(Number(invoice.sgstAmount)).toBe(12);
    expect(Number(invoice.totalAmount)).toBe(224);
    expect(invoice.invoice_number).toMatch(/-INV-\d{4}$/);
  });

  test("20. duplicate invoice for the same delivery is rejected", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const batch = await seedBatch(distributor.id, product.id, { exp_date: new Date("2030-01-01") });
    const { deliveryId } = await deliverFullOrder(distributor, product, batch);

    await salesInvoiceController.create(reqFor(distributor, { deliveryId }), mockRes());
    const res2 = mockRes();
    await salesInvoiceController.create(reqFor(distributor, { deliveryId }), res2);
    expect(res2.status).toHaveBeenCalledWith(400);
  });

  test("21. cross-tenant invoice creation is rejected", async () => {
    const distributorA = await seedDistributor();
    const distributorB = await seedDistributor();
    const product = await seedProduct(distributorA.id);
    const batch = await seedBatch(distributorA.id, product.id, { exp_date: new Date("2030-01-01") });
    const { deliveryId } = await deliverFullOrder(distributorA, product, batch);

    const res = mockRes();
    await salesInvoiceController.create(reqFor(distributorB, { deliveryId }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test("22. posting creates balanced GL entries and updates status/outstanding", async () => {
    const distributor = await seedDistributor();
    await seedGLAccounts(distributor);
    const product = await seedProduct(distributor.id, { cgst: 6, sgst: 6 });
    const batch = await seedBatch(distributor.id, product.id, { exp_date: new Date("2030-01-01") });
    const { deliveryId } = await deliverFullOrder(distributor, product, batch, 10, 20);

    const createRes = mockRes();
    await salesInvoiceController.create(reqFor(distributor, { deliveryId }), createRes);
    const invoiceId = createRes.jsonBody.invoice.id;

    const postRes = mockRes();
    await salesInvoiceController.post(reqFor(distributor, {}, { id: invoiceId }), postRes);
    expect(postRes.jsonBody.invoice.status).toBe("POSTED");
    expect(Number(postRes.jsonBody.invoice.outstandingAmount)).toBe(224);

    const entries = await db.JournalEntry.findAll({ where: { reference_no: invoiceId } });
    const debit = entries.reduce((s, e) => s + Number(e.debit || 0), 0);
    const credit = entries.reduce((s, e) => s + Number(e.credit || 0), 0);
    expect(debit).toBe(credit); // debit must equal credit
    expect(debit).toBe(224);
  });

  test("23. posting fails cleanly (no invoice status change) when a GL lookup fails", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const batch = await seedBatch(distributor.id, product.id, { exp_date: new Date("2030-01-01") });
    const { deliveryId } = await deliverFullOrder(distributor, product, batch);

    const createRes = mockRes();
    await salesInvoiceController.create(reqFor(distributor, { deliveryId }), createRes);
    const invoiceId = createRes.jsonBody.invoice.id;

    const acc = require("../services/accounting.service"); // standard accounts are auto-created now, so simulate the lookup failing
    const spy = jest.spyOn(acc, "getGL").mockRejectedValueOnce(new acc.AccountingError("GL not configured: Sales"));
    const postRes = mockRes();
    await salesInvoiceController.post(reqFor(distributor, {}, { id: invoiceId }), postRes);
    spy.mockRestore();
    expect(postRes.status).toHaveBeenCalledWith(400);

    const invoice = await db.SalesInvoiceHeader.findByPk(invoiceId);
    expect(invoice.status).toBe("DRAFT"); // unchanged — no partial posting
    const entries = await db.JournalEntry.count({ where: { reference_no: invoiceId } });
    expect(entries).toBe(0); // nothing partially posted
  });

  test("24. posted invoice cannot be edited or deleted", async () => {
    const distributor = await seedDistributor();
    await seedGLAccounts(distributor);
    const product = await seedProduct(distributor.id);
    const batch = await seedBatch(distributor.id, product.id, { exp_date: new Date("2030-01-01") });
    const { deliveryId } = await deliverFullOrder(distributor, product, batch);

    const createRes = mockRes();
    await salesInvoiceController.create(reqFor(distributor, { deliveryId }), createRes);
    const invoiceId = createRes.jsonBody.invoice.id;
    await salesInvoiceController.post(reqFor(distributor, {}, { id: invoiceId }), mockRes());

    const updateRes = mockRes();
    await salesInvoiceController.update(reqFor(distributor, { paymentTerms: "Net 60" }, { id: invoiceId }), updateRes);
    expect(updateRes.status).toHaveBeenCalledWith(400);

    const deleteRes = mockRes();
    await salesInvoiceController.delete(reqFor(distributor, {}, { id: invoiceId }), deleteRes);
    expect(deleteRes.status).toHaveBeenCalledWith(400);
  });

  test("25. invalid invoice source (nonexistent delivery) is rejected", async () => {
    const distributor = await seedDistributor();
    const res = mockRes();
    await salesInvoiceController.create(reqFor(distributor, { deliveryId: 999999 }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

// ===================== CONCURRENCY ===================== //
describe("Concurrency", () => {
  test("26. concurrent deliveries cannot jointly oversell stock", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const batch = await seedBatch(distributor.id, product.id, { exp_date: new Date("2030-01-01") });
    await stockIn(distributor, product, batch, 100);
    const so = await seedSalesOrder(distributor, { productId: product.id, quantity: 100, status: "CONFIRMED" });

    const attempt = (qty) =>
      salesDeliveryController
        .create(reqFor(distributor, {
          order_number: so.order_number, deliveryDate: new Date(),
          lines: [{ orderLineId: so.lines[0].id, quantityDelivered: qty, batchId: batch.id }],
        }), mockRes())
        .catch((e) => e); // never let a rejected promise crash the race

    // Fire two overlapping deliveries that together exceed both order qty
    // and available stock if the row lock / over-delivery guard didn't hold.
    // NOTE: sqlite (used for this test suite) is a single-writer database
    // and doesn't exercise real multi-connection row locking the way MySQL
    // (used in production) does, so this mainly verifies the application-
    // level guard (remaining-quantity check inside the transaction) rather
    // than true DB-level lock contention. The `t.LOCK.UPDATE` in the
    // controller is meaningful for MySQL and should additionally be
    // verified there.
    await Promise.all([attempt(80), attempt(50)]);

    const available = await inventory.getBatchAvailableQty({ batchId: batch.id, distributorId: distributor.id });
    expect(available).toBeGreaterThanOrEqual(0);

    const outRows = await db.StockLedger.findAll({ where: { batchId: batch.id, movement_type: "OUT" } });
    const totalOut = outRows.reduce((s, r) => s + r.quantity, 0);
    expect(totalOut).toBeLessThanOrEqual(100); // never oversold beyond what was IN
  });
});

// ===================== REGRESSION ===================== //
describe("Regression — existing APIs still work", () => {
  test("27. product/customer/batch tenant isolation from earlier phases is intact", async () => {
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
