const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth.middleware");
const multer = require("multer");

// File upload config
// Phase 17: explicit size / count limits for bulk-upload files (default 10 MB, one file). multer stores under a random name, never the client's file name.
// Phase 23: only spreadsheet/CSV files are accepted (by extension); anything else is skipped, so the controller answers its existing "Please upload …" 400.
const UPLOAD_EXT = /\.(xlsx|xls|csv)$/i;
const upload = multer({ dest: "uploads/", fileFilter: (req, file, cb) => cb(null, UPLOAD_EXT.test(file.originalname || "")), limits: { fileSize: Number(process.env.UPLOAD_MAX_BYTES) > 0 ? Number(process.env.UPLOAD_MAX_BYTES) : 10 * 1024 * 1024, files: 1 } });

// Controllers
const auth = require("../controllers/auth.controller");
const product = require("../controllers/product.controller");
const stock = require("../controllers/stock.controller");
const customer = require("../controllers/customer.controller");
const retailer = require("../controllers/retailer.controller");
const report = require("../controllers/report.controller");
const settings = require("../controllers/settings.controller");
const scheme = require("../controllers/scheme.controller");
const claim = require("../controllers/claim.controller");
const salesOrder = require("../controllers/salesOrder.controller");
// const delivery = require("../controllers/delivery.controller");
// const invoice = require("../controllers/invoice.controller");
const vendor = require("../controllers/vendor.controller");
const delivery = require("../controllers/salesdelivery.controller");
const invoice = require("../controllers/salesinvoice.controller");
const credit = require("../controllers/salescreditnote.controller");
const debit = require("../controllers/salesdebitnote.controller");
const salesReturn = require("../controllers/salesreturn.controller");
const purchaseReturn = require("../controllers/purchasereturn.controller");
const purchaseDebit = require("../controllers/purchasedebitnote.controller");
const purchaseOrderController = require("../controllers/purchaseorder.controller");
const podelivery = require("../controllers/purchasedelivery.controller");
const poinvoice = require("../controllers/purchaseinvoice.controller");
const ctrl = require("../controllers/accounting.controller");
const payment = require("../controllers/payment.controller");
const vendorPayment = require("../controllers/vendorpayment.controller");
const accountsView = require("../controllers/accounts.controller");
const gl = require("../controllers/glmaster.controller");
const stockLedger = require("../controllers/stockLedger.controller");
const inventoryCtrl = require("../controllers/inventory.controller");
const customergroup = require("../controllers/customergroup.controller");
const vendorgroup = require("../controllers/vendorgroup.controller");
const itemgroup = require("../controllers/itemgroup.controller");
const hsngroup = require("../controllers/hsngroup.controller");
const pricing = require("../controllers/pricingmaster.controller");

// ✅ Auth
// Phase 17: per-IP request-rate limit in front of every unauthenticated Distributor credential endpoint (login, sign-up, OTP, reset, refresh).
const { policies } = require("../middleware/rateLimiter");
router.post("/signup", policies.distributorAuth, auth.signup);
router.post("/login", policies.distributorAuth, auth.login);
router.post("/logout", auth.logout);
router.post("/refresh-token", policies.distributorAuth, auth.refreshToken);
router.post("/forgot-password", policies.distributorAuth, auth.forgotPassword);
router.post("/reset-password", policies.distributorAuth, auth.resetPassword);
router.post("/verify-otp", policies.distributorAuth, auth.verifyOtp);

// ✅ Product (Material)
router.post("/product", authMiddleware, product.create);
router.get("/product", authMiddleware, product.getAll);
router.get("/product/:id", authMiddleware, product.getOne);
router.put("/product/:id", authMiddleware, product.update);
router.delete("/product/:id", authMiddleware, product.delete);
router.post(
  "/product/bulk-upload",
  authMiddleware,
  upload.single("file"),
  authMiddleware,
  product.bulkUpload,
);

// ✅ stockLedger
router.post("/stockLedger/in", authMiddleware, stockLedger.stockIn);
router.post("/stockLedger/out", authMiddleware, stockLedger.stockOut);
// Preferred explicit endpoint for manual stock adjustments (damage,
// expiry, breakage, physical count, opening stock, correction). Purchase
// and Sales stock movements are posted automatically by their respective
// delivery controllers and are never created here.
router.post("/stockLedger/adjustment", authMiddleware, stockLedger.adjustStock);
router.get(
  "/stockLedger/current",
  authMiddleware,
  stockLedger.getCurrentStock,
);
router.get("/stockLedger/batch", authMiddleware, stockLedger.getBatchStock);
router.get("/stockLedger/ledger", authMiddleware, stockLedger.getStockLedger);
router.get(
  "/stockLedger/batch/:batchId",
  authMiddleware,
  stockLedger.getAvailableStockByBatch,
);

