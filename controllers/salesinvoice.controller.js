// controllers/salesinvoice.controller.js
//
// Sales Order → Sales Delivery → Sales Invoice → Accounts Receivable.
// This is the authoritative invoice engine: invoice numbering, line
// creation, tax computation, and GL posting all happen here, in a single
// transaction per operation. Nothing else in the codebase should create
// SalesInvoiceHeader/SalesInvoiceLine rows or post AR journal entries.
const db = require("../models");
const tax = require("../services/tax.service");
const accounting = require("../services/accounting.service");
const {
  SalesInvoiceHeader,
  SalesInvoiceLine,
  SalesDeliveryHeader,
  SalesDeliveryLine,
  Product,
  Customer,
  SalesOrderHeader,
  SalesOrderLine,
} = db;

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}


function parsePaymentTermsToDays(paymentTerms) {
  if (!paymentTerms) return 30;
  const match = String(paymentTerms).match(/(\d+)/);
  return match ? parseInt(match[1], 10) : 30;
}

async function generateInvoiceNumber(distributor_code, transaction) {
  const last = await SalesInvoiceHeader.findOne({
    where: { distributor_code },
    order: [["createdAt", "DESC"], ["id", "DESC"]],
    transaction,
  });
  let next = 1;
  if (last?.invoice_number) {
    const lastNo = parseInt(String(last.invoice_number).split("-").pop(), 10) || 0;
    next = lastNo + 1;
  }
  return `${distributor_code}-INV-${String(next).padStart(4, "0")}`;
}

