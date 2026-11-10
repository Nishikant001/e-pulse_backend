// controllers/batch.controller.js
const db = require("../models");
const Batch = db.Batch;
const Product = db.Product;
const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");
const { validateBatchInput, BatchValidationError } = require("../services/batchValidation.service");

// =======================
// CREATE BATCH (IDENTITY ONLY)
// =======================
exports.createBatch = async (req, res) => {
  try {
    const { productId } = req.body;
    const distributorId = req.user.id;

    if (!req.body.batch_no || !productId) {
      return res.status(400).json({
        message: "batch_no and productId are required",
      });
    }

    // Server-side validation (Phase 5): product ownership, batch number, duplicate batch, MFG/EXP order, money fields.
    const { values } = await validateBatchInput({ distributorId, productId, input: req.body });

    const batch = await db.Batch.create({
      ...values,
      status: values.status || "active",
      distributor_id: distributorId,
      productId,
    });

    res.status(201).json({
      message: "Batch created successfully",
      batch,
    });

  } catch (error) {
    if (error instanceof BatchValidationError) {
      return res.status(error.statusCode).json({ message: error.message, code: error.code });
    }
    res.status(500).json({
      message: "Error creating batch",
      error: error.message,
    });
  }
};



// =======================
// GET ALL BATCHES (DISTRIBUTOR WISE)
// =======================
exports.getAllBatches = async (req, res) => {
  try {
    const distributorId = req.user.id;

    const batches = await db.Batch.findAll({
      where: { distributor_id: distributorId },
      include: [
        {
          model: db.Product,
          as: "product",
          attributes: ["name", "material_code", "unit"],
        },
      ],
      order: [["createdAt", "DESC"]],
    });

    res.json(batches);

  } catch (error) {
    res.status(500).json({
      message: "Error fetching batches",
      error: error.message,
    });
  }
};


// =======================
// GET BATCHES BY PRODUCT
// =======================
exports.getBatchesByProduct = async (req, res) => {
  try {
    const { productId } = req.params;
    const distributorId = req.user.id;

    const batches = await Batch.findAll({
      where: {
        productId,
        distributor_id: distributorId,
      },
    });

    if (!batches.length) {
      return res.status(404).json({
        message: "No batches found for this product",
      });
    }

    res.status(200).json(batches);
  } catch (error) {
    res.status(500).json({
      message: "Error fetching batches",
      error: error.message,
    });
  }
};

// =======================
// GET SINGLE BATCH
// =======================
exports.getBatchById = async (req, res) => {
  try {
    const distributorId = req.user.id;

    const batch = await db.Batch.findOne({
      where: { id: req.params.id, distributor_id: distributorId },
      include: [
        {
          model: db.Product,
          as: "product",
        },
      ],
    });

    if (!batch) {
      return res.status(404).json({ message: "Batch not found" });
    }

    res.json(batch);

  } catch (error) {
    res.status(500).json({
      message: "Error fetching batch",
      error: error.message,
    });
  }
};


// =======================
// UPDATE BATCH (DATES ONLY)
// =======================
exports.updateBatch = async (req, res) => {
  try {
    const distributorId = req.user.id;

    const batch = await db.Batch.findOne({
      where: { id: req.params.id, distributor_id: distributorId },
    });

    if (!batch) {
      return res.status(404).json({ message: "Batch not found" });
    }

    // Only the fields actually sent are validated, so a legacy batch can still get e.g. a status change (see docs).
    const allowed = ["mfg_date", "exp_date", "purchase_price", "mrp", "status", "batch_no"];
    const input = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
    const { values } = await validateBatchInput({ distributorId, productId: batch.productId, input, existing: batch });

    await batch.update(values);

    res.json({
      message: "Batch updated successfully",
      batch,
    });

  } catch (error) {
    if (error instanceof BatchValidationError) {
      return res.status(error.statusCode).json({ message: error.message, code: error.code });
    }
    res.status(500).json({
      message: "Error updating batch",
      error: error.message,
    });
  }
};


// =======================
// DELETE BATCH (ONLY IF NO STOCK MOVEMENT)
// =======================
exports.deleteBatch = async (req, res) => {
  try {
    const distributorId = req.user.id;

    const stockCount = await db.StockLedger.count({
      where: {
        batchId: req.params.id,
        distributor_id: distributorId,
      },
    });

    if (stockCount > 0) {
      return res.status(400).json({
        message: "Cannot delete batch with stock movement history",
      });
    }

    const batch = await db.Batch.findOne({
      where: { id: req.params.id, distributor_id: distributorId },
    });

    if (!batch) {
      return res.status(404).json({ message: "Batch not found" });
    }

    await batch.destroy();

    res.json({ message: "Batch deleted successfully" });

  } catch (error) {
    res.status(500).json({
      message: "Error deleting batch",
      error: error.message,
    });
  }
};


// =======================
// BULK UPLOAD BATCHES (IDENTITY ONLY)
// =======================
exports.bulkUploadBatches = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "Please upload an Excel file" });
    }

    const distributorId = req.user.id;
    const filePath = path.join(__dirname, "../uploads", req.file.filename);

    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

    const batches = [];
    const errors = [];

    for (let row of data) {
      const { batch_no,  mfg_date, exp_date } = row;

      if (!batch_no ) {
        errors.push({ row, error: "batch_no and material_code required" });
        continue;
      }

      const product = await Product.findOne({
        where: { material_code, distributor_id: distributorId },
      });

      if (!product) {
        errors.push({
          row,
          error: `Product  not found`,
        });
        continue;
      }

      batches.push({
        batch_no,
       
        mfg_date: mfg_date || null,
        exp_date: exp_date || null,
        distributor_id: distributorId,
        productId: product.id,
      });
    }

    if (batches.length) {
      await Batch.bulkCreate(batches);
    }

    fs.unlinkSync(filePath);

    res.status(200).json({
      message: "Bulk batch upload completed",
      inserted: batches.length,
      failed: errors.length,
      errors,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error bulk uploading batches",
      error: error.message,
    });
  }
};

// =======================
// COUNT BATCHES (DISTRIBUTOR WISE)
// =======================
exports.getBatchCountByDistributor = async (req, res) => {
  try {
    const distributorId = req.user.id;

    const count = await Batch.count({
      where: { distributor_id: distributorId },
    });

    res.status(200).json({
      distributor_id: distributorId,
      batchCount: count,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error counting batches",
      error: error.message,
    });
  }
};
