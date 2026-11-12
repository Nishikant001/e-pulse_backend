// /api/admin/* — Admin portal API. Kept in its own router so it can never be reached through the Distributor
// route table, and mounted BEFORE the Distributor routes in server.js.
const express = require("express");
const requireAdmin = require("../middleware/adminAuth");
const requireSuperAdmin = require("../middleware/requireSuperAdmin");
const adminAuth = require("../controllers/admin.auth.controller");
const adminDashboard = require("../controllers/admin.dashboard.controller");
const adminSales = require("../controllers/admin.sales.controller");
const adminInventory = require("../controllers/admin.inventory.controller");
const adminMasters = require("../controllers/admin.masters.controller");
const adminDistributors = require("../controllers/admin.distributors.controller");
const adminRetailers = require("../controllers/admin.retailers.controller");
const adminSchemes = require("../controllers/admin.schemes.controller");
const adminPurchaseOrders = require("../controllers/admin.purchaseorders.controller");
const adminPurchaseFulfilment = require("../controllers/admin.purchaseFulfilment.controller");
const adminClaims = require("../controllers/admin.claims.controller");
const adminAccounts = require("../controllers/admin.accounts.controller");
const adminErp = require("../controllers/admin.erp.controller");
const superAdmin = require("../controllers/superAdmin.controller");

const router = express.Router();

// Public (credentials are verified inside the controller)
const { policies } = require("../middleware/rateLimiter");
router.post("/login", policies.adminLogin, adminAuth.login); // Phase 17: request-rate limit per IP in front of the existing failed-attempt limiter
router.post("/logout", adminAuth.logout);
router.get("/session", adminAuth.session); // 200 either way; { authenticated: boolean }

// Admin-only
router.get("/me", requireAdmin, adminAuth.me);
router.get("/dashboard/summary", requireAdmin, policies.report, adminDashboard.summary);

// ── Super Admin dashboard (Phase 25): SUPER_ADMIN role only. ──
router.get("/superadmin/overview", requireAdmin, requireSuperAdmin, superAdmin.overview);
router.post("/superadmin/admins", requireAdmin, requireSuperAdmin, superAdmin.createAdmin);
router.get("/superadmin/roles", requireAdmin, requireSuperAdmin, superAdmin.roles);
router.get("/superadmin/distributors", requireAdmin, requireSuperAdmin, superAdmin.networkDistributors);
router.get("/superadmin/onboarding", requireAdmin, requireSuperAdmin, superAdmin.onboardingRequests);
router.get("/superadmin/admins/:id/distributors", requireAdmin, requireSuperAdmin, superAdmin.adminDistributors);

// ── Sales (Phase 4): orders, invoices, secondary sales. Every route requires an Admin session. ──
router.get("/sales/lookups/filters", requireAdmin, adminSales.filterLookups);
router.get("/sales/lookups/retailers", requireAdmin, adminSales.retailerLookup);
router.get("/sales/lookups/products", requireAdmin, adminSales.productLookup);
router.get("/sales/lookups/batches", requireAdmin, adminSales.batchLookup);

router.get("/sales/orders", requireAdmin, adminSales.listOrders);
router.post("/sales/orders/preview", requireAdmin, adminSales.previewOrder);
router.post("/sales/orders", requireAdmin, adminSales.createOrder);
router.get("/sales/orders/:id", requireAdmin, adminSales.getOrder);
router.put("/sales/orders/:id", requireAdmin, adminSales.updateOrder);
router.post("/sales/orders/:id/confirm", requireAdmin, adminSales.confirmOrder);
router.post("/sales/orders/:id/cancel", requireAdmin, adminSales.cancelOrder);
router.post("/sales/orders/:id/create-invoice", requireAdmin, adminSales.createInvoiceForOrder);

router.get("/sales/invoices", requireAdmin, adminSales.listInvoices);
router.get("/sales/invoices/:id", requireAdmin, adminSales.getInvoice);
router.post("/sales/invoices/:id/post", requireAdmin, adminSales.postInvoice);
router.post("/sales/invoices/:id/cancel", requireAdmin, adminSales.cancelInvoice);

router.get("/sales/secondary/summary", requireAdmin, policies.report, adminSales.secondarySummary);
router.get("/sales/secondary", requireAdmin, policies.report, adminSales.listSecondary);
router.get("/sales/secondary/:key", requireAdmin, adminSales.getSecondary);