// ======================== CREATE INVOICE (DRAFT) ======================== //
// Builds real invoice lines from the delivery's lines, pulling price from
// the originating Sales Order line (the price the customer already agreed
// to — invoicing does not re-price) and computing tax from the product's
// GST rate via the centralized tax service. No accounting is posted yet;
// that only happens on post().
exports.create = async (req, res) => {
  const t = await db.sequelize.transaction();
  try {
    const distributorId = req.user.id;
    const distributor_code = req.user.distributor_code;
    const { deliveryId, paymentTerms } = req.body;

    if (!deliveryId) throw badRequest("deliveryId is required");

    // Tenant isolation: the delivery must belong to this distributor
    const delivery = await SalesDeliveryHeader.findOne({
      where: { id: deliveryId, distributor_id: distributorId },
      include: [
        { model: SalesDeliveryLine, as: "lines", include: [{ model: Product, as: "product" }] },
        { model: SalesOrderHeader, as: "order", include: [{ model: Customer, as: "customer" }] },
      ],
      transaction: t,
    });
    if (!delivery) throw Object.assign(new Error("Delivery not found"), { statusCode: 404 });

    if (delivery.status === "Cancelled") {
      throw badRequest("Cannot invoice a cancelled delivery");
    }
    if (!delivery.lines || delivery.lines.length === 0) {
      throw badRequest("Delivery has no lines to invoice");
    }

    // Duplicate-invoice protection (also enforced at the DB level by a
    // unique index on deliveryId).
    const existing = await SalesInvoiceHeader.findOne({ where: { deliveryId }, transaction: t });
    if (existing) throw badRequest("This delivery has already been invoiced");

    const invoice_number = await generateInvoiceNumber(distributor_code, t);

    const header = await SalesInvoiceHeader.create({
      invoiceDate: new Date(),
      distributor_id: distributorId,
      distributor_code,
      invoice_number,
      customer_id: delivery.order.customer.id,
      deliveryId,
      paymentTerms: paymentTerms || "Net 30",
      status: "DRAFT",
    }, { transaction: t });

    let netValue = 0, cgstAmount = 0, sgstAmount = 0, igstAmount = 0;

    for (const dLine of delivery.lines) {
      const orderLine = await SalesOrderLine.findOne({
        where: { id: dLine.orderLineId, orderId: delivery.orderId },
        transaction: t,
      });
      if (!orderLine) {
        throw badRequest(`Order line not found for delivery line ${dLine.id}`);
      }

      const qty = dLine.quantityDelivered;
      const unitPrice = Number(orderLine.pricePerUnit);
      const discountPercent = Number(orderLine.discount) || 0;

      const gross = tax.round2(unitPrice * qty);
      const discountAmount = tax.round2((gross * discountPercent) / 100);
      const taxableValue = tax.round2(gross - discountAmount);
      const { cgstAmount: lineCgst, sgstAmount: lineSgst, igstAmount: lineIgst, totalTax } =
        tax.computeLineTax(taxableValue, dLine.product);
      const lineTotal = tax.round2(taxableValue + totalTax);

      await SalesInvoiceLine.create({
        invoiceId: header.id,
        productId: dLine.productId,
        orderLineId: orderLine.id,
        deliveryLineId: dLine.id,
        quantity: qty,
        pricePerUnit: unitPrice,
        discount: discountAmount,
        taxableValue,
        cgstAmount: lineCgst,
        sgstAmount: lineSgst,
        igstAmount: lineIgst,
        lineTotal,
      }, { transaction: t });

      netValue += taxableValue;
      cgstAmount += lineCgst;
      sgstAmount += lineSgst;
      igstAmount += lineIgst;
    }

    netValue = tax.round2(netValue);
    cgstAmount = tax.round2(cgstAmount);
    sgstAmount = tax.round2(sgstAmount);
    igstAmount = tax.round2(igstAmount);
    const totalAmount = tax.round2(netValue + cgstAmount + sgstAmount + igstAmount);

    await header.update({ netValue, cgstAmount, sgstAmount, igstAmount, totalAmount }, { transaction: t });

    await t.commit();
    res.status(201).json({ message: "Invoice created (draft)", invoice: header });
  } catch (error) {
    await t.rollback();
    console.error("❌ Invoice Create Error:", error.message);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
};

// ======================== POST INVOICE ======================== //
// DRAFT → POSTED. Creates the AR/Sales/Output-GST journal entries and
// makes the invoice financially immutable. This is the only place
// accounting entries are created for a sales invoice, and it happens in
// the same transaction as the status change — if GL posting fails, the
// invoice stays DRAFT rather than silently becoming POSTED with no
// accounting behind it (the bug in the pre-Phase-3 implementation).
exports.post = async (req, res) => {
  const t = await db.sequelize.transaction();
  try {
    const distributorId = req.user.id;
    const distributor_code = req.user.distributor_code;

    const invoice = await SalesInvoiceHeader.findOne({
      where: { id: req.params.id, distributor_id: distributorId },
      include: [{ model: Customer, as: "customer" }],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!invoice) throw Object.assign(new Error("Invoice not found"), { statusCode: 404 });

    if (invoice.status !== "DRAFT") {
      throw badRequest(`Cannot post an invoice with status ${invoice.status}`);
    }

    const receivableGL = await accounting.getGL("Accounts Receivable", distributor_code, t);
    const salesGL = await accounting.getGL("Sales", distributor_code, t);
    const transaction_date = invoice.invoiceDate || new Date();

    const journalRows = [
      {
        distributor_code,
        gl_id: receivableGL, reference_type: "SALES_INVOICE",
        reference_no: invoice.id,
        debit: invoice.totalAmount, credit: 0,
        customer_id: invoice.customer_id,
        customer_code: invoice.customer?.customer_code,
        transaction_date,
        narration: `Sales Invoice ${invoice.invoice_number} Posting`,
      },
      {
        distributor_code,
        gl_id: salesGL, reference_type: "SALES_INVOICE",
        reference_no: invoice.id,
        debit: 0, credit: invoice.netValue,
        customer_id: invoice.customer_id,
        customer_code: invoice.customer?.customer_code,
        transaction_date,
        narration: `Sales Revenue — ${invoice.invoice_number}`,
      },
    ];

    const totalTax = tax.round2(Number(invoice.cgstAmount) + Number(invoice.sgstAmount) + Number(invoice.igstAmount));
    if (totalTax > 0) {
      const gstGL = await accounting.getGL("Output GST", distributor_code, t);
      journalRows.push({
        distributor_code,
        gl_id: gstGL, reference_type: "SALES_INVOICE",
        reference_no: invoice.id,
        debit: 0, credit: totalTax,
        customer_id: invoice.customer_id,
        customer_code: invoice.customer?.customer_code,
        transaction_date,
        narration: `Output GST — ${invoice.invoice_number}`,
      });
    }

    // Double-entry safety net — see services/accounting.service.js.
    accounting.assertBalanced(journalRows);
    for (const row of journalRows) {
      await db.JournalEntry.create(row, { transaction: t });
    }

    const dueDate = new Date(invoice.invoiceDate);
    dueDate.setDate(dueDate.getDate() + parsePaymentTermsToDays(invoice.paymentTerms));

    await invoice.update({
      status: "POSTED",
      postedAt: new Date(),
      dueDate,
      outstandingAmount: invoice.totalAmount,
    }, { transaction: t });

    await t.commit();
    res.json({ message: "Invoice posted", invoice });
  } catch (error) {
    await t.rollback();
    console.error("❌ Invoice Post Error:", error.message);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
};

// ======================== CANCEL INVOICE ======================== //
// Only a DRAFT invoice can be cancelled outright (no accounting exists
// yet to reverse). Cancelling a POSTED invoice requires a credit-note /
// reversal mechanism — out of scope for Phase 3 per the brief.
exports.cancel = async (req, res) => {
  try {
    const invoice = await SalesInvoiceHeader.findOne({
      where: { id: req.params.id, distributor_id: req.user.id },
    });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    if (invoice.status !== "DRAFT") {
      return res.status(400).json({
        error: "Only a DRAFT invoice can be cancelled directly. A posted invoice requires a credit note/reversal.",
      });
    }

    await invoice.update({ status: "CANCELLED" });
    res.json({ message: "Invoice cancelled", invoice });
  } catch (error) {
    console.error("❌ Invoice Cancel Error:", error.message);
    res.status(500).json({ error: "Error cancelling invoice" });
  }
};

// ======================== GET ALL INVOICES ======================== //
exports.getAll = async (req, res) => {
  try {
    const distributorId = req.user.id;
    const invoices = await SalesInvoiceHeader.findAll({
      where: { distributor_id: distributorId },
      include: [
        { model: Customer, as: "customer" },
        {
          model: SalesDeliveryHeader,
          as: "delivery",
          include: [{ model: SalesDeliveryLine, as: "lines", include: [{ model: Product, as: "product" }] }],
        },
        { model: SalesInvoiceLine, as: "lines" },
      ],
      order: [["invoiceDate", "DESC"]],
    });
    res.json(invoices);
  } catch (error) {
    console.error("❌ Get All Invoices Error:", error.message);
    res.status(500).json({ error: "Error fetching invoices" });
  }
};

const returnable = require("../services/returnableQuantity.service");

// ======================== GET ONE INVOICE ======================== //
exports.getOne = async (req, res) => {
  try {
    const distributorId = req.user.id;
    const invoice = await SalesInvoiceHeader.findOne({
      where: { id: req.params.id, distributor_id: distributorId },
      include: [
        { model: Customer, as: "customer" },
        {
          model: SalesDeliveryHeader,
          as: "delivery",
          include: [{ model: SalesDeliveryLine, as: "lines", include: [{ model: Product, as: "product" }] }],
        },
        { model: SalesInvoiceLine, as: "lines", include: [{ model: Product, as: "product" }] },
      ],
    });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    const plain = invoice.toJSON();
    for (const line of plain.lines) {
      const consumed = await returnable.getSalesInvoiceLineConsumed(line.id);
      line.consumedQuantity = consumed;
      line.remainingCreditableQuantity = line.quantity - consumed;
    }
    res.json(plain);
  } catch (error) {
    console.error("❌ Get One Invoice Error:", error.message);
    res.status(500).json({ error: "Error fetching invoice" });
  }
};

// ======================== UPDATE INVOICE ======================== //
// Only DRAFT invoices allow any edits, and only to non-financial fields
// (paymentTerms). Quantity/rate/tax/total/customer are never editable —
// posted-invoice immutability per the Phase 3 brief.
exports.update = async (req, res) => {
  try {
    const distributorId = req.user.id;
    const { id } = req.params;
    const { paymentTerms } = req.body;

    const invoice = await SalesInvoiceHeader.findOne({ where: { id, distributor_id: distributorId } });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    if (invoice.status !== "DRAFT") {
      return res.status(400).json({ error: "Only a DRAFT invoice can be edited" });
    }

    await invoice.update({ paymentTerms: paymentTerms ?? invoice.paymentTerms });
    res.json({ message: "Invoice updated successfully", invoice });
  } catch (error) {
    console.error("❌ Update Invoice Error:", error.message);
    res.status(500).json({ error: "Error updating invoice" });
  }
};

// ======================== DELETE INVOICE ======================== //
// Only DRAFT invoices can be deleted outright; POSTED invoices must go
// through cancel()'s reversal path (not yet implemented — Phase 5/6).
exports.delete = async (req, res) => {
  try {
    const distributorId = req.user.id;
    const invoice = await SalesInvoiceHeader.findOne({
      where: { id: req.params.id, distributor_id: distributorId },
    });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    if (invoice.status !== "DRAFT") {
      return res.status(400).json({ error: "Only a DRAFT invoice can be deleted" });
    }

    await SalesInvoiceLine.destroy({ where: { invoiceId: invoice.id } });
    await invoice.destroy();
    res.json({ message: "Invoice deleted successfully" });
  } catch (error) {
    console.error("❌ Delete Invoice Error:", error.message);
    res.status(500).json({ error: "Error deleting invoice" });
  }
};
