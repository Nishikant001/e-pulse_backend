const db = require("../models");
const HSNGroup = db.HSNGroup;
const XLSX = require("xlsx");
const fs = require("fs");

// ================= CREATE =================
exports.create = async (req, res) => {
  try {
    const distributorId = req.user.id;
    const { hsn_code, description, gst_rate } = req.body;

    if (!hsn_code || !description || gst_rate === undefined) {
      return res.status(400).json({
        message: "HSN code, description & GST rate required",
      });
    }

    const exists = await HSNGroup.findOne({
      where: { hsn_code, distributor_id: distributorId },
    });

    if (exists) {
      return res.status(400).json({
        message: "HSN already exists",
      });
    }

    const hsn = await HSNGroup.create({
      hsn_code,
      description,
      gst_rate,
      distributor_id: distributorId,
    });

    res.status(201).json(hsn);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ================= GET ALL =================
exports.getAll = async (req, res) => {
  try {
    const distributorId = req.user.id;

    const data = await HSNGroup.findAll({
      where: { distributor_id: distributorId },
      order: [["hsn_code", "ASC"]],
    });

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ================= UPDATE =================
// (Phase 7 — Tax Master editing. Genuinely missing before this phase: create/getAll/delete/bulkUpload existed,
// but nothing let a distributor correct a description or GST rate without deleting and recreating the row.)
exports.update = async (req, res) => {
  try {
    const distributorId = req.user.id;
    const { id } = req.params;

    const hsn = await HSNGroup.findOne({ where: { id, distributor_id: distributorId } });
    if (!hsn) return res.status(404).json({ message: "HSN not found" });

    const { hsn_code, description, gst_rate } = req.body;

    if (hsn_code !== undefined && hsn_code !== hsn.hsn_code) {
      const exists = await HSNGroup.findOne({
        where: { hsn_code, distributor_id: distributorId, id: { [db.Sequelize.Op.ne]: id } },
      });
      if (exists) return res.status(400).json({ message: "HSN already exists" });
    }
    if (gst_rate !== undefined && (isNaN(Number(gst_rate)) || Number(gst_rate) < 0 || Number(gst_rate) > 100)) {
      return res.status(400).json({ message: "GST rate must be between 0 and 100" });
    }

    const changes = {};
    if (hsn_code !== undefined) changes.hsn_code = hsn_code;
    if (description !== undefined) changes.description = description;
    if (gst_rate !== undefined) changes.gst_rate = gst_rate;

    await hsn.update(changes);
    res.json(hsn);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ================= DELETE =================
exports.delete = async (req, res) => {
  try {
    const distributorId = req.user.id;
    const { id } = req.params;

    const hsn = await HSNGroup.findOne({
      where: { id, distributor_id: distributorId },
    });

    if (!hsn) {
      return res.status(404).json({ message: "HSN not found" });
    }

    await hsn.destroy();
    res.json({ message: "HSN deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ================= BULK UPLOAD =================
exports.bulkUpload = async (req, res) => {
  const transaction = await db.sequelize.transaction();

  try {
    const distributorId = req.user.id;

    if (!req.file) {
      return res.status(400).json({ message: "Excel file required" });
    }

    const workbook = XLSX.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const sheetData = XLSX.utils.sheet_to_json(
      workbook.Sheets[sheetName]
    );

    const existing = await HSNGroup.findAll({
      where: { distributor_id: distributorId },
      attributes: ["hsn_code"],
    });

    const existingCodes = existing.map(e => e.hsn_code);

    const newHSN = [];
    let skipped = 0;

    for (const row of sheetData) {
      const code = row.hsn_code?.toString();
      const description = row.description;
      const gst_rate = parseFloat(row.gst_rate);

      if (!code || !description || isNaN(gst_rate) || existingCodes.includes(code)) {
        skipped++;
        continue;
      }

      newHSN.push({
        hsn_code: code,
        description,
        gst_rate,
        distributor_id: distributorId,
      });

      existingCodes.push(code);
    }

    if (newHSN.length > 0) {
      await HSNGroup.bulkCreate(newHSN, { transaction });
    }

    await transaction.commit();

    fs.unlinkSync(req.file.path);

    res.json({
      message: "HSN bulk upload successful",
      inserted: newHSN.length,
      skipped,
    });

  } catch (err) {
    if (!transaction.finished) {
      await transaction.rollback();
    }
    res.status(500).json({ error: err.message });
  }
};