// ── Inventory & Batch Management (Phase 5): read-only across distributors. Every route requires an Admin session. ──
router.get("/inventory/lookups", requireAdmin, adminInventory.lookups);
router.get("/inventory/summary", requireAdmin, adminInventory.summary);
router.get("/inventory/current", requireAdmin, adminInventory.current);
router.get("/inventory/batches", requireAdmin, adminInventory.batches);
router.get("/inventory/batches/:id", requireAdmin, adminInventory.batchDetail);
router.get("/inventory/ledger", requireAdmin, policies.report, adminInventory.ledger);
router.get("/inventory/movement", requireAdmin, policies.report, adminInventory.movement);
router.get("/inventory/transfers", requireAdmin, adminInventory.transfers);
// Phase 6 — FEFO & Expiry Management
router.get("/inventory/expiry-summary", requireAdmin, adminInventory.expirySummary);
router.get("/inventory/fefo-preview", requireAdmin, adminInventory.fefoPreview);

// ── Product / Batch / Pricing / Tax Masters (Phase 7): cross-distributor. Reads are read-only across every tenant;
// writes act on an explicitly chosen (create) or record-resolved (update/status) tenant — see admin.masters.controller.js. ──
router.get("/masters/lookups", requireAdmin, adminMasters.lookups);

router.get("/masters/products", requireAdmin, adminMasters.listProducts);
router.get("/masters/products/:id", requireAdmin, adminMasters.getProduct);
router.post("/masters/products", requireAdmin, adminMasters.createProduct);
router.put("/masters/products/:id", requireAdmin, adminMasters.updateProduct);
router.post("/masters/products/:id/deactivate", requireAdmin, adminMasters.setProductStatus("inactive"));
router.post("/masters/products/:id/reactivate", requireAdmin, adminMasters.setProductStatus("active"));

router.get("/masters/batches", requireAdmin, adminMasters.listBatches);
router.get("/masters/batches/:id", requireAdmin, adminMasters.getBatch);
router.post("/masters/batches", requireAdmin, adminMasters.createBatch);
router.put("/masters/batches/:id", requireAdmin, adminMasters.updateBatch);
router.post("/masters/batches/:id/deactivate", requireAdmin, adminMasters.setBatchStatus("inactive"));
router.post("/masters/batches/:id/reactivate", requireAdmin, adminMasters.setBatchStatus("active"));

router.get("/masters/pricing", requireAdmin, adminMasters.listPricing);
router.get("/masters/pricing/:id", requireAdmin, adminMasters.getPricing);
router.post("/masters/pricing", requireAdmin, adminMasters.createPricing);
router.put("/masters/pricing/:id", requireAdmin, adminMasters.updatePricing);
router.post("/masters/pricing/:id/deactivate", requireAdmin, adminMasters.deactivatePricing);

router.get("/masters/taxes", requireAdmin, adminMasters.listTaxes);
router.get("/masters/taxes/:id", requireAdmin, adminMasters.getTax);
router.post("/masters/taxes", requireAdmin, adminMasters.createTax);
router.put("/masters/taxes/:id", requireAdmin, adminMasters.updateTax);

router.get("/masters/customer-groups", requireAdmin, adminMasters.listCustomerGroups);
router.get("/masters/customer-groups/:id", requireAdmin, adminMasters.getCustomerGroup);
router.post("/masters/customer-groups", requireAdmin, adminMasters.createCustomerGroup);
router.put("/masters/customer-groups/:id", requireAdmin, adminMasters.updateCustomerGroup);

// ── Distributor Management (Phase 8). "lookups" is registered before "/:id" so it is never parsed as an id. ──
router.get("/distributors/lookups", requireAdmin, adminDistributors.lookups);
router.get("/distributors", requireAdmin, adminDistributors.list);
router.post("/distributors", requireAdmin, adminDistributors.create);
router.get("/distributors/:id", requireAdmin, adminDistributors.get);
router.put("/distributors/:id", requireAdmin, adminDistributors.update);
router.get("/distributors/:id/retailers", requireAdmin, adminDistributors.retailers);
router.post("/distributors/:id/status", requireAdmin, adminDistributors.setStatus);


// ── Retailer Management (Phase 9). "lookups" is registered before "/:id". "assign" is the ONLY route that can change ownership. ──
router.get("/retailers/lookups", requireAdmin, adminRetailers.lookups);
router.get("/retailers", requireAdmin, adminRetailers.list);
router.post("/retailers", requireAdmin, adminRetailers.create);
router.get("/retailers/:id", requireAdmin, adminRetailers.get);
router.put("/retailers/:id", requireAdmin, adminRetailers.update);
router.post("/retailers/:id/status", requireAdmin, adminRetailers.setStatus);
router.post("/retailers/:id/assign", requireAdmin, adminRetailers.assign);

