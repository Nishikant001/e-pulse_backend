process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const db = require("../models");

/**
 * Recreate a fresh in-memory sqlite schema before each test so tests never
 * leak state into one another.
 */
async function resetDb() {
  await db.sequelize.sync({ force: true });
}

function mockRes() {
  const res = {};
  res.statusCode = 200;
  res.status = jest.fn((code) => {
    res.statusCode = code;
    return res;
  });
  res.jsonBody = null;
  res.json = jest.fn((body) => {
    res.jsonBody = body;
    return res;
  });
  // Admin controllers (e.g. admin.masters.controller.js, admin.inventory.controller.js) call res.set(...) to
  // disable caching before every response — a harmless no-op here, matching Express's own res.set signature.
  res.set = jest.fn(() => res);
  return res;
}

let distributorSeq = 0;
async function seedDistributor(overrides = {}) {
  distributorSeq += 1;
  return db.Distributor.create({
    name: `Distributor ${distributorSeq}`,
    email: `distributor${distributorSeq}@test.com`,
    password: "hashed",
    distributor_code: `DTC${String(distributorSeq).padStart(3, "0")}`,
    ...overrides,
  });
}

let productSeq = 0;
async function seedProduct(distributorId, overrides = {}) {
  productSeq += 1;
  const hsn = await db.HSNGroup.create({
    hsn_code: `HSN${productSeq}`,
    description: "Test HSN",
    gst_rate: 12,
    distributor_id: distributorId,
  });
  return db.Product.create({
    name: `Product ${productSeq}`,
    unit: "PCS",
    hsn_id: hsn.id,
    distributor_id: distributorId,
    reorder_level: 10,
    ...overrides,
  });
}

let batchSeq = 0;
async function seedBatch(distributorId, productId, overrides = {}) {
  batchSeq += 1;
  return db.Batch.create({
    batch_no: `BATCH-${batchSeq}`,
    distributor_id: distributorId,
    productId,
    status: "active",
    ...overrides,
  });
}

let customerSeq = 0;
async function seedCustomer(distributorId, overrides = {}) {
  customerSeq += 1;
  const group = await db.CustomerGroup.create({
    code: `GRP${customerSeq}`,
    name: "Retail",
    distributor_id: distributorId,
  });
  return db.Customer.create({
    name: `Customer ${customerSeq}`,
    distributor_id: distributorId,
    customer_group_id: group.id,
    ...overrides,
  });
}

let vendorSeq = 0;
async function seedVendor(distributorId, overrides = {}) {
  vendorSeq += 1;
  return db.Vendor.create({
    name: `Vendor ${vendorSeq}`,
    vendor_group: "GENERAL",
    distributor_id: distributorId,
    ...overrides,
  });
}

async function seedPurchaseOrder(distributor, { productId, quantity = 100, pricePerUnit = 10, status = "CONFIRMED" }) {
  const vendor = await seedVendor(distributor.id);
  const order = await db.PurchaseOrderHeader.create({
    orderDate: new Date(),
    vendorId: vendor.id,
    distributor_id: distributor.id,
    order_number: `${distributor.distributor_code}-PO-${Date.now()}-${Math.random()}`,
    distributor_code: distributor.distributor_code,
    status,
  });
  await db.PurchaseOrderLine.create({
    orderId: order.id,
    productId,
    material_code: "MTC001",
    quantity,
    pricePerUnit,
    lineNetValue: quantity * pricePerUnit,
  });
  return db.PurchaseOrderHeader.findByPk(order.id, {
    include: [{ model: db.PurchaseOrderLine, as: "lines" }],
  });
}

async function seedPricing(distributor, product, customerGroupId, { basePrice = 20, discountPercent = 0 } = {}) {
  return db.PricingMaster.create({
    productId: product.id,
    customer_group_id: customerGroupId,
    distributor_id: distributor.id,
    base_price: basePrice,
    discount_percent: discountPercent,
    valid_from: new Date("2020-01-01"),
    valid_to: null,
  });
}

async function seedGLAccounts(distributor) {
  const names = [
    ["Accounts Receivable", "asset"],
    ["Sales", "income"],
    ["Output GST", "liability"],
    ["Purchase", "expense"],
    ["Accounts Payable", "liability"],
    ["Input GST", "asset"],
    ["Cash/Bank", "asset"],
  ];
  for (const [gl_name, gl_type] of names) {
    const existing = await db.GLMaster.findOne({ where: { gl_name, distributor_code: distributor.distributor_code } });
    if (!existing) {
      await db.GLMaster.create({ gl_name, gl_type, distributor_code: distributor.distributor_code });
    }
  }
}

async function seedSalesOrder(distributor, { productId, batchId = null, quantity = 10, pricePerUnit = 20, status = "DRAFT" }) {
  const customer = await seedCustomer(distributor.id);
  const order = await db.SalesOrderHeader.create({
    orderDate: new Date(),
    customerId: customer.id,
    distributor_id: distributor.id,
    order_number: `${distributor.distributor_code}-SO-${Date.now()}-${Math.random()}`,
    distributor_code: distributor.distributor_code,
    customerName: customer.name,
    status,
  });
  await db.SalesOrderLine.create({
    orderId: order.id,
    productId,
    batchId,
    material_code: "MTC001",
    quantity,
    pricePerUnit,
    discount: 0,
    lineNetValue: quantity * pricePerUnit,
  });
  return db.SalesOrderHeader.findByPk(order.id, {
    include: [{ model: db.SalesOrderLine, as: "lines" }],
  });
}

module.exports = {
  db,
  resetDb,
  mockRes,
  seedDistributor,
  seedProduct,
  seedBatch,
  seedCustomer,
  seedVendor,
  seedPurchaseOrder,
  seedSalesOrder,
  seedPricing,
  seedGLAccounts,
};
