const { Sequelize, DataTypes } = require("sequelize");
const dbConfig = require("../config/db.config");

const sequelize = new Sequelize(dbConfig.DB, dbConfig.USER, dbConfig.PASSWORD, {
  host: dbConfig.HOST,
  port: dbConfig.PORT,
  dialect: dbConfig.dialect,
  storage: dbConfig.storage, // used only by sqlite (test environment)
  logging: false, // cleaner console
});

const db = {};

// Sequelize references
db.Sequelize = Sequelize;
db.sequelize = sequelize;

// ===================== MODELS ===================== //
db.Distributor = require("./distributor.model")(sequelize, DataTypes);
// Admin portal identity (Phase 3) — separate from Distributor
db.AdminUser = require("./adminuser.model")(sequelize, DataTypes);
// SAP synchronisation status of sales documents (Phase 4) — structure only, nothing transmits to SAP yet
db.SapSyncRecord = require("./sapsyncrecord.model")(sequelize, DataTypes);
// ERP / SAP integration foundation (Phase 13) — connections, capabilities, field mappings. Configuration only; no synchronisation yet
db.ErpConnection = require("./erpconnection.model")(sequelize, DataTypes);
db.ErpConnectionCapability = require("./erpconnectioncapability.model")(sequelize, DataTypes);
db.ErpEntityMapping = require("./erpentitymapping.model")(sequelize, DataTypes);
// Generic ERP sync (Phase 14) — jobs, per-record errors, external-identity links (idempotency)
db.ErpSyncJob = require("./erpsyncjob.model")(sequelize, DataTypes);
db.ErpSyncError = require("./erpsyncerror.model")(sequelize, DataTypes);
db.ErpExternalLink = require("./erpexternallink.model")(sequelize, DataTypes);
// Phase 15 — recurring sync schedules (the scheduler creates jobs from these; it never runs a sync itself)
db.ErpSyncSchedule = require("./erpsyncschedule.model")(sequelize, DataTypes);
// Phase 16 — persistent append-only audit trail + outbound (DMS → ERP) events
db.ErpAuditEvent = require("./erpauditevent.model")(sequelize, DataTypes);
db.ErpOutboundEvent = require("./erpoutboundevent.model")(sequelize, DataTypes);
db.Product = require("./product.model")(sequelize, DataTypes);
// db.Stock = require("./stock.model")(sequelize, DataTypes);
db.Customer = require("./customer.model")(sequelize, DataTypes);
db.Address = require("./address.model")(sequelize, DataTypes);
db.Batch = require("./Batch")(sequelize, DataTypes);
db.SalesOrderHeader = require("./salesorderheader.model")(sequelize, DataTypes);
db.SalesOrderLine = require("./salesorderline.model")(sequelize, DataTypes);
db.SalesDeliveryHeader = require("./salesdeliveryheader.model")(sequelize, DataTypes);
db.SalesDeliveryLine = require("./salesdeliveryline.model")(sequelize, DataTypes);
db.SalesInvoiceHeader = require("./salesinvoiceheader.model")(sequelize, DataTypes);
db.SalesInvoiceLine = require("./salesinvoiceline.model")(sequelize, DataTypes);
db.SalesCreditNote = require("./salescreditnote.model")(sequelize, DataTypes);
db.SalesCreditNoteLine = require("./salescreditnoteline.model")(sequelize, DataTypes);
db.SalesDebitNote = require("./salesdebitnote.model")(sequelize, DataTypes);
db.SalesReturn = require("./salesreturn.model")(sequelize, DataTypes);
db.SalesReturnLine = require("./salesreturnline.model")(sequelize, DataTypes);
db.PurchaseReturn = require("./purchasereturn.model")(sequelize, DataTypes);
db.PurchaseReturnLine = require("./purchasereturnline.model")(sequelize, DataTypes);
db.PurchaseDebitNote = require("./purchasedebitnote.model")(sequelize, DataTypes);
db.Vendor = require("./vendor.model")(sequelize, DataTypes);
db.PurchaseOrderHeader = require("./purchaseorderheader.model")(sequelize, DataTypes);
db.PurchaseOrderLine = require("./purchaseorderline.model")(sequelize, DataTypes);
db.PurchaseDeliveryHeader = require("./purchasedeliveryheader.model")(sequelize, DataTypes);
db.PurchaseDeliveryLine = require("./purchasedeliveryline.model")(sequelize, DataTypes);
db.PurchaseInvoiceHeader = require("./purchaseinvoiceheader.model")(sequelize, DataTypes);
db.PurchaseInvoiceLine = require("./purchaseinvoiceline.model")(sequelize, DataTypes);
db.JournalEntry = require("./journalentry.model")(sequelize, DataTypes);
db.GLMaster = require("./glmaster.model")(sequelize, DataTypes);
db.StockLedger = require("./stockledger.model")(sequelize, DataTypes);
db.PricingMaster = require("./pricingmaster.model")(sequelize, DataTypes);
db.CustomerGroup = require("./customergroup.model")(sequelize, DataTypes);
db.VendorGroup = require("./vendorgroup.model")(sequelize, DataTypes);
db.ItemGroup = require("./itemgroup.model")(sequelize, DataTypes);
db.HSNGroup = require("./hsngroup.model")(sequelize, DataTypes);
// Inventory & Batch Management (Phase 5) — warehouses and the stock-transfer foundation
db.Warehouse = require("./warehouse.model")(sequelize, DataTypes);
db.StockTransfer = require("./stocktransfer.model")(sequelize, DataTypes);