// ✅ Inventory & Batch Management (Phase 5). Tenant = the authenticated distributor; ids in the URL/query are re-checked against it.
router.get("/inventory/lookups", authMiddleware, inventoryCtrl.distributorReads.lookups);
router.get("/inventory/summary", authMiddleware, inventoryCtrl.distributorReads.summary);
router.get("/inventory/current", authMiddleware, inventoryCtrl.distributorReads.current);
router.get("/inventory/batches", authMiddleware, inventoryCtrl.distributorReads.batches);
router.get("/inventory/batches/:id", authMiddleware, inventoryCtrl.distributorReads.batchDetail);
router.get("/inventory/ledger", authMiddleware, inventoryCtrl.distributorReads.ledger);
router.get("/inventory/movement", authMiddleware, inventoryCtrl.distributorReads.movement);
router.get("/inventory/transfers", authMiddleware, inventoryCtrl.distributorReads.transfers);
// Phase 6 — FEFO & Expiry Management
router.get("/inventory/expiry-summary", authMiddleware, inventoryCtrl.distributorReads.expirySummary);
router.get("/inventory/fefo-preview", authMiddleware, inventoryCtrl.distributorReads.fefoPreview);
router.post("/inventory/transfers", authMiddleware, inventoryCtrl.createTransfer);
router.post("/inventory/non-saleable", authMiddleware, inventoryCtrl.changeSaleability);
router.post("/inventory/warehouses", authMiddleware, inventoryCtrl.createWarehouse);
router.put("/inventory/warehouses/:id", authMiddleware, inventoryCtrl.updateWarehouse);

// ✅ Stock
router.post("/stock", authMiddleware, stock.createBatch);
router.get("/stock", authMiddleware, stock.getAllBatches);
router.get("/stock/count", authMiddleware, stock.getBatchCountByDistributor);
router.get("/stock/:id", authMiddleware, stock.getBatchById);
router.put("/stock/:id", authMiddleware, stock.updateBatch);
router.delete("/stock/:id", authMiddleware, stock.deleteBatch);

router.get("/stock/bulk-upload", authMiddleware, stock.bulkUploadBatches);

// ✅ Customer
router.post("/customer", authMiddleware, customer.create);
router.get("/customer", authMiddleware, customer.getAll);
router.get("/customer/count", authMiddleware, customer.getCustomerCount);
router.get("/customer/:id", authMiddleware, customer.getOne);
router.put("/customer/:id", authMiddleware, customer.update);
router.delete("/customer/:id", authMiddleware, customer.delete);
// ✅ Settings (e-Pulse Phase 1) — Distributor portal. Own profile only; password change needs the current password and shares the auth rate limit.
router.get("/settings", authMiddleware, settings.get);
router.put("/settings/profile", authMiddleware, settings.updateProfile);
router.post("/settings/change-password", policies.distributorAuth, authMiddleware, settings.changePassword);
// ✅ Reports (e-Pulse Phase 1) — Distributor portal, READ-ONLY. Only GET routes exist; scope comes from the token.
router.get("/reports", authMiddleware, report.sections);
router.get("/reports/:section", authMiddleware, report.run);
// ✅ Retailer Management (Phase 9) — Distributor portal. Ownership is enforced in the service from the token; no assign/reassign route exists here.
router.get("/retailers/lookups", authMiddleware, retailer.lookups);
router.get("/retailers", authMiddleware, retailer.list);
router.post("/retailers", authMiddleware, retailer.create);
router.get("/retailers/:id", authMiddleware, retailer.get);
router.put("/retailers/:id", authMiddleware, retailer.update);
router.post("/retailers/:id/status", authMiddleware, retailer.setStatus);
// Phase 10 — Distributor: READ-ONLY scheme visibility/evaluation for its own products only. No write routes exist.
router.get("/schemes/applicable", authMiddleware, scheme.applicable);
router.post("/schemes/evaluate", authMiddleware, scheme.evaluate);
// Phase 11 — Distributor claims: own claims only (scope from the token). No review/approve/reject routes exist for distributors.
router.get("/claims/lookups", authMiddleware, claim.lookups);
router.get("/claims/invoices/:invoiceId/lines", authMiddleware, claim.invoiceLines);
router.get("/claims", authMiddleware, claim.list);
router.post("/claims", authMiddleware, claim.create);
router.get("/claims/:id", authMiddleware, claim.get);
router.put("/claims/:id", authMiddleware, claim.update);
router.post("/claims/:id/submit", authMiddleware, claim.submit);
router.post("/claims/:id/resubmit", authMiddleware, claim.resubmit);
// Phase 12 — Distributor financial view: READ-ONLY, own data only (scope from the token). No create/update handler exists here.
router.get("/accounts/lookups", authMiddleware, accountsView.lookups);
router.get("/accounts/summary", authMiddleware, accountsView.summary);
router.get("/accounts/outstanding", authMiddleware, accountsView.outstanding);
router.get("/accounts/ageing", authMiddleware, accountsView.ageing);
router.get("/accounts/ledger", authMiddleware, accountsView.ledger);
router.get("/accounts/credit", authMiddleware, accountsView.credit);
router.get("/accounts/payments", authMiddleware, accountsView.payments);
router.get("/accounts/payments/:id", authMiddleware, accountsView.payment);


