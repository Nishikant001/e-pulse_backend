"use strict";

// Phase 18 — business-transaction integration foundation. ADDITIVE, idempotent, reversible. NO new table (erp_external_links already carries identity,
// content hash and the last ERP value; it only gets provenance + reconciliation columns). No data is changed.
//   erp_external_links   + origin ("ERP" | "DMS": which system created the record — the echo-prevention marker)
//                        + reconcile_status / reconciled_at / reconcile_detail  (last reconciliation outcome of this link)
//   SalesInvoiceHeaders  + external_source_type / external_source_id and UNIQUE (distributor_id, type, id)   ← external-ID FOUNDATION only: no invoice sync uses it yet
//   SalesReturns         + external_source_type / external_source_id and UNIQUE (distributor_id, type, id)   ← same, foundation only
// `down` removes only what this migration created. Verified on sqlite (up / up / down / down / up); NOT verified against MySQL (none available here).
const COLS = [
  { table: "erp_external_links", col: "origin", def: (S) => ({ type: S.STRING(8), allowNull: true }) },
  { table: "erp_external_links", col: "reconcile_status", def: (S) => ({ type: S.STRING(20), allowNull: true }) },
  { table: "erp_external_links", col: "reconciled_at", def: (S) => ({ type: S.DATE, allowNull: true }) },
  { table: "erp_external_links", col: "reconcile_detail", def: (S) => ({ type: S.TEXT, allowNull: true }) },
  { table: "SalesInvoiceHeaders", col: "external_source_type", def: (S) => ({ type: S.STRING(40), allowNull: true }) },
  { table: "SalesInvoiceHeaders", col: "external_source_id", def: (S) => ({ type: S.STRING(190), allowNull: true }) },
  { table: "SalesReturns", col: "external_source_type", def: (S) => ({ type: S.STRING(40), allowNull: true }) },
  { table: "SalesReturns", col: "external_source_id", def: (S) => ({ type: S.STRING(190), allowNull: true }) },
];
const INDEXES = [
  { table: "SalesInvoiceHeaders", name: "uq_sales_invoice_external_source", fields: ["distributor_id", "external_source_type", "external_source_id"], unique: true },
  { table: "SalesReturns", name: "uq_sales_return_external_source", fields: ["distributor_id", "external_source_type", "external_source_id"], unique: true },
  { table: "erp_external_links", name: "ix_erp_link_reconcile", fields: ["connection_id", "entity_type", "reconcile_status"], unique: false },
];

module.exports = {
  async up(qi, Sequelize) {
    const tables = async () => (await qi.showAllTables()).map((t) => (typeof t === "string" ? t : t.tableName));
    for (const c of COLS) {
      if (!(await tables()).includes(c.table)) continue;
      if (!Object.keys(await qi.describeTable(c.table)).includes(c.col)) await qi.addColumn(c.table, c.col, c.def(Sequelize));
    }
    for (const ix of INDEXES) {
      if (!(await tables()).includes(ix.table)) continue;
      if (!(await qi.showIndex(ix.table)).map((i) => i.name).includes(ix.name)) await qi.addIndex(ix.table, ix.fields, { name: ix.name, unique: ix.unique });
    }
  },

  async down(qi) {
    const tables = async () => (await qi.showAllTables()).map((t) => (typeof t === "string" ? t : t.tableName));
    for (const ix of INDEXES) {
      if (!(await tables()).includes(ix.table)) continue;
      if ((await qi.showIndex(ix.table)).map((i) => i.name).includes(ix.name)) await qi.removeIndex(ix.table, ix.name);
    }
    for (const c of [...COLS].reverse()) {
      if (!(await tables()).includes(c.table)) continue;
      if (Object.keys(await qi.describeTable(c.table)).includes(c.col)) await qi.removeColumn(c.table, c.col);
    }
  },
};