// Scheme Engine (Phase 10) — Admin-configured schemes + applicability link tables
{
  const m = require("./scheme.model")(sequelize, DataTypes);
  db.Scheme = m.Scheme;
  db.SchemeProduct = m.SchemeProduct;
  db.SchemeDistributor = m.SchemeDistributor;
  db.SchemeRetailer = m.SchemeRetailer;
}

// Claims (Phase 11) — scheme claims, items and an append-only status history
{
  const m = require("./claim.model")(sequelize, DataTypes);
  db.Claim = m.Claim;
  db.ClaimItem = m.ClaimItem;
  db.ClaimStatusHistory = m.ClaimStatusHistory;
}

// Accounts & Financial Management (Phase 12) — payments and their optional invoice-level allocation
{
  const m = require("./payment.model")(sequelize, DataTypes);
  db.Payment = m.Payment;
  db.PaymentAllocation = m.PaymentAllocation;
  db.PAYMENT_MODES = m.PAYMENT_MODES;
}


// ===================== RELATIONSHIPS ===================== //

// Distributor ↔ Product
db.Distributor.hasMany(db.Product, { foreignKey: "distributor_id", as: "products", onDelete: "CASCADE" });
db.Product.belongsTo(db.Distributor, { foreignKey: "distributor_id", as: "distributor" });

// // Product ↔ Stock
// db.Product.hasMany(db.Stock, { foreignKey: "productId", as: "stocks", onDelete: "CASCADE" });
// db.Stock.belongsTo(db.Product, { foreignKey: "productId", as: "product" });

// Product ↔ Batch
db.Product.hasMany(db.Batch, { foreignKey: "productId", as: "batches", onDelete: "CASCADE" });
db.Batch.belongsTo(db.Product, { foreignKey: "productId", as: "product" });

// Distributor ↔ Customer
db.Distributor.hasMany(db.Customer, { foreignKey: "distributor_id", as: "customers", onDelete: "CASCADE" });
db.Customer.belongsTo(db.Distributor, { foreignKey: "distributor_id", as: "distributor" });

// ===================== CUSTOMER ↔ ADDRESS ===================== //
db.Customer.hasMany(db.Address, { foreignKey: "customer_id", as: "addresses", onDelete: "CASCADE" });
db.Address.belongsTo(db.Customer, { foreignKey: "customer_id", as: "customer" });

