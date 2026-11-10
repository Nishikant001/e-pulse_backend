const db = require("../models");
const VendorGroup = db.VendorGroup;
const XLSX = require("xlsx");
const fs = require("fs");

exports.create = async (req, res) => {
  try {
    const distributorId = req.user.id;
    const { code, name } = req.body;

    if (!code || !name) {
      return res.status(400).json({ message: "code and name are required" });
    }

    const exists = await VendorGroup.findOne({
      where: { code, distributor_id: distributorId },
    });

    if (exists) {
      return res.status(400).json({ message: "Vendor group already exists" });
    }

    const group = await VendorGroup.create({
      code: code.toUpperCase(),
      name,
      distributor_id: distributorId,
    });

    res.status(201).json(group);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getAll = async (req, res) => {
  const distributorId = req.user.id;
  const groups = await VendorGroup.findAll({
    where: { distributor_id: distributorId },
    order: [["code", "ASC"]],
  });
  res.json(groups);
};

exports.delete = async (req, res) => {
  const distributorId = req.user.id;
  const { id } = req.params;

  const group = await VendorGroup.findOne({
    where: { id, distributor_id: distributorId },
  });

  if (!group) {
    return res.status(404).json({ message: "Vendor group not found" });
  }

  await group.destroy();
  res.json({ message: "Vendor group deleted" });
};
// ===================== BULK UPLOAD VENDOR GROUP =====================
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

    const existingGroups = await VendorGroup.findAll({
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

      existingCodes.push(code);
    }

    await VendorGroup.bulkCreate(newGroups, { transaction });
    await transaction.commit();

    fs.unlinkSync(req.file.path);

    res.json({
      message: "Vendor Group bulk upload successful",
      inserted: newGroups.length,
      skipped,
    });

  } catch (err) {
    await transaction.rollback();
    res.status(500).json({ error: err.message });
  }
};
