const db = require("../models");
const Invoice = db.Invoice;
const SalesOrderHeader = db.SalesOrderHeader;
const SalesOrderLineItem = db.SalesOrderLine;
const Customer = db.Customer;
const Distributor = db.Distributor;

const { v4: uuidv4 } = require('uuid'); // npm install uuid

const invoiceNumber = `INV-${Date.now()}-${Math.floor(Math.random()*1000)}`;

exports.createInvoice = async (req, res) => {
  try {
    const {
      salesOrderHeader_id,
      paymentAmount = 0,
      restPaymentDueDate,
      placeOfSupply,
      vehicleNumber,
      receiverDetails,
      consigneeBilledTo,
      consigneeShippedTo,
      invoiceType,
      reason,
      total, // optional override
    } = req.body;

    if (
      !invoiceType ||
      ![
        "retailer_credit",
        "retailer_debit",
        "vendor_credit",
        "vendor_debit",
      ].includes(invoiceType)
    ) {
      return res.status(400).json({
        message:
          "Invalid invoiceType. Allowed values: retailer_credit, retailer_debit, vendor_credit, vendor_debit",
      });
    }

    const salesOrderHeader = await SalesOrderHeader.findByPk(
      salesOrderHeader_id,
      {
        include: [
          { model: Customer, as: "customer" },
          { model: Distributor, as: "distributor" },
          { model: SalesOrderLineItem, as: "lines" },
        ],
      }
    );

    if (!salesOrderHeader)
      return res.status(404).json({ message: "Sales Order not found" });

    const lineItems = salesOrderHeader.lines || [];
    const calculatedTotal = lineItems.reduce(
      (sum, item) => sum + item.quantity * item.netPricePerQuantity,
      0
    );

    let adjustedTotal = total || calculatedTotal;
    let gstEffect = "";
    let amountEffect = "";

    switch (invoiceType) {
      case "retailer_credit":
        gstEffect = "GST reduced";
        amountEffect = "Customer pays less";
        adjustedTotal *= 0.9;
        break;
      case "retailer_debit":
        gstEffect = "GST added";
        amountEffect = "Customer pays more";
        adjustedTotal *= 1.1;
        break;
      case "vendor_credit":
        gstEffect = "GST reduced";
        amountEffect = "You pay less";
        adjustedTotal *= 0.9;
        break;
      case "vendor_debit":
        gstEffect = "GST added";
        amountEffect = "You pay more";
        adjustedTotal *= 1.1;
        break;
    }

    const invoiceData = {
      invoiceNumber,
      salesOrderHeader_id,
      customer_id: salesOrderHeader.customer.id,
      distributor_id: salesOrderHeader.distributor.id,
      invoiceType,
      reason,
      total: parseFloat(adjustedTotal.toFixed(2)),
      paymentAmount,
      restAmount: parseFloat((adjustedTotal - paymentAmount).toFixed(2)),
      restPaymentDueDate,
      placeOfSupply,
      vehicleNumber,
      receiverDetails,
      consigneeBilledTo,
      consigneeShippedTo,
      gstEffect,
      amountEffect,
    };

    const newInvoice = await Invoice.create(invoiceData);

    res.status(201).json({
      message: `Invoice (${invoiceType}) created successfully`,
      invoice: newInvoice,
    });
  } catch (error) {
    console.error("Error creating invoice:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Get All Invoices
exports.getAllInvoices = async (req, res) => {
  try {
    const invoices = await Invoice.findAll({
      include: [
        {
          model: SalesOrderHeader,
          as: "salesOrder",
          include: [{ model: SalesOrderLineItem, as: "lines" }],
        },
        { model: Customer, as: "customer" },
        { model: Distributor, as: "distributor" },
      ],
      order: [["invoiceDate", "DESC"]],
    });
    res.status(200).json(invoices);
  } catch (error) {
    res.status(500).json({ message: "Error fetching invoices", error: error.message });
  }
};

// Get Invoice By ID
exports.getInvoiceById = async (req, res) => {
  try {
    const invoice = await Invoice.findByPk(req.params.id, {
      include: [
        {
          model: SalesOrderHeader,
          as: "salesOrder",
          include: [{ model: SalesOrderLineItem, as: "lines" }],
        },
        { model: Customer, as: "customer" },
        { model: Distributor, as: "distributor" },
      ],
    });

    if (!invoice) return res.status(404).json({ message: "Invoice not found" });

    res.status(200).json(invoice);
  } catch (error) {
    res.status(500).json({ message: "Error fetching invoice", error: error.message });
  }
};

// Update Invoice (filter allowed fields)
exports.updateInvoice = async (req, res) => {
  try {
    const id = req.params.id;

    const allowedFields = [
      "paymentAmount",
      "restPaymentDueDate",
      "placeOfSupply",
      "vehicleNumber",
      "receiverDetails",
      "consigneeBilledTo",
      "consigneeShippedTo",
      "reason",
    ];

    const updateData = {};
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) updateData[field] = req.body[field];
    });

    const [updated] = await Invoice.update(updateData, { where: { id } });

    if (!updated) return res.status(404).json({ message: "Invoice not found or no changes made" });

    const invoice = await Invoice.findByPk(id, {
      include: [
        { model: SalesOrderHeader, as: "salesOrder" },
        { model: Customer, as: "customer" },
        { model: Distributor, as: "distributor" },
      ],
    });

    res.status(200).json({ message: "Invoice updated successfully", invoice });
  } catch (error) {
    res.status(500).json({ message: "Error updating invoice", error: error.message });
  }
};

// Delete Invoice
exports.deleteInvoice = async (req, res) => {
  try {
    const id = req.params.id;
    const deleted = await Invoice.destroy({ where: { id } });

    if (!deleted) return res.status(404).json({ message: "Invoice not found" });

    res.status(200).json({ message: "Invoice deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Error deleting invoice", error: error.message });
  }
};
