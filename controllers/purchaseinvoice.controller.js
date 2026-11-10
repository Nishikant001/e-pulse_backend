// controllers/purchaseinvoice.controller.js
//
// Purchase Order → Purchase Delivery → Purchase Invoice → Accounts Payable.
// This is the authoritative invoice engine: invoice numbering, line
// creation, tax computation, and GL posting all happen here, in a single
// transaction per operation — mirroring salesinvoice.controller.js.
const db = require("../models");
const tax = require("../services/tax.service");
const accounting = require("../services/accounting.service");
const {
  PurchaseInvoiceHeader,
  PurchaseInvoiceLine,
  PurchaseDeliveryHeader,
  PurchaseDeliveryLine,
  PurchaseOrderLine,
  Product,
  Vendor,
  HSNGroup,
} = db;

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}
function notFound(message) {
  return Object.assign(new Error(message), { statusCode: 404 });
}


function parsePaymentTermsToDays(paymentTerms) {
  if (!paymentTerms) return 30;
  const match = String(paymentTerms).match(/(\d+)/);
  return match ? parseInt(match[1], 10) : 30;
}

async function generateInvoiceNumber(distributor_code, transaction) {
  const last = await PurchaseInvoiceHeader.findOne({
    where: { distributor_code },
    order: [["createdAt", "DESC"], ["id", "DESC"]],
    transaction,
  });
  let next = 1;
  if (last?.invoice_number) {
    const lastNo = parseInt(String(last.invoice_number).split("-").pop(), 10) || 0;
    next = lastNo + 1;
  }
  return `${distributor_code}-PINV-${String(next).padStart(4, "0")}`;
}