// ── Purchase Orders (e-Pulse Phase 1). READ-ONLY: the admin sees the POs distributors create (no vendor involved). "lookups" is registered before "/:id". ──
router.get("/purchase-orders/lookups", requireAdmin, adminPurchaseOrders.lookups);
router.get("/purchase-orders", requireAdmin, adminPurchaseOrders.list);
router.get("/purchase-orders/:id", requireAdmin, adminPurchaseOrders.get);
// Admin fulfils the distributor's PO: delivery (posts stock-in) and invoice.
router.post("/purchase-orders/:id/deliveries", requireAdmin, adminPurchaseFulfilment.deliver);
router.post("/purchase-orders/:id/deliveries/:deliveryId/invoice", requireAdmin, adminPurchaseFulfilment.invoice);

// ── Scheme Engine (Phase 10). Admin-only. "lookups" and "evaluate" are registered before "/:id". ──
router.get("/schemes/lookups", requireAdmin, adminSchemes.lookups);
router.post("/schemes/evaluate", requireAdmin, adminSchemes.evaluate);
router.get("/schemes", requireAdmin, adminSchemes.list);
router.post("/schemes", requireAdmin, adminSchemes.create);
router.get("/schemes/:id", requireAdmin, adminSchemes.get);
router.put("/schemes/:id", requireAdmin, adminSchemes.update);
router.post("/schemes/:id/status", requireAdmin, adminSchemes.setStatus);

// ── Claims (Phase 11). Admin-only. "lookups" is registered before "/:id". No generic status endpoint exists. ──
router.get("/claims/lookups", requireAdmin, adminClaims.lookups);
router.get("/claims", requireAdmin, adminClaims.list);
router.get("/claims/:id", requireAdmin, adminClaims.get);
router.post("/claims/:id/review", requireAdmin, adminClaims.review);
router.post("/claims/:id/approve", requireAdmin, adminClaims.approve);
router.post("/claims/:id/reject", requireAdmin, adminClaims.reject);
router.post("/claims/:id/needs-correction", requireAdmin, adminClaims.needsCorrection);
router.post("/claims/:id/settle", requireAdmin, adminClaims.settle); // Phase 12 — only for claims approved before accounting existed

// ── Accounts & Financial Management (Phase 12). Admin-only; tenant is derived server-side (never from the client). ──
router.get("/accounts/lookups", requireAdmin, adminAccounts.lookups);
router.get("/accounts/summary", requireAdmin, policies.report, adminAccounts.summary);
router.get("/accounts/outstanding", requireAdmin, policies.report, adminAccounts.outstanding);
router.get("/accounts/ageing", requireAdmin, policies.report, adminAccounts.ageing);
router.get("/accounts/ledger", requireAdmin, policies.report, adminAccounts.ledger);
router.get("/accounts/credit", requireAdmin, adminAccounts.credit);
router.put("/accounts/credit/:entityId", requireAdmin, adminAccounts.updateCredit);
router.get("/accounts/open-invoices", requireAdmin, adminAccounts.openInvoices);
router.get("/accounts/payments", requireAdmin, adminAccounts.payments);
router.post("/accounts/payments", requireAdmin, adminAccounts.createPayment);
router.get("/accounts/payments/:id", requireAdmin, adminAccounts.payment);