// One-to-one aliases for different address types
db.Customer.hasOne(db.Address, { foreignKey: "customer_id", as: "soldToParty", scope: { type: "sold_to_party" } });
db.Customer.hasOne(db.Address, { foreignKey: "customer_id", as: "shipToParty", scope: { type: "ship_to_party" } });
db.Customer.hasOne(db.Address, { foreignKey: "customer_id", as: "billToParty", scope: { type: "bill_to_party" } });
db.Customer.hasOne(db.Address, { foreignKey: "customer_id", as: "payer", scope: { type: "payer" } });

// Reverse mappings for includes
// db.Address.belongsTo(db.Customer, { foreignKey: "customer_id", as: "soldToParty" });
// db.Address.belongsTo(db.Customer, { foreignKey: "customer_id", as: "shipToParty" });
// db.Address.belongsTo(db.Customer, { foreignKey: "customer_id", as: "billToParty" });
// db.Address.belongsTo(db.Customer, { foreignKey: "customer_id", as: "payer" });

// ===================== SALES ORDER ===================== //
// Customer ↔ SalesOrderHeader
db.Customer.hasMany(db.SalesOrderHeader, { foreignKey: "customerId", as: "salesOrders", onDelete: "CASCADE" });
db.SalesOrderHeader.belongsTo(db.Customer, { foreignKey: "customerId", as: "customer" });

// Distributor ↔ SalesOrderHeader
db.Distributor.hasMany(db.SalesOrderHeader, { foreignKey: "distributor_id", as: "salesOrdersByDistributor", onDelete: "CASCADE" });
db.SalesOrderHeader.belongsTo(db.Distributor, { foreignKey: "distributor_id", as: "distributor" });

// SalesOrderHeader ↔ SalesOrderLine
db.SalesOrderHeader.hasMany(db.SalesOrderLine, { foreignKey: "orderId", as: "lines", onDelete: "CASCADE" });
db.SalesOrderLine.belongsTo(db.SalesOrderHeader, { foreignKey: "orderId", as: "order" });

// SalesOrderLine ↔ Product
db.Product.hasMany(db.SalesOrderLine, { foreignKey: "productId", as: "salesOrderLines" });
db.SalesOrderLine.belongsTo(db.Product, { foreignKey: "productId", as: "product" });

// SalesOrderLine ↔ Batch
db.Batch.hasMany(db.SalesOrderLine, { foreignKey: "batchId", as: "salesOrderLines" });
db.SalesOrderLine.belongsTo(db.Batch, { foreignKey: "batchId", as: "batch" });

// ===================== SALES DELIVERY ===================== //
db.SalesOrderHeader.hasMany(db.SalesDeliveryHeader, { foreignKey: "orderId", as: "deliveries", onDelete: "CASCADE" });
db.SalesDeliveryHeader.belongsTo(db.SalesOrderHeader, { foreignKey: "orderId", as: "order" });

db.SalesDeliveryHeader.hasMany(db.SalesDeliveryLine, { foreignKey: "deliveryId", as: "lines", onDelete: "CASCADE" });
db.SalesDeliveryLine.belongsTo(db.SalesDeliveryHeader, { foreignKey: "deliveryId", as: "delivery" });

db.SalesDeliveryLine.belongsTo(db.Product, { foreignKey: "productId", as: "product" });
db.Product.hasMany(db.SalesDeliveryLine, { foreignKey: "productId", as: "deliveryLines" });

// ===================== SALES INVOICE ===================== //
// Delivery ↔ InvoiceHeader
db.SalesDeliveryHeader.hasMany(db.SalesInvoiceHeader, { foreignKey: "deliveryId", as: "invoicesByDelivery", onDelete: "CASCADE" });
db.SalesInvoiceHeader.belongsTo(db.SalesDeliveryHeader, { foreignKey: "deliveryId", as: "delivery" });