router.get(
  "/customer/:customerId/addresses",
  authMiddleware,
  customer.getCustomerAddresses,
);
router.get(
  "/customer/by-code/:code",
  authMiddleware,
  customer.getCustomerByCode,
);

router.post(
  "/customergroup/bulk-upload",
  authMiddleware,
  upload.single("file"), // use existing multer
  customergroup.bulkUpload,
);
router.post("/customergroup", authMiddleware, customergroup.create);
router.get("/customergroup", authMiddleware, customergroup.getAll);
router.get("/customergroup/:id", authMiddleware, customergroup.getOne);
router.put("/customergroup/:id", authMiddleware, customergroup.update);
router.delete("/customergroup/:id", authMiddleware, customergroup.delete);

router.post(
  "/vendorgroup/bulk-upload",
  authMiddleware,
  upload.single("file"),
  vendorgroup.bulkUpload,
);

router.post("/vendorgroup", authMiddleware, vendorgroup.create);
router.get("/vendorgroup", authMiddleware, vendorgroup.getAll);
router.delete("/vendorgroup/:id", authMiddleware, vendorgroup.delete);

router.post(
  "/itemgroup/bulk-upload",
  authMiddleware,
  upload.single("file"),
  itemgroup.bulkUpload,
);
router.post("/itemgroup", authMiddleware, itemgroup.create);
router.get("/itemgroup", authMiddleware, itemgroup.getAll);
router.delete("/itemgroup/:id", authMiddleware, itemgroup.delete);

router.post("/hsn", authMiddleware, hsngroup.create);
router.get("/hsn", authMiddleware, hsngroup.getAll);
router.put("/hsn/:id", authMiddleware, hsngroup.update); // Phase 7 — Tax Master editing
router.delete("/hsn/:id", authMiddleware, hsngroup.delete);

router.post(
  "/hsn/bulk-upload",
  authMiddleware,
  upload.single("file"),
  hsngroup.bulkUpload,
);

// ✅ Sales Order
// ✅ Sales Order
router.post("/salesorder", authMiddleware, salesOrder.create); // Create new order
router.get("/salesorder", authMiddleware, salesOrder.getAll); // Get all orders
router.get(
  "/salesorder/count",
  authMiddleware,
  salesOrder.getOrderCountByDistributor,
); // Count orders
router.get("/salesorder/:id", authMiddleware, salesOrder.getOne); // Get one order by ID
router.put("/salesorder/:id", authMiddleware, salesOrder.update); // Update order by ID
router.post("/salesorder/:id/confirm", authMiddleware, salesOrder.confirm); // DRAFT -> CONFIRMED
router.post("/salesorder/:id/cancel", authMiddleware, salesOrder.cancel); // -> CANCELLED
router.delete("/salesorder/:id", authMiddleware, salesOrder.delete); // Delete order by ID
router.get(
  "/salesorder/by-number/:order_number",
  authMiddleware,
  salesOrder.getByNumber,
);