// ======================== CREATE INVOICE (DRAFT) ======================== //
// Builds real invoice lines from the delivery's lines, pulling price from
// the delivery line (which itself was copied from the originating PO line
// at receipt time — see migration 20260906090200 fixing the field that was
// previously silently dropped) and computing GST via the same HSN-based
// split used by the Purchase Order, for consistency within the module.
exports.create = async (req, res) => {
  const t = await db.sequelize.transaction();
  try {
    const distributorId = req.user.id;
    const distributor_code = req.user.distributor_code;
    const { deliveryId, paymentTerms } = req.body;

    if (!deliveryId) throw badRequest("deliveryId is required");

    // Tenant isolation: the delivery must belong to this distributor
    const delivery = await PurchaseDeliveryHeader.findOne({
      where: { id: deliveryId, distributor_id: distributorId },
      include: [
        { model: PurchaseDeliveryLine, as: "lines", include: [{ model: Product, as: "product", include: [{ model: HSNGroup, as: "hsn" }] }] },
        { model: db.PurchaseOrderHeader, as: "order", include: [{ model: Vendor, as: "vendor" }] },
      ],
      transaction: t,
    });
    if (!delivery) throw notFound("Delivery not found");

    if (delivery.status === "Cancelled") {
      throw badRequest("Cannot invoice a cancelled delivery");
    }
    if (!delivery.lines || delivery.lines.length === 0) {
      throw badRequest("Delivery has no lines to invoice");
    }

    // Duplicate-invoice protection (also enforced at the DB level by a
    // unique index on deliveryId).
    const existing = await PurchaseInvoiceHeader.findOne({ where: { deliveryId }, transaction: t });
    if (existing) throw badRequest("An invoice already exists for this delivery");

    const distributor = await db.Distributor.findByPk(distributorId, { transaction: t });
    let vendor = delivery.order.vendor;
    // A PO has no vendor: it is supplied by the distributor's administrator. Use that distributor's auto-created "Company" supplier
    // (see services/adminSupplier.service.js for the tax place-of-supply rule).
    if (!vendor) vendor = await require("../services/adminSupplier.service").ensureAdminSupplier(distributor, t);

    const invoice_number = await generateInvoiceNumber(distributor_code, t);

    const header = await PurchaseInvoiceHeader.create({
      invoiceDate: new Date(),
      distributor_id: distributorId,
      distributor_code,
      invoice_number,
      vendor_id: vendor.id,
      deliveryId,
      paymentTerms: paymentTerms || "Net 30",
      status: "DRAFT",
    }, { transaction: t });

    let netValue = 0, cgstAmount = 0, sgstAmount = 0, igstAmount = 0;

    for (const dLine of delivery.lines) {
      // Discount, if any, lives on the originating PO line — pull it in
      // rather than re-deriving anything from current Product data.
      const orderLine = await PurchaseOrderLine.findOne({
        where: { id: dLine.orderLineId, orderId: delivery.orderId },
        transaction: t,
      });

      const qty = dLine.quantityReceived;
      const unitPrice = Number(dLine.pricePerUnit) || 0;
      const discountPercent = Number(orderLine?.discount) || 0;

      const gross = tax.round2(unitPrice * qty);
      const discountAmount = tax.round2((gross * discountPercent) / 100);
      const taxableValue = tax.round2(gross - discountAmount);

      const gstRate = dLine.product?.hsn?.gst_rate || 0;
      const { cgstAmount: lineCgst, sgstAmount: lineSgst, igstAmount: lineIgst, totalTax } =
        tax.computeHsnBasedTax(taxableValue, gstRate, vendor, distributor);
      const lineTotal = tax.round2(taxableValue + totalTax);

      await PurchaseInvoiceLine.create({
        invoiceId: header.id,
        productId: dLine.productId,
        orderLineId: dLine.orderLineId,
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
    res.status(201).json({ message: "Purchase invoice created (draft)", invoice: header });
  } catch (error) {
    await t.rollback();
    console.error("Purchase Invoice Create Error:", error.message);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Error creating purchase invoice" });
  }
};

// ======================== POST INVOICE ======================== //
// DRAFT → POSTED. Creates the Purchase/Payable journal entries and makes
// the invoice financially immutable, in the same transaction as the
// status change (a failed GL lookup leaves the invoice DRAFT, never a
// half-posted state).
exports.post = async (req, res) => {
  const t = await db.sequelize.transaction();
  try {
    const distributorId = req.user.id;
    const distributor_code = req.user.distributor_code;

    const invoice = await PurchaseInvoiceHeader.findOne({
      where: { id: req.params.id, distributor_id: distributorId },
      include: [{ model: Vendor, as: "vendor" }],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!invoice) throw notFound("Invoice not found");

    if (invoice.status !== "DRAFT") {
      throw badRequest(`Cannot post an invoice with status ${invoice.status}`);
    }

    const purchaseGL = await accounting.getGL("Purchase", distributor_code, t);
    const payableGL = await accounting.getGL("Accounts Payable", distributor_code, t);
    const transaction_date = invoice.invoiceDate || new Date();

    const journalRows = [
      {
        distributor_code,
        gl_id: purchaseGL, reference_type: "PURCHASE_INVOICE",
        reference_no: invoice.id,
        debit: invoice.netValue, credit: 0,
        vendor_id: invoice.vendor_id,
        vendor_code: invoice.vendor?.vendor_code,
        transaction_date,
        narration: `Purchase — ${invoice.invoice_number}`,
      },
    ];

    const totalTax = tax.round2(Number(invoice.cgstAmount) + Number(invoice.sgstAmount) + Number(invoice.igstAmount));
    if (totalTax > 0) {
      // Required whenever there's tax to post — omitting it would debit
      // only the net purchase value while crediting the full (tax-
      // inclusive) payable amount, breaking debit == credit.
      const inputGstGL = await accounting.getGL("Input GST", distributor_code, t);
      journalRows.push({
        distributor_code,
        gl_id: inputGstGL, reference_type: "PURCHASE_INVOICE",
        reference_no: invoice.id,
        debit: totalTax, credit: 0,
        vendor_id: invoice.vendor_id,
        vendor_code: invoice.vendor?.vendor_code,
        transaction_date,
        narration: `Input GST — ${invoice.invoice_number}`,
      });
    }

    journalRows.push({
      distributor_code,
      gl_id: payableGL, reference_type: "PURCHASE_INVOICE",
      reference_no: invoice.id,
      debit: 0, credit: invoice.totalAmount,
      vendor_id: invoice.vendor_id,
      vendor_code: invoice.vendor?.vendor_code,
      transaction_date,
      narration: `Vendor Liability Created — ${invoice.invoice_number}`,
    });

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
    res.json({ message: "Purchase invoice posted", invoice });
  } catch (error) {
    await t.rollback();
    console.error("Purchase Invoice Post Error:", error.message);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Error posting purchase invoice" });
  }
};

// ======================== CANCEL INVOICE ======================== //
// Only DRAFT can be cancelled outright (no accounting exists yet to
// reverse). Cancelling a POSTED invoice needs a proper reversal mechanism
// — deferred to Phase 5/13 per the brief.
exports.cancel = async (req, res) => {
  try {
    const invoice = await PurchaseInvoiceHeader.findOne({
      where: { id: req.params.id, distributor_id: req.user.id },
    });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    if (invoice.status !== "DRAFT") {
      return res.status(400).json({
        error: "Only a DRAFT invoice can be cancelled directly. A posted invoice requires a reversal mechanism (deferred to a later phase).",
      });
    }

    await invoice.update({ status: "CANCELLED" });
    res.json({ message: "Invoice cancelled", invoice });
  } catch (error) {
    console.error("Purchase Invoice Cancel Error:", error.message);
    res.status(500).json({ error: "Error cancelling invoice" });
  }
};

// ======================== GET ALL ======================== //
exports.getAll = async (req, res) => {
  try {
    const invoices = await PurchaseInvoiceHeader.findAll({
      where: { distributor_id: req.user.id },
      include: [
        { model: Vendor, as: "vendor" },
        {
          model: PurchaseDeliveryHeader, as: "delivery",
          include: [{ model: PurchaseDeliveryLine, as: "lines", include: [{ model: Product, as: "product" }] }],
        },
        { model: PurchaseInvoiceLine, as: "lines" },
      ],
      order: [["invoiceDate", "DESC"]],
    });
    res.json(invoices);
  } catch (error) {
    console.error("Purchase Invoice GetAll Error:", error.message);
    res.status(500).json({ error: "Error fetching invoices" });
  }
};

const returnable = require("../services/returnableQuantity.service");

// ======================== GET ONE ======================== //
exports.getOne = async (req, res) => {
  try {
    const invoice = await PurchaseInvoiceHeader.findOne({
      where: { id: req.params.id, distributor_id: req.user.id },
      include: [
        { model: Vendor, as: "vendor" },
        {
          model: PurchaseDeliveryHeader, as: "delivery",
          include: [{ model: PurchaseDeliveryLine, as: "lines", include: [{ model: Product, as: "product" }] }],
        },
        { model: PurchaseInvoiceLine, as: "lines", include: [{ model: Product, as: "product" }] },
      ],
    });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    const plain = invoice.toJSON();
    for (const line of plain.lines) {
      const consumed = await returnable.getPurchaseInvoiceLineConsumed(line.id);
      line.consumedQuantity = consumed;
      line.remainingReturnableQuantity = line.quantity - consumed;
    }
    res.json(plain);
  } catch (error) {
    console.error("Purchase Invoice GetOne Error:", error.message);
    res.status(500).json({ error: "Error fetching invoice" });
  }
};

// ======================== UPDATE ======================== //
// Only DRAFT invoices allow edits, and only to non-financial fields.
exports.update = async (req, res) => {
  try {
    const invoice = await PurchaseInvoiceHeader.findOne({
      where: { id: req.params.id, distributor_id: req.user.id },
    });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    if (invoice.status !== "DRAFT") {
      return res.status(400).json({ error: "Only a DRAFT invoice can be edited" });
    }

    const { paymentTerms } = req.body;
    await invoice.update({ paymentTerms: paymentTerms ?? invoice.paymentTerms });
    res.json({ message: "Invoice updated successfully", invoice });
  } catch (error) {
    console.error("Purchase Invoice Update Error:", error.message);
    res.status(500).json({ error: "Error updating invoice" });
  }
};

// ======================== DELETE ======================== //
// Only DRAFT invoices can be deleted outright. POSTED invoices are never
// deleted (rule 17) — a reversal mechanism is deferred to a later phase.
exports.delete = async (req, res) => {
  try {
    const invoice = await PurchaseInvoiceHeader.findOne({
      where: { id: req.params.id, distributor_id: req.user.id },
    });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    if (invoice.status !== "DRAFT") {
      return res.status(400).json({ error: "Only a DRAFT invoice can be deleted; POSTED invoices are never deleted" });
    }

    await PurchaseInvoiceLine.destroy({ where: { invoiceId: invoice.id } });
    await invoice.destroy();
    res.json({ message: "Invoice deleted successfully" });
  } catch (error) {
    console.error("Purchase Invoice Delete Error:", error.message);
    res.status(500).json({ error: "Error deleting invoice" });
  }
};