// Distributor ↔ InvoiceHeader
db.Distributor.hasMany(db.SalesInvoiceHeader, { foreignKey: "distributor_id", as: "invoicesByDistributor" });
db.SalesInvoiceHeader.belongsTo(db.Distributor, { foreignKey: "distributor_id", as: "distributor" });

// Customer ↔ InvoiceHeader
db.Customer.hasMany(db.SalesInvoiceHeader, { foreignKey: "customer_id", as: "invoicesByCustomer" });
db.SalesInvoiceHeader.belongsTo(db.Customer, { foreignKey: "customer_id", as: "customer" });

// InvoiceHeader ↔ Lines
db.SalesInvoiceHeader.hasMany(db.SalesInvoiceLine, { foreignKey: "invoiceId", as: "lines", onDelete: "CASCADE" });
db.SalesInvoiceLine.belongsTo(db.SalesInvoiceHeader, { foreignKey: "invoiceId", as: "invoice" });

// Product ↔ InvoiceLine
db.Product.hasMany(db.SalesInvoiceLine, { foreignKey: "productId", as: "invoiceLines" });
db.SalesInvoiceLine.belongsTo(db.Product, { foreignKey: "productId", as: "product" });

// Credit & Debit Notes
db.SalesInvoiceHeader.hasMany(db.SalesCreditNote, { foreignKey: "invoiceId", as: "creditNotes", onDelete: "CASCADE" });
db.SalesCreditNote.belongsTo(db.SalesInvoiceHeader, { foreignKey: "invoiceId", as: "invoice" });

db.SalesInvoiceHeader.hasMany(db.SalesDebitNote, { foreignKey: "invoiceId", as: "debitNotes", onDelete: "CASCADE" });
db.SalesDebitNote.belongsTo(db.SalesInvoiceHeader, { foreignKey: "invoiceId", as: "invoice" });

db.SalesCreditNote.belongsTo(db.Customer, { foreignKey: "customerId", as: "customer" });
db.SalesDebitNote.belongsTo(db.Customer, { foreignKey: "customerId", as: "customer" });

db.SalesCreditNote.hasMany(db.SalesCreditNoteLine, { foreignKey: "creditNoteId", as: "lines", onDelete: "CASCADE" });
db.SalesCreditNoteLine.belongsTo(db.SalesCreditNote, { foreignKey: "creditNoteId", as: "creditNote" });
db.SalesCreditNoteLine.belongsTo(db.Product, { foreignKey: "productId", as: "product" });
db.SalesCreditNoteLine.belongsTo(db.Batch, { foreignKey: "batchId", as: "batch" });
db.SalesCreditNoteLine.belongsTo(db.SalesInvoiceLine, { foreignKey: "invoiceLineId", as: "invoiceLine" });

// ----- Sales Return -----
db.SalesInvoiceHeader.hasMany(db.SalesReturn, { foreignKey: "invoiceId", as: "returns" });
db.SalesReturn.belongsTo(db.SalesInvoiceHeader, { foreignKey: "invoiceId", as: "invoice" });
db.SalesReturn.belongsTo(db.Customer, { foreignKey: "customerId", as: "customer" });
db.SalesReturn.belongsTo(db.SalesCreditNote, { foreignKey: "creditNoteId", as: "creditNote" });
db.SalesReturn.hasMany(db.SalesReturnLine, { foreignKey: "returnId", as: "lines", onDelete: "CASCADE" });
db.SalesReturnLine.belongsTo(db.SalesReturn, { foreignKey: "returnId", as: "return" });
db.SalesReturnLine.belongsTo(db.Product, { foreignKey: "productId", as: "product" });
db.SalesReturnLine.belongsTo(db.Batch, { foreignKey: "batchId", as: "batch" });
db.SalesReturnLine.belongsTo(db.SalesInvoiceLine, { foreignKey: "invoiceLineId", as: "invoiceLine" });

