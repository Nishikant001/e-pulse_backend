const db = require("../models");
const GLMaster = db.GLMaster;
const XLSX = require("xlsx");
const fs = require("fs");

// ================== CREATE SINGLE ==================
exports.createGL = async (req, res) => {
  try {
    const { gl_name, gl_type, opening_balance } = req.body;
    const distributor_code = req.user.distributor_code;

    const exists = await GLMaster.findOne({ where: { gl_name, distributor_code } });
    if (exists) return res.status(400).json({ message: "GL Already Exists" });

    const gl = await GLMaster.create({
      distributor_code,
      gl_name,
      gl_type,
      opening_balance: opening_balance || 0
    });

    res.status(201).json({ message: "GL Created Successfully", gl });
  } catch (err) {
    console.error("Error creating GL account:", err.message);
    res.status(500).json({ error: "Error creating GL account" });
  }
};


// ================== GET ALL ==================
exports.getAllGL = async (req, res) => {
  try {
    const distributor_code = req.user.distributor_code;

    const list = await GLMaster.findAll({
      where: { distributor_code },
      order: [["id", "ASC"]]
    });

    res.json(list);
  } catch (error) {
    console.error("Error fetching GL accounts:", error.message);
    res.status(500).json({ message: "Error fetching GL accounts" });
  }
};


// ================== UPDATE GL ==================
exports.updateGL = async (req, res) => {
  try {
    const id = req.params.id;
    const distributor_code = req.user.distributor_code;

    const gl = await GLMaster.findOne({ where: { id, distributor_code } });
    if (!gl) return res.status(404).json({ message: "GL not found for this distributor" });

    // Explicit allow-list: never let the request body reassign
    // distributor_code (would silently move the account to another
    // tenant's ledger) or gl_name in a way that could collide with the
    // unique (distributor_code, gl_name) constraint unexpectedly.
    const { gl_name, gl_type, opening_balance } = req.body;
    await gl.update({
      gl_name: gl_name ?? gl.gl_name,
      gl_type: gl_type ?? gl.gl_type,
      opening_balance: opening_balance ?? gl.opening_balance,
    });
    res.json({ message: "GL Updated Successfully", gl });
  } catch (error) {
    console.error("Error updating GL account:", error.message);
    res.status(500).json({ message: "Error updating GL account" });
  }
};


// ================== DELETE GL ==================
exports.deleteGL = async (req, res) => {
  try {
    const id = req.params.id;
    const distributor_code = req.user.distributor_code;

    const gl = await GLMaster.findOne({ where: { id, distributor_code } });
    if (!gl) return res.status(404).json({ message: "GL not found" });

    const entryExists = await db.JournalEntry.findOne({ where: { gl_id: id, distributor_code } });
    if (entryExists) return res.status(400).json({ message: "GL in use, cannot delete" });

    await gl.destroy();
    res.json({ message: "GL Deleted" });
  } catch (error) {
    console.error("Error deleting GL account:", error.message);
    res.status(500).json({ message: "Error deleting GL account" });
  }
};


// ================== BULK UPLOAD VIA EXCEL ==================
exports.uploadGL = async (req, res) => {
  const distributor_code = req.user.distributor_code;
  let filePath;

  try {
    if (!req.file) return res.status(400).json({ message: "File required" });
    filePath = req.file.path;

    const workbook = XLSX.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    if (!rows.length) return res.status(400).json({ message: "Excel Empty" });

    const t = await db.sequelize.transaction();
    try {
      let created = 0;
      for (let row of rows) {
        if (!row.gl_name || !row.gl_type) continue;

        const [, wasCreated] = await GLMaster.findOrCreate({
          where: { gl_name: row.gl_name, distributor_code },
          defaults: {
            distributor_code,
            gl_type: row.gl_type,
            opening_balance: row.opening_balance || 0
          },
          transaction: t
        });
        if (wasCreated) created++;
      }

      await t.commit();
      res.json({ message: "GL Bulk Upload Success", total: rows.length, created });
    } catch (err) {
      await t.rollback();
      throw err;
    }
  } catch (err) {
    console.error("Error bulk uploading GL:", err.message);
    res.status(500).json({ error: "Error processing GL upload" });
  } finally {
    if (filePath) {
      fs.unlink(filePath, () => {});
    }
  }
};
