const db = require("../models");
const PricingMaster = db.PricingMaster;
const Product = db.Product;
const CustomerGroup = db.CustomerGroup;

// Fields a client must never be able to change through an update body.
const PROTECTED_PRICING_FIELDS = [
  "id",
  "distributor_id",
  "createdAt",
  "updatedAt",
];

// Referenced product / customer group must belong to the same distributor,
// otherwise a pricing row could point at another tenant's master data.
async function assertOwnedReferences(distributorId, { productId, customer_group_id }) {
  if (productId !== undefined && productId !== null) {
    const product = await Product.findOne({ where: { id: productId, distributor_id: distributorId } });
    if (!product) return "Invalid product selected";
  }
  if (customer_group_id !== undefined && customer_group_id !== null) {
    const group = await CustomerGroup.findOne({ where: { id: customer_group_id, distributor_id: distributorId } });
    if (!group) return "Invalid customer group selected";
  }
  return null;
}

// CREATE
exports.create = async (req, res) => {
  try {
    const distributorId = req.user.id;

    const {
      productId,
      customer_group_id,
      base_price,
      discount_percent,
      valid_from,
      valid_to,
    } = req.body;

    const refError = await assertOwnedReferences(distributorId, { productId, customer_group_id });
    if (refError) return res.status(400).json({ message: refError });

    const pricing = await PricingMaster.create({
      productId,
      customer_group_id,
      base_price,
      discount_percent,
      valid_from,
      valid_to,
      distributor_id: distributorId,
    });

    res.status(201).json(pricing);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// GET ALL
exports.getAll = async (req, res) => {
  try {
    const distributorId = req.user.id;

    const pricing = await PricingMaster.findAll({
      where: { distributor_id: distributorId },
      include: [
        { model: Product, as: "product" },
        { model: CustomerGroup, as: "customerGroup" },
      ],
    });

    res.json(pricing);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// UPDATE
exports.update = async (req, res) => {
  try {
    const distributorId = req.user.id;
    const { id } = req.params;

    const pricing = await PricingMaster.findOne({
      where: { id, distributor_id: distributorId },
    });

    if (!pricing)
      return res.status(404).json({ message: "Pricing not found" });

    const changes = { ...req.body };
    for (const key of PROTECTED_PRICING_FIELDS) delete changes[key];
    const refError = await assertOwnedReferences(distributorId, {
      productId: changes.productId,
      customer_group_id: changes.customer_group_id,
    });
    if (refError) return res.status(400).json({ message: refError });
    await pricing.update(changes);

    res.json(pricing);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// DELETE
exports.delete = async (req, res) => {
  try {
    const distributorId = req.user.id;
    const { id } = req.params;

    const pricing = await PricingMaster.findOne({
      where: { id, distributor_id: distributorId },
    });

    if (!pricing)
      return res.status(404).json({ message: "Pricing not found" });

    await pricing.destroy();

    res.json({ message: "Deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