// ----- Purchase Return / Purchase Debit Note -----
db.PurchaseInvoiceHeader.hasMany(db.PurchaseReturn, { foreignKey: "invoiceId", as: "returns" });
db.PurchaseReturn.belongsTo(db.PurchaseInvoiceHeader, { foreignKey: "invoiceId", as: "invoice" });
db.PurchaseReturn.belongsTo(db.Vendor, { foreignKey: "vendor_id", as: "vendor" });
db.PurchaseReturn.belongsTo(db.PurchaseDebitNote, { foreignKey: "debitNoteId", as: "debitNote" });
db.PurchaseReturn.hasMany(db.PurchaseReturnLine, { foreignKey: "returnId", as: "lines", onDelete: "CASCADE" });
db.PurchaseReturnLine.belongsTo(db.PurchaseReturn, { foreignKey: "returnId", as: "return" });
db.PurchaseReturnLine.belongsTo(db.Product, { foreignKey: "productId", as: "product" });
db.PurchaseReturnLine.belongsTo(db.Batch, { foreignKey: "batchId", as: "batch" });
db.PurchaseReturnLine.belongsTo(db.PurchaseInvoiceLine, { foreignKey: "invoiceLineId", as: "invoiceLine" });

db.PurchaseInvoiceHeader.hasMany(db.PurchaseDebitNote, { foreignKey: "invoiceId", as: "debitNotes" });
db.PurchaseDebitNote.belongsTo(db.PurchaseInvoiceHeader, { foreignKey: "invoiceId", as: "invoice" });
db.PurchaseDebitNote.belongsTo(db.Vendor, { foreignKey: "vendor_id", as: "vendor" });

// // ===================== VENDOR RELATIONS ===================== //
// db.Distributor.hasMany(db.Vendor, { foreignKey: "distributor_id", as: "vendors", onDelete: "CASCADE" });
// db.Vendor.belongsTo(db.Distributor, { foreignKey: "distributor_id", as: "distributor" });

// // Vendor ↔ Invoice (purchase invoices)
// db.Vendor.hasMany(db.SalesInvoiceHeader, { foreignKey: "vendor_id", as: "purchaseInvoices" });
// db.SalesInvoiceHeader.belongsTo(db.Vendor, { foreignKey: "vendor_id", as: "vendor" });


// ===================== PURCHASE ORDER ===================== //

// Distributor ↔ PurchaseOrderHeader
db.Distributor.hasMany(db.PurchaseOrderHeader, { foreignKey: "distributor_id", as: "purchaseOrdersByDistributor", onDelete: "CASCADE" });
db.PurchaseOrderHeader.belongsTo(db.Distributor, { foreignKey: "distributor_id", as: "distributor" });

// Vendor ↔ PurchaseOrderHeader
db.Vendor.hasMany(db.PurchaseOrderHeader, { foreignKey: "vendorId", as: "purchaseOrdersByVendor", onDelete: "CASCADE" });
db.PurchaseOrderHeader.belongsTo(db.Vendor, { foreignKey: "vendorId", as: "vendor" });

// PurchaseOrderHeader ↔ PurchaseOrderLine
db.PurchaseOrderHeader.hasMany(db.PurchaseOrderLine, { foreignKey: "orderId", as: "lines", onDelete: "CASCADE" });
db.PurchaseOrderLine.belongsTo(db.PurchaseOrderHeader, { foreignKey: "orderId", as: "order" });

// Product ↔ PurchaseOrderLine
db.Product.hasMany(db.PurchaseOrderLine, { foreignKey: "productId", as: "purchaseOrderLines" });
db.PurchaseOrderLine.belongsTo(db.Product, { foreignKey: "productId", as: "product" });

// Batch ↔ PurchaseOrderLine


// ===================== VENDOR RELATIONS ===================== //
db.Distributor.hasMany(db.Vendor, { foreignKey: "distributor_id", as: "vendors", onDelete: "CASCADE" });
db.Vendor.belongsTo(db.Distributor, { foreignKey: "distributor_id", as: "distributor" });

