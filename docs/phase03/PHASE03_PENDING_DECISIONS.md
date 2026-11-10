# Phase 3 (first slice) — Decisions taken and what is still open

You asked for the correct choice to be made without questions. These were decided as follows; each is easy to change.

1. **Tax on a PO without a vendor** — a vendor-less PO has no supplier state, so the existing rule (CGST+SGST only when both states are known and equal) yields **IGST**. The PO screens label this as indicative; the final tax is set at invoicing. Change by editing `computeHsnBasedTax` / the PO preview if the business wants a fixed place of supply (e.g. the tenant's state).
2. **Schema change** — only `PurchaseOrderHeaders.vendorId` NOT NULL → NULL. Smallest change that makes "no vendor" possible; no new tables or columns.
3. **Purchase invoice for a vendor-less PO stays blocked** (400) until the business defines who the supplier on that invoice is.
4. **Settings scope** — read-only business profile; editable contact person + phone; change password. Name, email, code, GSTIN, status remain administrator-controlled.
5. **Reports** — nine sections, including "Distributor" (your own summary) and "SAP Sync" (your own sync status; error text hidden). "Retailer" is now "Customers". Reports have a fixed order and do not support column sorting yet.
6. **"Goes to that distributor's admin"** — implemented as: the PO is owned by the distributor and visible to the tenant admin (Admin portal → Purchase Orders). There is no per-admin assignment in the data model; every admin sees every distributor's POs, like the other Admin screens.
7. **Admin cannot edit/confirm/cancel a distributor's PO** in this slice (view only), as requested ("visible").

Still open for later slices: global search, e-Pulse rename + logo, Customer Master read-only counts, Schemes CRUD (Tenant Admin only), Tenant Admin Settings and Reports.
