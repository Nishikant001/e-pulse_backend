const inventory = require("../services/inventory.service");
const {
  db,
  resetDb,
  seedDistributor,
  seedProduct,
  seedBatch,
} = require("./helpers");

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await db.sequelize.close();
});

describe("inventory.service — FEFO allocation", () => {
  test("allocates earliest-expiry batch first, splitting across batches as needed", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);

    const batchA = await seedBatch(distributor.id, product.id, {
      batch_no: "A",
      exp_date: new Date("2027-01-01"),
    });
    const batchB = await seedBatch(distributor.id, product.id, {
      batch_no: "B",
      exp_date: new Date("2028-01-01"),
    });

    await inventory.postMovement({
      distributorId: distributor.id,
      productId: product.id,
      batchId: batchA.id,
      movementType: "IN",
      quantity: 100,
      referenceType: "OPENING",
    });
    await inventory.postMovement({
      distributorId: distributor.id,
      productId: product.id,
      batchId: batchB.id,
      movementType: "IN",
      quantity: 200,
      referenceType: "OPENING",
    });

    const allocations = await inventory.allocateStock({
      productId: product.id,
      distributorId: distributor.id,
      quantity: 150,
    });

    expect(allocations).toEqual([
      { batchId: batchA.id, quantity: 100 },
      { batchId: batchB.id, quantity: 50 },
    ]);
  });

  test("excludes expired batches from FEFO allocation", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);

    const expired = await seedBatch(distributor.id, product.id, {
      batch_no: "EXPIRED",
      exp_date: new Date("2020-01-01"), // in the past
    });
    const valid = await seedBatch(distributor.id, product.id, {
      batch_no: "VALID",
      exp_date: new Date("2030-01-01"),
    });

    await inventory.postMovement({
      distributorId: distributor.id,
      productId: product.id,
      batchId: expired.id,
      movementType: "IN",
      quantity: 50,
      referenceType: "OPENING",
    });
    await inventory.postMovement({
      distributorId: distributor.id,
      productId: product.id,
      batchId: valid.id,
      movementType: "IN",
      quantity: 50,
      referenceType: "OPENING",
    });

    const allocations = await inventory.allocateStock({
      productId: product.id,
      distributorId: distributor.id,
      quantity: 20,
    });

    // Must come entirely from the valid batch, never the expired one
    expect(allocations).toEqual([{ batchId: valid.id, quantity: 20 }]);
  });

  test("excludes inactive batches from FEFO allocation", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);

    const inactive = await seedBatch(distributor.id, product.id, {
      batch_no: "INACTIVE",
      status: "inactive",
      exp_date: new Date("2030-01-01"),
    });
    const active = await seedBatch(distributor.id, product.id, {
      batch_no: "ACTIVE",
      exp_date: new Date("2031-01-01"),
    });

    await inventory.postMovement({
      distributorId: distributor.id,
      productId: product.id,
      batchId: inactive.id,
      movementType: "IN",
      quantity: 50,
      referenceType: "OPENING",
    });
    await inventory.postMovement({
      distributorId: distributor.id,
      productId: product.id,
      batchId: active.id,
      movementType: "IN",
      quantity: 30,
      referenceType: "OPENING",
    });

    const allocations = await inventory.allocateStock({
      productId: product.id,
      distributorId: distributor.id,
      quantity: 30,
    });

    expect(allocations).toEqual([{ batchId: active.id, quantity: 30 }]);
  });

  test("throws InsufficientStockError when total available is less than requested", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const batch = await seedBatch(distributor.id, product.id, { exp_date: new Date("2030-01-01") });

    await inventory.postMovement({
      distributorId: distributor.id,
      productId: product.id,
      batchId: batch.id,
      movementType: "IN",
      quantity: 5,
      referenceType: "OPENING",
    });

    await expect(
      inventory.allocateStock({ productId: product.id, distributorId: distributor.id, quantity: 10 })
    ).rejects.toBeInstanceOf(inventory.InsufficientStockError);
  });

  test("manual batch selection uses only the specified batch", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const earlier = await seedBatch(distributor.id, product.id, { exp_date: new Date("2027-01-01") });
    const later = await seedBatch(distributor.id, product.id, { exp_date: new Date("2028-01-01") });

    await inventory.postMovement({
      distributorId: distributor.id, productId: product.id, batchId: earlier.id,
      movementType: "IN", quantity: 100, referenceType: "OPENING",
    });
    await inventory.postMovement({
      distributorId: distributor.id, productId: product.id, batchId: later.id,
      movementType: "IN", quantity: 100, referenceType: "OPENING",
    });

    // Explicitly choose the LATER batch even though FEFO would pick `earlier`
    const allocations = await inventory.allocateStock({
      productId: product.id,
      distributorId: distributor.id,
      quantity: 20,
      batchId: later.id,
    });

    expect(allocations).toEqual([{ batchId: later.id, quantity: 20 }]);
  });
});

describe("inventory.service — movement posting & idempotency", () => {
  test("duplicate movement for the same reference/line/batch/direction is rejected", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const batch = await seedBatch(distributor.id, product.id);

    const args = {
      distributorId: distributor.id,
      productId: product.id,
      batchId: batch.id,
      movementType: "IN",
      quantity: 10,
      referenceType: "PURCHASE",
      referenceId: 999,
      referenceLineId: 1,
    };

    await inventory.postMovement(args);
    await expect(inventory.postMovement(args)).rejects.toThrow();
  });

  test("negative stock is rejected by default", async () => {
    const distributor = await seedDistributor();
    const product = await seedProduct(distributor.id);
    const batch = await seedBatch(distributor.id, product.id);

    await expect(
      inventory.postMovement({
        distributorId: distributor.id,
        productId: product.id,
        batchId: batch.id,
        movementType: "OUT",
        quantity: 5,
        referenceType: "SALES",
      })
    ).rejects.toBeInstanceOf(inventory.InsufficientStockError);
  });

  test("cross-tenant batch access is rejected", async () => {
    const distributorA = await seedDistributor();
    const distributorB = await seedDistributor();
    const product = await seedProduct(distributorA.id);
    const batch = await seedBatch(distributorA.id, product.id);

    await expect(
      inventory.postMovement({
        distributorId: distributorB.id, // wrong tenant
        productId: product.id,
        batchId: batch.id,
        movementType: "IN",
        quantity: 5,
        referenceType: "OPENING",
      })
    ).rejects.toBeInstanceOf(inventory.InventoryValidationError);
  });
});