// ── ERP Integration (Phases 13–17). Admin-only; the tenant is derived server-side. EVERY route enforces an ERP permission on the server
// (Phase 17 RBAC, config/erpPermissions.js) after requireAdmin: 401 no session · 403 role lacks the permission. Frontend hiding is UX only.
//   ERP_VIEW read · ERP_MANAGE connections/mappings/ownership/code mappings · ERP_SYNC start sync, run now, outbound · ERP_RETRY retry a failed sync
//   ERP_SCHEDULE create/change schedules · ERP_AUDIT read the audit trail.   Test connection needs ERP_MANAGE or ERP_SYNC (it makes a real ERP request).
// Credentials are never accepted or returned: only a reference name. "lookups" / "health" are registered before "/:id". ──
const erp = require("../middleware/erpAccess").erp;
router.get("/erp-integrations/lookups", requireAdmin, erp("ERP_VIEW", "read"), adminErp.lookups);
router.get("/erp-integrations/health/readiness", requireAdmin, erp("ERP_VIEW", "heavy"), adminErp.readiness);
router.get("/erp-integrations", requireAdmin, erp("ERP_VIEW", "read"), adminErp.list);
router.post("/erp-integrations", requireAdmin, erp("ERP_MANAGE", "write"), adminErp.create);
router.get("/erp-integrations/:id", requireAdmin, erp("ERP_VIEW", "read"), adminErp.get);
router.put("/erp-integrations/:id", requireAdmin, erp("ERP_MANAGE", "write"), adminErp.update);
router.patch("/erp-integrations/:id/status", requireAdmin, erp("ERP_MANAGE", "write"), adminErp.setStatus);
router.patch("/erp-integrations/:id/default", requireAdmin, erp("ERP_MANAGE", "write"), adminErp.setDefault);
router.post("/erp-integrations/:id/test", requireAdmin, erp(["ERP_MANAGE", "ERP_SYNC"], "test"), adminErp.test);
// Generic ERP Sync (Phase 14). Mappings are per connection + capability; sync routes live under /erp-sync.
router.get("/erp-integrations/:id/mappings/:capability", requireAdmin, erp("ERP_VIEW", "read"), adminErp.getMappings);
router.put("/erp-integrations/:id/mappings/:capability", requireAdmin, erp("ERP_MANAGE", "write"), adminErp.saveMappings);
router.get("/erp-sync/summary", requireAdmin, erp("ERP_VIEW", "heavy"), adminErp.syncSummary);
router.get("/erp-sync/jobs", requireAdmin, erp("ERP_VIEW", "read"), adminErp.listJobs);
router.post("/erp-sync/jobs", requireAdmin, erp("ERP_SYNC", "sync"), adminErp.startSync);
router.get("/erp-sync/jobs/:id", requireAdmin, erp("ERP_VIEW", "read"), adminErp.getJob);
router.get("/erp-sync/jobs/:id/errors", requireAdmin, erp("ERP_VIEW", "read"), adminErp.jobErrors);
router.post("/erp-sync/jobs/:id/retry", requireAdmin, erp("ERP_RETRY", "sync"), adminErp.retryJob);
// Phase 15: error monitor + schedules. A schedule belongs to (connection, capability): PUT creates/updates it, enabled:false disables it.
router.get("/erp-sync/errors", requireAdmin, erp("ERP_VIEW", "read"), adminErp.listErrors);
router.get("/erp-sync/schedules", requireAdmin, erp("ERP_VIEW", "read"), adminErp.listSchedules);
router.get("/erp-sync/schedules/:id", requireAdmin, erp("ERP_VIEW", "read"), adminErp.getSchedule);
router.post("/erp-sync/schedules/:id/run", requireAdmin, erp("ERP_SYNC", "sync"), adminErp.runSchedule); // starts a sync → ERP_SYNC
router.put("/erp-integrations/:id/schedules/:capability", requireAdmin, erp("ERP_SCHEDULE", "write"), adminErp.saveSchedule);
// Phase 16: persistent audit (read-only), alerts, ERP code mappings, outbound (DMS → ERP)
router.get("/erp-sync/audit", requireAdmin, erp("ERP_AUDIT", "audit"), adminErp.listAudit);
router.get("/erp-sync/alerts", requireAdmin, erp("ERP_VIEW", "heavy"), adminErp.alerts);
router.get("/erp-integrations/:id/code-mappings", requireAdmin, erp("ERP_VIEW", "read"), adminErp.listCodeMappings);
router.put("/erp-integrations/:id/code-mappings", requireAdmin, erp("ERP_MANAGE", "write"), adminErp.saveCodeMapping);
router.delete("/erp-integrations/:id/code-mappings/:mappingId", requireAdmin, erp("ERP_MANAGE", "write"), adminErp.deleteCodeMapping);
router.post("/erp-sync/outbound", requireAdmin, erp("ERP_SYNC", "outbound"), adminErp.sendOutbound); // + ownership / idempotency checks in the service
router.get("/erp-sync/outbound", requireAdmin, erp("ERP_VIEW", "read"), adminErp.listOutbound);
// Phase 18: business-capability overview (ERP_VIEW) and reconciliation — comparing reads the ERP, so running it needs ERP_SYNC; reading stored results needs ERP_VIEW.
router.get("/erp-sync/business/overview", requireAdmin, erp("ERP_VIEW", "heavy"), adminErp.businessOverview);
router.post("/erp-sync/reconciliation", requireAdmin, erp("ERP_SYNC", "sync"), adminErp.runReconciliation);
router.get("/erp-sync/reconciliation", requireAdmin, erp("ERP_VIEW", "read"), adminErp.listReconciliation);

module.exports = router;
