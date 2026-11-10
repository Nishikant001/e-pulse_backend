const {
  db,
  resetDb,
  mockRes,
  seedDistributor,
  seedProduct,
  seedBatch,
  seedCustomer,
  seedPurchaseOrder,
  seedSalesOrder,
} = require("./helpers");

const purchaseDeliveryController = require("../controllers/purchasedelivery.controller");
const salesOrderController = require("../controllers/salesOrder.controller");
const salesDeliveryController = require("../controllers/salesdelivery.controller");
const inventory = require("../services/inventory.service");

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await db.sequelize.close();
});

function reqFor(distributor, body, params = {}) {
  return {
    user: { id: distributor.id, distributor_code: distributor.distributor_code },
    body,
    params,
  };
}

async function receiveStock(distributor, product, batch, qty) {
  const po = await seedPurchaseOrder(distributor, { productId: product.id, quantity: qty });
  const res = mockRes();
  await purchaseDeliveryController.create(
    reqFor(distributor, {
      order_number: po.order_number,
      deliveryDate: new Date(),
      lines: [{ orderLineId: po.lines[0].id, quantityReceived: qty, batchId: batch.id }],
    }),
    res
  );
  return res;
}

describe("Scenario 1: purchase delivery increases stock", () => {
  test("confirmed purchase delivery posts a StockLedger IN and increases available stock", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const batch = await seedBatch(distributor.id, product.id);

    const res = await receiveStock(distributor, product, batch, 100);

    expect(res.status).toHaveBeenCalledWith(201);
    const available = await inventory.getBatchAvailableQty({ batchId: batch.id, distributorId: distributor.id });
    expect(available).toBe(100);

    const rows = await db.StockLedger.findAll({ where: { batchId: batch.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].movement_type).toBe("IN");
    expect(rows[0].reference_type).toBe("PURCHASE");
  });
});

describe("Scenario 2: sales order does not touch physical stock", () => {
  test("creating a sales order posts zero StockLedger rows", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const batch = await seedBatch(distributor.id, product.id);
    await receiveStock(distributor, product, batch, 50);

    const beforeCount = await db.StockLedger.count();

    const customer = await seedCustomer(distributor.id);

    const res = mockRes();
    await salesOrderController.create(
      reqFor(distributor, {
        orderDate: new Date(),
        customerId: customer.id,
        lines: [{ productId: product.id, batchId: batch.id, quantity: 10, pricePerUnit: 5 }],
      }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(201);
    const afterCount = await db.StockLedger.count();
    expect(afterCount).toBe(beforeCount); // unchanged — SO must not move stock

    const available = await inventory.getBatchAvailableQty({ batchId: batch.id, distributorId: distributor.id });
    expect(available).toBe(50); // still full, un-deducted
  });
});

describe("Scenario 3: sales delivery reduces stock", () => {
  test("confirmed sales delivery posts a StockLedger OUT and decreases available stock", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const batch = await seedBatch(distributor.id, product.id, { exp_date: new Date("2030-01-01") });
    await receiveStock(distributor, product, batch, 50);

    const so = await seedSalesOrder(distributor, { productId: product.id, quantity: 10, status: "CONFIRMED" });

    const res = mockRes();
    await salesDeliveryController.create(
      reqFor(distributor, {
        order_number: so.order_number,
        deliveryDate: new Date(),
        lines: [{ orderLineId: so.lines[0].id, quantityDelivered: 10, batchId: batch.id }],
      }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(201);
    const available = await inventory.getBatchAvailableQty({ batchId: batch.id, distributorId: distributor.id });
    expect(available).toBe(40);

    const outRows = await db.StockLedger.findAll({ where: { batchId: batch.id, movement_type: "OUT" } });
    expect(outRows).toHaveLength(1);
    expect(outRows[0].reference_type).toBe("SALES");
  });
});

describe("Scenario 4: cannot sell more than available stock", () => {
  test("sales delivery exceeding available stock is rejected with no partial ledger rows", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const batch = await seedBatch(distributor.id, product.id, { exp_date: new Date("2030-01-01") });
    await receiveStock(distributor, product, batch, 5);

    const so = await seedSalesOrder(distributor, { productId: product.id, quantity: 10, status: "CONFIRMED" });

    const res = mockRes();
    await salesDeliveryController.create(
      reqFor(distributor, {
        order_number: so.order_number,
        deliveryDate: new Date(),
        lines: [{ orderLineId: so.lines[0].id, quantityDelivered: 10, batchId: batch.id }],
      }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    const outRows = await db.StockLedger.findAll({ where: { batchId: batch.id, movement_type: "OUT" } });
    expect(outRows).toHaveLength(0); // nothing partially posted
  });
});

describe("Scenario 9: transaction rollback leaves inventory unchanged", () => {
  test("a failing second line rolls back stock movements already posted for the first line", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const batch = await seedBatch(distributor.id, product.id, { exp_date: new Date("2030-01-01") });
    await receiveStock(distributor, product, batch, 100);

    const so = await seedSalesOrder(distributor, { productId: product.id, quantity: 10, status: "CONFIRMED" });
    // Add a second, invalid line referencing a non-existent orderLineId to force failure
    // after the first line's stock movement has already been posted in the same transaction.
    const res = mockRes();
    await salesDeliveryController.create(
      reqFor(distributor, {
        order_number: so.order_number,
        deliveryDate: new Date(),
        lines: [
          { orderLineId: so.lines[0].id, quantityDelivered: 5, batchId: batch.id },
          { orderLineId: 999999, quantityDelivered: 1, batchId: batch.id },
        ],
      }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    // The first line's stock OUT must have been rolled back along with everything else
    const available = await inventory.getBatchAvailableQty({ batchId: batch.id, distributorId: distributor.id });
    expect(available).toBe(100);
    const deliveries = await db.SalesDeliveryHeader.count();
    expect(deliveries).toBe(0);
  });
});

describe("Scenario 10: cross-tenant stock access fails", () => {
  test("distributor B cannot deliver against distributor A's sales order", async () => {
    const distributorA = await seedDistributor();
    const distributorB = await seedDistributor();
    const product = await seedProduct(distributorA.id);
    const batch = await seedBatch(distributorA.id, product.id, { exp_date: new Date("2030-01-01") });
    await receiveStock(distributorA, product, batch, 50);

    const so = await seedSalesOrder(distributorA, { productId: product.id, quantity: 10, status: "CONFIRMED" });

    const res = mockRes();
    await salesDeliveryController.create(
      reqFor(distributorB, {
        order_number: so.order_number, // belongs to distributor A
        deliveryDate: new Date(),
        lines: [{ orderLineId: so.lines[0].id, quantityDelivered: 5, batchId: batch.id }],
      }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(404);
    const available = await inventory.getBatchAvailableQty({ batchId: batch.id, distributorId: distributorA.id });
    expect(available).toBe(50); // untouched
  });

  test("distributor B cannot post an adjustment against distributor A's batch", async () => {
    const distributorA = await seedDistributor();
    const distributorB = await seedDistributor();
    const product = await seedProduct(distributorA.id);
    const batch = await seedBatch(distributorA.id, product.id);

    await expect(
      inventory.postAdjustment({
        distributorId: distributorB.id,
        productId: product.id,
        batchId: batch.id,
        quantity: 5,
        direction: "IN",
        reasonType: "OPENING",
        userId: distributorB.id,
      })
    ).rejects.toBeInstanceOf(inventory.InventoryValidationError);
  });
});