router.post("/pricing", authMiddleware, pricing.create);
router.get("/pricing", authMiddleware, pricing.getAll);
router.put("/pricing/:id", authMiddleware, pricing.update);
router.delete("/pricing/:id", authMiddleware, pricing.delete);

// // ✅ Delivery
// router.post("/delivery", authMiddleware, delivery.createDelivery);
// router.get("/delivery", authMiddleware, delivery.getAllDeliveries);
// router.get("/delivery/count", authMiddleware, delivery.getDeliveryCount);
// router.get("/delivery/:id", authMiddleware, delivery.getDeliveryById);
// router.put("/delivery/:id", authMiddleware, delivery.updateDelivery);
// router.delete("/delivery/:id", authMiddleware, delivery.deleteDelivery);

// // ✅ Invoice
// router.post("/invoice", authMiddleware, invoice.createInvoice);
// router.get("/invoice", authMiddleware, invoice.getAllInvoices);
// router.get("/invoice/:id", authMiddleware, invoice.getInvoiceById);
// router.put("/invoice/:id", authMiddleware, invoice.updateInvoice);
// router.delete("/invoice/:id", authMiddleware, invoice.deleteInvoice);

// ✅ Vendor Routes
router.post("/vendor", authMiddleware, vendor.create);
router.get("/vendor", authMiddleware, vendor.getAll);
router.get("/vendor/count", authMiddleware, vendor.getVendorCount); // <-- move up here
router.get("/vendor/:id", authMiddleware, vendor.getOne);
router.put("/vendor/:id", authMiddleware, vendor.update);
router.delete("/vendor/:id", authMiddleware, vendor.delete);
router.get(
  "/vendor/:vendorId/addresses",
  authMiddleware,
  vendor.getVendorAddresses,
);

// 🚚 Delivery
router.post("/sales-delivery", authMiddleware, delivery.create);
router.get("/sales-delivery", authMiddleware, delivery.getAll);
router.get("/sales-delivery/count", authMiddleware, delivery.getDeliveryCount);
router.get("/sales-delivery/:id", authMiddleware, delivery.getOne);
router.put("/sales-delivery/:id", authMiddleware, delivery.update);
router.post("/sales-delivery/:id/cancel", authMiddleware, delivery.cancel);
router.delete("/sales-delivery/:id", authMiddleware, delivery.delete);

// 🧾 Invoice
router.post("/sales-invoice", authMiddleware, invoice.create);
router.get("/sales-invoice", authMiddleware, invoice.getAll);
router.get("/sales-invoice/:id", authMiddleware, invoice.getOne);
router.put("/sales-invoice/:id", authMiddleware, invoice.update);
router.post("/sales-invoice/:id/post", authMiddleware, invoice.post);
router.post("/sales-invoice/:id/cancel", authMiddleware, invoice.cancel);
router.delete("/sales-invoice/:id", authMiddleware, invoice.delete);

// 💳 Credit
router.post("/sales-creditnote", authMiddleware, credit.create);
router.get("/sales-creditnote", authMiddleware, credit.getAll);
router.get("/sales-creditnote/:id", authMiddleware, credit.getOne);
router.put("/sales-creditnote/:id", authMiddleware, credit.update);
router.post("/sales-creditnote/:id/post", authMiddleware, credit.post);
router.post("/sales-creditnote/:id/cancel", authMiddleware, credit.cancel);
router.delete("/sales-creditnote/:id", authMiddleware, credit.delete);

// 💰 Debit
router.post("/sales-debitnote", authMiddleware, debit.create);
router.get("/sales-debitnote", authMiddleware, debit.getAll);
router.get("/sales-debitnote/:id", authMiddleware, debit.getOne);
router.put("/sales-debitnote/:id", authMiddleware, debit.update);
router.post("/sales-debitnote/:id/post", authMiddleware, debit.post);
router.post("/sales-debitnote/:id/cancel", authMiddleware, debit.cancel);
router.delete("/sales-debitnote/:id", authMiddleware, debit.delete);

// 🔄 Sales Return
router.post("/sales-return", authMiddleware, salesReturn.create);
router.get("/sales-return", authMiddleware, salesReturn.getAll);
router.get("/sales-return/:id", authMiddleware, salesReturn.getOne);
router.post("/sales-return/:id/post", authMiddleware, salesReturn.post);
router.post("/sales-return/:id/cancel", authMiddleware, salesReturn.cancel);