// ===================== VENDOR ↔ ADDRESS ===================== //
db.Vendor.hasMany(db.Address, { foreignKey: "vendor_id", as: "addresses", onDelete: "CASCADE" });
db.Address.belongsTo(db.Vendor, { foreignKey: "vendor_id", as: "vendor" });

// ===================== PURCHASE DELIVERY ===================== //
db.PurchaseOrderHeader.hasMany(db.PurchaseDeliveryHeader, {
  foreignKey: "orderId",
  as: "deliveries",
  onDelete: "CASCADE",
});
db.PurchaseDeliveryHeader.belongsTo(db.PurchaseOrderHeader, {
  foreignKey: "orderId",
  as: "order",
});

db.PurchaseDeliveryHeader.hasMany(db.PurchaseDeliveryLine, {
  foreignKey: "deliveryId",
  as: "lines",
  onDelete: "CASCADE",
});
db.PurchaseDeliveryLine.belongsTo(db.PurchaseDeliveryHeader, {
  foreignKey: "deliveryId",
  as: "delivery",
});

db.Product.hasMany(db.PurchaseDeliveryLine, {
  foreignKey: "productId",
  as: "purchaseDeliveryLines",
});
db.PurchaseDeliveryLine.belongsTo(db.Product, {
  foreignKey: "productId",
  as: "product",
});

// Batch ↔ PurchaseDeliveryLine (MISSING — added Phase 4: without this,
// GET /po-delivery and GET /po-delivery/:id threw at runtime every time,
// since the controller's `include: ["product", "batch"]` shorthand
// requires a real "batch" alias to exist).
db.Batch.hasMany(db.PurchaseDeliveryLine, {
  foreignKey: "batchId",
  as: "purchaseDeliveryLines",
});
db.PurchaseDeliveryLine.belongsTo(db.Batch, {
  foreignKey: "batchId",
  as: "batch",
});

// ===================== PURCHASE DELIVERY (MISSING ASSOCIATION FIX) ===================== //
db.Vendor.hasMany(db.PurchaseDeliveryHeader, {
  foreignKey: "vendor_id",
  as: "purchaseDeliveries",
  onDelete: "CASCADE",
});
db.PurchaseDeliveryHeader.belongsTo(db.Vendor, {
  foreignKey: "vendor_id",
  as: "vendor",
});



db.PurchaseDeliveryHeader.hasMany(db.PurchaseInvoiceHeader, { foreignKey: "deliveryId", as: "purchaseInvoices", onDelete: "CASCADE" });
db.PurchaseInvoiceHeader.belongsTo(db.PurchaseDeliveryHeader, { foreignKey: "deliveryId", as: "delivery" });

db.PurchaseInvoiceHeader.hasMany(db.PurchaseInvoiceLine, { foreignKey: "invoiceId", as: "lines", onDelete: "CASCADE" });
db.PurchaseInvoiceLine.belongsTo(db.PurchaseInvoiceHeader, { foreignKey: "invoiceId", as: "invoice" });
db.PurchaseInvoiceLine.belongsTo(db.Product, { foreignKey: "productId", as: "product" });

db.Distributor.hasMany(db.PurchaseInvoiceHeader, { foreignKey: "distributor_id", as: "purchaseInvoices" });
db.PurchaseInvoiceHeader.belongsTo(db.Distributor, { foreignKey: "distributor_id", as: "distributor" });

db.Vendor.hasMany(db.PurchaseInvoiceHeader, { foreignKey: "vendor_id", as: "vendorInvoices" });
db.PurchaseInvoiceHeader.belongsTo(db.Vendor, { foreignKey: "vendor_id", as: "vendor" });


db.Customer.hasMany(db.JournalEntry, { foreignKey: "customer_id", as: "customerLedger" });
db.JournalEntry.belongsTo(db.Customer, { foreignKey: "customer_id", as: "customer" });

db.Vendor.hasMany(db.JournalEntry, { foreignKey: "vendor_id", as: "vendorLedger" });
db.JournalEntry.belongsTo(db.Vendor, { foreignKey: "vendor_id", as: "vendor" });


