// controllers/vendor.controller.js
const db = require("../models");
const Vendor = db.Vendor;
const Address = db.Address;

// 📌 Create vendor with optional addresses
exports.create = async (req, res) => {
  const t = await db.sequelize.transaction();
  try {
    const distributorId = req.user.id;

    // Create Vendor
    const vendor = await Vendor.create(
      { ...req.body, distributor_id: distributorId },
      { transaction: t }
    );

    // Create Addresses (if provided)
    if (Array.isArray(req.body.addresses) && req.body.addresses.length > 0) {
      const addresses = req.body.addresses.map((addr) => ({
        ...addr,
        vendor_id: vendor.id,
      }));
      await Address.bulkCreate(addresses, { transaction: t });
    }

    // ✅ Commit before fetching
    await t.commit();

    // Now safely fetch without transaction
    const newVendor = await Vendor.findByPk(vendor.id, {
      include: [{ model: Address, as: "addresses" }],
    });

    res.status(201).json(newVendor);
  } catch (error) {
    // ✅ Only rollback if transaction not already finished
    if (!t.finished) await t.rollback();
    res.status(400).json({ error: error.message });
  }
};


// 📌 Get all vendors for the logged-in distributor
exports.getAll = async (req, res) => {
  try {
    const distributorId = req.user.id;
    const vendors = await Vendor.findAll({
      where: { distributor_id: distributorId },
      include: [{ model: Address, as: "addresses" }],
    });
    res.json(vendors);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Fields a client must never be able to set through a request body.
const PROTECTED_VENDOR_FIELDS = [
  "id",
  "distributor_id",
  "vendor_code",
  "addresses",
  "createdAt",
  "updatedAt",
];
function stripProtected(body, fields) {
  const clean = { ...body };
  for (const key of fields) delete clean[key];
  return clean;
}

// 📌 Get one vendor with addresses
exports.getOne = async (req, res) => {
  try {
    // Tenant-scoped: a distributor may only read its own vendors.
    const vendor = await Vendor.findOne({
      where: { id: req.params.id, distributor_id: req.user.id },
      include: [{ model: Address, as: "addresses" }],
    });
    if (!vendor) return res.status(404).json({ message: "Vendor not found" });
    res.json(vendor);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// 📌 Update vendor and its addresses
exports.update = async (req, res) => {
  const t = await db.sequelize.transaction();
  try {
    // Tenant-scoped lookup (previously findByPk with no owner check).
    const vendor = await Vendor.findOne({
      where: { id: req.params.id, distributor_id: req.user.id },
      include: [{ model: Address, as: "addresses" }],
    });
    if (!vendor) {
      // Release the open transaction/connection before returning.
      await t.rollback();
      return res.status(404).json({ message: "Vendor not found" });
    }

    await vendor.update(stripProtected(req.body, PROTECTED_VENDOR_FIELDS), { transaction: t });

    if (Array.isArray(req.body.addresses)) {
      // Delete old addresses & insert new ones
      await Address.destroy({ where: { vendor_id: vendor.id }, transaction: t });
      const addresses = req.body.addresses.map((addr) => ({
        ...addr,
        vendor_id: vendor.id,
      }));
      await Address.bulkCreate(addresses, { transaction: t });
    }

    await t.commit();

    const updatedVendor = await Vendor.findByPk(vendor.id, {
      include: [{ model: Address, as: "addresses" }],
    });

    res.json(updatedVendor);
  } catch (error) {
    await t.rollback();
    res.status(400).json({ error: error.message });
  }
};

// 📌 Delete vendor (and its addresses via CASCADE)
exports.delete = async (req, res) => {
  try {
    const vendor = await Vendor.findOne({
      where: { id: req.params.id, distributor_id: req.user.id },
    });
    if (!vendor) return res.status(404).json({ message: "Vendor not found" });

    await vendor.destroy();
    res.json({ message: "Vendor deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// 📌 Count vendors for a distributor
exports.getVendorCount = async (req, res) => {
  try {
    const distributorId = req.user.id;
    const count = await Vendor.count({ where: { distributor_id: distributorId } });
    res.json({ distributor_id: distributorId, vendorCount: count });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// 📌 Get vendor addresses by type or all
exports.getVendorAddresses = async (req, res) => {
  const { vendorId } = req.params;
  const { type } = req.query; // sold_to_party, ship_to_party, bill_to_party, payer, or all

  try {
    let includeOptions = [];

    // 🟢 Case 1: Fetch all addresses (default if type not given)
    if (!type || type === "all") {
      includeOptions = [{ model: Address, as: "addresses" }];
    } 
    // 🟢 Case 2: Fetch addresses of specific type
    else {
      includeOptions = [
        {
          model: Address,
          as: "addresses",
          where: { type },
          required: false,
        },
      ];
    }

    const vendor = await Vendor.findOne({
      where: { id: vendorId, distributor_id: req.user.id },
      include: includeOptions,
    });

    if (!vendor) return res.status(404).json({ message: "Vendor not found" });
    res.json(vendor);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

