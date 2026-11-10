const db = require("../models");
const ItemGroup = db.ItemGroup;
const XLSX = require("xlsx");

exports.create = async (req, res) => {
  const distributorId = req.user.id;
  const { code, name } = req.body;

  const exists = await ItemGroup.findOne({
    where: { code, distributor_id: distributorId },
  });

  if (exists) {
    return res.status(400).json({ message: "Item group exists" });
  }

  const group = await ItemGroup.create({
    code: code.toUpperCase(),
    name,
    distributor_id: distributorId,
  });

  res.status(201).json(group);
};

exports.getAll = async (req, res) => {
  const distributorId = req.user.id;
  const groups = await ItemGroup.findAll({
    where: { distributor_id: distributorId },
  });
  res.json(groups);
};

exports.delete = async (req, res) => {
  const distributorId = req.user.id;
  const { id } = req.params;

  const group = await ItemGroup.findOne({
    where: { id, distributor_id: distributorId },
  });

  if (!group) {
    return res.status(404).json({ message: "Item group not found" });
  }

  await group.destroy();
  res.json({ message: "Item group deleted" });
};
// ===================== BULK UPLOAD ITEM GROUP =====================
exports.bulkUpload = async (req, res) => {
  const transaction = await db.sequelize.transaction();

  try {
    const distributorId = req.user.id;

    if (!req.file) {
      await transaction.rollback();
      return res.status(400).json({ message: "Excel file is required" });
    }

    const workbook = XLSX.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const sheetData = XLSX.utils.sheet_to_json(
      workbook.Sheets[sheetName]
    );

    if (!sheetData.length) {
      await transaction.rollback();
      return res.status(400).json({ message: "Excel file is empty" });
    }

    const existingGroups = await ItemGroup.findAll({
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

    if (newGroups.length > 0) {
      await ItemGroup.bulkCreate(newGroups, { transaction });
    }

    await transaction.commit();

    // File delete safely (outside transaction logic)
    if (req.file?.path) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (fileErr) {
        console.error("File delete error:", fileErr.message);
      }
    }

    return res.json({
      message: "Item Group bulk upload successful",
      inserted: newGroups.length,
      skipped,
    });

  } catch (err) {

    // rollback only if transaction not finished
    if (!transaction.finished) {
      await transaction.rollback();
    }

    return res.status(500).json({
      error: err.message,
    });
  }
};

