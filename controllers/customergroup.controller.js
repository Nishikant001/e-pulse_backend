// controllers/customergroup.controller.js
const db = require("../models");
const CustomerGroup = db.CustomerGroup;
const XLSX = require("xlsx");
const fs = require("fs");

// ===================== CREATE CUSTOMER GROUP =====================
exports.create = async (req, res) => {
  try {
    const distributorId = req.user.id;
    const { code, name } = req.body;
    

    if (!code || !name) {
      return res.status(400).json({
        message: "code and name are required",
      });
    }

    // avoid duplicate group code per distributor
    const exists = await CustomerGroup.findOne({
      where: { code, distributor_id: distributorId },
    });

    if (exists) {
      return res.status(400).json({
        message: "Customer group already exists",
      });
    }

    const group = await CustomerGroup.create({
      code: code.toUpperCase(), // RETAIL, WHOLESALE
      name,
      distributor_id: distributorId,
    });

    res.status(201).json(group);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ===================== GET ALL GROUPS (DISTRIBUTOR WISE) =====================
exports.getAll = async (req, res) => {
  try {
    const distributorId = req.user.id;

    const groups = await CustomerGroup.findAll({
      where: { distributor_id: distributorId },
      order: [["code", "ASC"]],
    });

    res.json(groups);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ===================== GET ONE GROUP =====================
exports.getOne = async (req, res) => {
  try {
    const distributorId = req.user.id;
    const { id } = req.params;

    const group = await CustomerGroup.findOne({
      where: { id, distributor_id: distributorId },
    });

    if (!group) {
      return res.status(404).json({ message: "Customer group not found" });
    }

    res.json(group);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ===================== UPDATE GROUP =====================
exports.update = async (req, res) => {
  try {
    const distributorId = req.user.id;
    const { id } = req.params;
    const { name } = req.body;

    const group = await CustomerGroup.findOne({
      where: { id, distributor_id: distributorId },
    });

    if (!group) {
      return res.status(404).json({ message: "Customer group not found" });
    }

    await group.update({ name });

    res.json({ message: "Customer group updated", group });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ===================== DELETE GROUP =====================
exports.delete = async (req, res) => {
  try {
    const distributorId = req.user.id;
    const { id } = req.params;

    const group = await CustomerGroup.findOne({
      where: { id, distributor_id: distributorId },
    });

    if (!group) {
      return res.status(404).json({ message: "Customer group not found" });
    }

    await group.destroy();

    res.json({ message: "Customer group deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};



// ===================== BULK UPLOAD CUSTOMER GROUP =====================
exports.bulkUpload = async (req, res) => {
  const transaction = await db.sequelize.transaction();
  try {
    const distributorId = req.user.id;

    if (!req.file) {
      return res.status(400).json({ message: "Excel file is required" });
    }

    const workbook = XLSX.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const sheetData = XLSX.utils.sheet_to_json(
      workbook.Sheets[sheetName]
    );

    if (!sheetData.length) {
      return res.status(400).json({ message: "Excel file is empty" });
    }

    // Get existing codes for this distributor
    const existingGroups = await CustomerGroup.findAll({
      where: { distributor_id: distributorId },
      attributes: ["code"],
    });

    const existingCodes = existingGroups.map(g => g.code);

    const newGroups = [];
    let skipped = 0;

    for (const row of sheetData) {
      const code = row.code?.toUpperCase();
      const name = row.name;

      if (!code || !name || existingCodes.includes(code)) {
        skipped++;
        continue;
      }

      newGroups.push({
        code,
        name,
        distributor_id: distributorId,
      });

      existingCodes.push(code); // prevent duplicate inside same file
    }

    // Bulk insert
    await CustomerGroup.bulkCreate(newGroups, { transaction });

    await transaction.commit();

    // delete uploaded file
    fs.unlinkSync(req.file.path);

    res.json({
      message: "Bulk upload successful",
      inserted: newGroups.length,
      skipped,
    });

  } catch (err) {
    await transaction.rollback();
    res.status(500).json({ error: err.message });
  }
};
