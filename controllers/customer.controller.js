const db = require("../models");
const Customer = db.Customer;
const Address = db.Address;

// Fields a client must never be able to set through a request body:
// tenant ownership, the primary key, the auto-generated business code and
// the association payload (addresses are handled explicitly below).
const PROTECTED_CUSTOMER_FIELDS = [
  "id",
  "distributor_id",
  "customer_code",
  "addresses",
  "createdAt",
  "updatedAt",
];
function stripProtected(body, fields) {
  const clean = { ...body };
  for (const key of fields) delete clean[key];
  return clean;
}

// 📌 Create customer with optional addresses
exports.create = async (req, res) => {
  const t = await db.sequelize.transaction();
  try {
    const distributorId = req.user.id;

    // Create the customer
    const customer = await Customer.create(
      { ...req.body, distributor_id: distributorId },
      { transaction: t }
    );

    // If addresses are provided, create them
    if (Array.isArray(req.body.addresses) && req.body.addresses.length > 0) {
      const addresses = req.body.addresses.map(addr => ({
        ...addr,
        customer_id: customer.id
      }));
      await Address.bulkCreate(addresses, { transaction: t });
    }

    await t.commit();

    // Fetch customer with addresses for response
    const newCustomer = await Customer.findByPk(customer.id, {
      include: [{ model: Address, as: "addresses" }]
    });

    res.status(201).json(newCustomer);

  } catch (err) {
    await t.rollback();
    res.status(400).json({ error: err.message });
  }
};

// 📌 Get all customers for the logged-in distributor
exports.getAll = async (req, res) => {
  try {
    const distributorId = req.user.id;
    const customers = await Customer.findAll({
      where: { distributor_id: distributorId },
      include: [{ model: Address, as: "addresses" }]
    });
    res.json(customers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// 📌 Get one customer with addresses
exports.getOne = async (req, res) => {
  try {
    // Tenant-scoped: a distributor may only read its own customers.
    const customer = await Customer.findOne({
      where: { id: req.params.id, distributor_id: req.user.id },
      include: [{ model: Address, as: "addresses" }]
    });
    if (!customer) return res.status(404).json({ message: "Not found" });
    res.json(customer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }  
};

// 📌 Update customer and addresses
exports.update = async (req, res) => {
  const t = await db.sequelize.transaction();
  try {
    // Tenant-scoped lookup (previously findByPk with no owner check).
    const customer = await Customer.findOne({
      where: { id: req.params.id, distributor_id: req.user.id },
      include: [{ model: Address, as: "addresses" }]
    });
    if (!customer) {
      // Release the open transaction/connection before returning.
      await t.rollback();
      return res.status(404).json({ message: "Not found" });
    }

    await customer.update(stripProtected(req.body, PROTECTED_CUSTOMER_FIELDS), { transaction: t });

    if (Array.isArray(req.body.addresses)) {
      // Delete old addresses & insert new ones
      await Address.destroy({ where: { customer_id: customer.id }, transaction: t });
      const addresses = req.body.addresses.map(addr => ({
        ...addr,
        customer_id: customer.id
      }));
      await Address.bulkCreate(addresses, { transaction: t });
    }

    await t.commit();

    const updatedCustomer = await Customer.findByPk(customer.id, {
      include: [{ model: Address, as: "addresses" }]
    });

    res.json(updatedCustomer);

  } catch (err) {
    await t.rollback();
    res.status(400).json({ error: err.message });
  }
};

// 📌 Delete customer and its addresses
exports.delete = async (req, res) => {
  try {
    const customer = await Customer.findOne({
      where: { id: req.params.id, distributor_id: req.user.id },
    });
    if (!customer) return res.status(404).json({ message: "Not found" });

    // Phase 9: a retailer with any order / invoice / return / ledger history is never hard-deleted — deactivate it instead.
    if (await require("../services/retailers.service").hasBusinessHistory(db, customer.id)) {
      return res.status(409).json({ message: "This retailer has business history and cannot be deleted. Deactivate it instead.", code: "HAS_HISTORY" });
    }

    await customer.destroy();
    res.json({ message: "Deleted successfully" });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// 📌 Get count of customers for logged-in distributor
exports.getCustomerCount = async (req, res) => {
  try {
    const distributorId = req.user.id;
    const count = await Customer.count({
      where: { distributor_id: distributorId }
    });
    res.json({ distributor_id: distributorId, customerCount: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
// controller
exports.getCustomerAddresses = async (req, res) => {
  const { customerId } = req.params;
  const { type } = req.query; // "sold_to_party", "ship_to_party", ... OR "all"

  try {
    let includeOptions = [];

    if (type === "all") {
      // Get all addresses
      includeOptions = [{ model: Address, as: "addresses" }];
    } else {
      // Get only one type
      includeOptions = [{
        model: Address,
        as: "addresses",
        where: { type },
        required: false
      }];
    }

    const customer = await Customer.findOne({
      where: { id: customerId, distributor_id: req.user.id },
      include: includeOptions,
    });

    res.json(customer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
};
exports.getCustomerByCode = async (req, res) => {
  try {
    const { code } = req.params;

    const customer = await Customer.findOne({
      where: { customer_code: code, distributor_id: req.user.id },
    });

    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    res.json(customer);
  } catch (error) {
    console.error("Error fetching customer by code:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
}; 