// GL ↔ Journal
db.GLMaster.hasMany(db.JournalEntry, { foreignKey: "gl_id", as: "journalEntries" });
db.JournalEntry.belongsTo(db.GLMaster, { foreignKey: "gl_id", as: "gl" });


db.Batch.hasMany(db.StockLedger, { foreignKey: "batchId", as: "movements" });
db.StockLedger.belongsTo(db.Batch, { foreignKey: "batchId", as: "batch" });

db.Product.hasMany(db.StockLedger, { foreignKey: "productId", as: "stockMovements" });
db.StockLedger.belongsTo(db.Product, { foreignKey: "productId", as: "product" });

// Customer ↔ CustomerGroup
db.Customer.belongsTo(db.CustomerGroup, {
  foreignKey: "customer_group_id",
  as: "group",
});

db.Vendor.belongsTo(db.VendorGroup, {
  foreignKey: "vendor_group",
  targetKey: "code",
  as: "group",
  constraints: false, // `code` is only unique per (code, distributor_id), not globally — see note below
});
db.Product.belongsTo(db.ItemGroup, {
  foreignKey: "item_group",
  targetKey: "code",
  as: "group",
  constraints: false, // `code` is only unique per (code, distributor_id), not globally — see note below
});

db.Product.belongsTo(db.HSNGroup, {
  foreignKey: "hsn_id",
  as: "hsn"
});

db.Product.hasMany(db.PricingMaster, {
  foreignKey: "productId",
  as: "pricing",
});

db.PricingMaster.belongsTo(db.Product, {
  foreignKey: "productId",
  as: "product",
});

db.CustomerGroup.hasMany(db.PricingMaster, {
  foreignKey: "customer_group_id",
  as: "pricing"
});

db.PricingMaster.belongsTo(db.CustomerGroup, {
  foreignKey: "customer_group_id",
  as: "customerGroup"
});

// Warehouse (Phase 5): owned by a distributor; ledger rows and transfers reference it.
db.Distributor.hasMany(db.Warehouse, { foreignKey: "distributor_id", as: "warehouses" });
db.Warehouse.belongsTo(db.Distributor, { foreignKey: "distributor_id", as: "distributor" });
db.StockLedger.belongsTo(db.Warehouse, { foreignKey: "warehouse_id", as: "warehouse", constraints: false });
db.StockTransfer.belongsTo(db.Warehouse, { foreignKey: "from_warehouse_id", as: "fromWarehouse", constraints: false });
db.StockTransfer.belongsTo(db.Warehouse, { foreignKey: "to_warehouse_id", as: "toWarehouse", constraints: false });
db.StockTransfer.belongsTo(db.Product, { foreignKey: "productId", as: "product", constraints: false });
db.StockTransfer.belongsTo(db.Batch, { foreignKey: "batchId", as: "batch", constraints: false });

// ERP connections (Phase 13): one connection has many capabilities and many field mappings
db.ErpConnection.hasMany(db.ErpConnectionCapability, { foreignKey: "connection_id", as: "capabilities" });
db.ErpConnectionCapability.belongsTo(db.ErpConnection, { foreignKey: "connection_id", as: "connection" });
db.ErpConnection.hasMany(db.ErpEntityMapping, { foreignKey: "connection_id", as: "mappings" });
db.ErpEntityMapping.belongsTo(db.ErpConnection, { foreignKey: "connection_id", as: "connection" });

db.ErpConnection.hasMany(db.ErpSyncJob, { foreignKey: "connection_id", as: "syncJobs" });
db.ErpSyncJob.belongsTo(db.ErpConnection, { foreignKey: "connection_id", as: "connection" });
db.ErpSyncJob.hasMany(db.ErpSyncError, { foreignKey: "job_id", as: "errors" });
db.ErpSyncError.belongsTo(db.ErpSyncJob, { foreignKey: "job_id", as: "job" });

// ===================== EXPORT ===================== //
module.exports = db;
