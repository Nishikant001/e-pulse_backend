// controllers/product.controller.js
const db = require("../models");
const Product = db.Product;
const Batch = db.Batch;
const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");
// controllers/product.controller.js

// Fields a client must never be able to change through an update body:
// tenant ownership, the primary key and the auto-generated material code.
const PROTECTED_PRODUCT_FIELDS = [
  "id",
  "distributor_id",
  "material_code",
  "createdAt",
  "updatedAt",
];

// ==================== Create Product ====================
exports.create = async (req, res) => {
  try {
    const distributorId = req.user.id;
    const { hsn_id } = req.body;

    const hsn = await db.HSNGroup.findOne({
      where: { id: hsn_id, distributor_id: distributorId },
    });

    if (!hsn) {
      return res.status(400).json({ message: "Invalid HSN selected" });
    }

    const product = await Product.create({
      ...req.body,
      distributor_id: distributorId,
    });

    res.status(201).json(product);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// ==================== Get All Products ====================
exports.getAll = async (req, res) => {
  try {
    const distributorId = req.user.id;

    const products = await Product.findAll({
      where: { distributor_id: distributorId },
      include: [
        { model: db.Batch, as: "batches" },
        { model: db.HSNGroup, as: "hsn" }, // 👈 THIS LINE IMPORTANT
      ],
    });

    res.json(products);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ==================== Get One Product ====================
exports.getOne = async (req, res) => {
  try {
    const distributorId = req.user.id;
    const product = await Product.findOne({
      where: { id: req.params.id, distributor_id: distributorId },
    });
    if (!product) return res.status(404).json({ message: "Not found" });
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ==================== Update Product ====================
exports.update = async (req, res) => {
  try {
    const distributorId = req.user.id;
    const product = await Product.findOne({
      where: { id: req.params.id, distributor_id: distributorId },
    });
    if (!product)
      return res.status(404).json({ message: "Not found or Unauthorized" });

    const changes = { ...req.body };
    for (const key of PROTECTED_PRODUCT_FIELDS) delete changes[key];
    // If the HSN is being changed it must belong to the same distributor.
    if (changes.hsn_id !== undefined && changes.hsn_id !== product.hsn_id) {
      const hsn = await db.HSNGroup.findOne({
        where: { id: changes.hsn_id, distributor_id: distributorId },
      });
      if (!hsn) {
        return res.status(400).json({ message: "Invalid HSN selected" });
      }
    }
    await product.update(changes);
    res.json(product);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// ==================== Delete Product ====================
exports.delete = async (req, res) => {
  try {
    const distributorId = req.user.id;
    const product = await Product.findOne({
      where: { id: req.params.id, distributor_id: distributorId },
    });
    if (!product)
      return res.status(404).json({ message: "Not found or Unauthorized" });

    await product.destroy();
    res.json({ message: "Deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ==================== Bulk Upload from Excel ====================
exports.bulkUpload = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "Please upload an Excel file" });
    }

    const distributorId = req.user.id;
    const filePath = path.join(__dirname, "../uploads", req.file.filename);

    // Read Excel file
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

    if (!data.length) {
      return res.status(400).json({ message: "No data found in Excel file" });
    }

    const batches = [];
    const errors = [];

    for (let row of data) {
      const {
        batch_no,
        material_code,
        quantity,
        status,
        price,
        mfg_date,
        exp_date,
        name,
        unit,
        description,
        category,
        mfg_by,
        plant,
        weight,
        drug_licence_number,
        country_of_origin,
        hsn_code,
      } = row;

      if (!quantity) {
        errors.push({ row, error: "quantity is required" });
        continue;
      }

      // Find or create product
      let product = null;
      if (material_code) {
        product = await Product.findOne({
          where: { material_code, distributor_id: distributorId },
        });
      }
      // 🔎 Find HSN
      // 🔎 Find HSN
      const hsn = await db.HSNGroup.findOne({
        where: {
          hsn_code,
          distributor_id: distributorId,
        },
      });

      if (!hsn) {
        errors.push({
          row,
          error: `HSN ${hsn_code} not found`,
        });
        continue;
      }

      if (!product) {
        // Auto-create product (material_code auto-gen handled by hook)
        product = await Product.create({
          material_code: material_code || null, // if missing, hook generates
          name: name || material_code || "Unnamed Product",
          unit: unit || "PCS",
          description,
          category,
          mfg_by,
          plant,
          weight,
          drug_licence_number,
          hsn_id: hsn.id,
          country_of_origin,

          distributor_id: distributorId,
        });
      }

      // Auto-generate batch_no if missing
      let finalBatchNo = batch_no;
      if (!batch_no) {
        const lastBatch = await Batch.findOne({
          where: { productId: product.id },
          order: [["id", "DESC"]],
        });
        let lastNumber = 0;
        if (lastBatch && lastBatch.batch_no) {
          const match = lastBatch.batch_no.match(/\d+$/);
          if (match) lastNumber = parseInt(match[0], 10);
        }
        finalBatchNo = `BATCH${(lastNumber + 1).toString().padStart(4, "0")}`;
      }

      batches.push({
        batch_no: finalBatchNo,
        quantity,
        status: status || "available",
        distributor_id: distributorId,
        productId: product.id,
        mfg_date: mfg_date ? new Date(mfg_date) : null,
        exp_date: exp_date ? new Date(exp_date) : null,
        price: price !== undefined ? price : 0,
      });
    }

    // Insert valid batches
    if (batches.length > 0) {
      await Batch.bulkCreate(batches);
    }

    // Clean temp file
    fs.unlinkSync(filePath);

    res.status(200).json({
      message: "Bulk upload completed",
      totalRows: data.length,
      batchesInserted: batches.length,
      errors,
    });
  } catch (error) {
    console.error("Error bulk uploading batches:", error);
    res
      .status(500)
      .json({ message: "Error bulk uploading batches", error: error.message });
  }
};