// 🔄 Purchase Return
router.post("/purchase-return", authMiddleware, purchaseReturn.create);
router.get("/purchase-return", authMiddleware, purchaseReturn.getAll);
router.get("/purchase-return/:id", authMiddleware, purchaseReturn.getOne);
router.post("/purchase-return/:id/post", authMiddleware, purchaseReturn.post);
router.post("/purchase-return/:id/cancel", authMiddleware, purchaseReturn.cancel);

// 💰 Purchase Debit Note (generated by Purchase Return; also directly viewable)
router.get("/purchase-debitnote", authMiddleware, purchaseDebit.getAll);
router.get("/purchase-debitnote/:id", authMiddleware, purchaseDebit.getOne);
router.post("/purchase-debitnote/:id/post", authMiddleware, purchaseDebit.post);
router.post("/purchase-debitnote/:id/cancel", authMiddleware, purchaseDebit.cancel);

// ✅ CREATE a new Purchase Order
router.post("/purchase-orders", authMiddleware, purchaseOrderController.create);

// ✅ GET all Purchase Orders (for logged-in distributor)
router.get("/purchase-orders", authMiddleware, purchaseOrderController.getAll);

// ✅ GET one Purchase Order by ID (with lines & vendor)
router.get(
  "/purchase-orders/:id",
  authMiddleware,
  purchaseOrderController.getOne,
);

// ✅ UPDATE a Purchase Order
router.put(
  "/purchase-orders/:id",
  authMiddleware,
  purchaseOrderController.update,
);

// ✅ DELETE a Purchase Order
router.delete(
  "/purchase-orders/:id",
  authMiddleware,
  purchaseOrderController.delete,
);
router.post("/purchase-orders/:id/confirm", authMiddleware, purchaseOrderController.confirm);
router.post("/purchase-orders/:id/cancel", authMiddleware, purchaseOrderController.cancel);
router.get(
  "/purchaseorder/number/:order_number",
  authMiddleware,
  purchaseOrderController.getByNumber,
);

// Purchase deliveries and invoices are created by the ADMIN (supplier) on /api/admin/purchase-orders/*. Distributors can only read them.
const adminManaged = (req, res) => res.status(403).json({ error: "Purchase deliveries and invoices are created by your administrator. You can view them here." });
router.post("/po-delivery", authMiddleware, adminManaged);
router.get("/po-delivery", authMiddleware, podelivery.getAll);
router.get("/po-delivery/:id", authMiddleware, podelivery.getOne);
router.put("/po-delivery/:id", authMiddleware, adminManaged);
router.post("/po-delivery/:id/cancel", authMiddleware, adminManaged);
router.delete("/po-delivery/:id", authMiddleware, adminManaged);

router.post("/po-invoice", authMiddleware, adminManaged);
router.get("/po-invoice", authMiddleware, poinvoice.getAll);
router.get("/po-invoice/:id", authMiddleware, poinvoice.getOne);
router.put("/po-invoice/:id", authMiddleware, adminManaged);
router.post("/po-invoice/:id/post", authMiddleware, adminManaged);
router.post("/po-invoice/:id/cancel", authMiddleware, adminManaged);
router.delete("/po-invoice/:id", authMiddleware, adminManaged);

// Ledger
router.get(
  "/ledger/customer/:customer_code",
  authMiddleware,
  ctrl.getCustomerLedger,
);
router.get("/ledger/vendor/:vendor_code", authMiddleware, ctrl.getVendorLedger);

// Trial Balance
router.get("/trial-balance", authMiddleware, ctrl.getTrialBalance);

// =================== PAYMENT (Customer) ===================
router.post("/payment/receive", authMiddleware, payment.receivePayment);

// =================== VENDOR PAYMENT =======================
router.post("/payment/vendor", authMiddleware, vendorPayment.payVendor);

// =================== GL MASTER ============================
router.post("/gl-master", authMiddleware, gl.createGL);
router.get("/gl-master", authMiddleware, gl.getAllGL);
router.put("/gl-master/:id", authMiddleware, gl.updateGL);
router.delete("/gl-master/:id", authMiddleware, gl.deleteGL);
router.post(
  "/gl-master/bulk-upload",
  authMiddleware,
  upload.single("file"),
  gl.uploadGL,
);

// =================== BALANCE SHEET ========================
router.get("/balance-sheet", authMiddleware, ctrl.getBalanceSheet);

module.exports = router;
