// controllers/scheme.controller.js — Phase 10 DISTRIBUTOR-side, READ-ONLY scheme visibility (existing distributor auth).
// The distributor is always req.user.id from the verified token. A distributorId/distributor_id in the query or body is
// never read; there is no create / update / status / delete route for distributors.
const engine = require("../services/schemeEngine.service");

async function handle(res, fn) {
  res.set && res.set("Cache-Control", "no-store");
  try {
    return res.json(await fn());
  } catch (err) {
    if (err instanceof engine.EngineError) return res.status(err.statusCode).json({ message: err.message, code: err.code });
    console.error("schemes (distributor) error:", err && err.message);
    return res.status(500).json({ message: "Unable to complete the request" });
  }
}

exports.applicable = (req, res) => handle(res, async () => ({ schemes: await engine.listApplicableForDistributor(req.user.id) }));
exports.evaluate = (req, res) =>
  handle(res, () => {
    const b = req.body || {};
    return engine.evaluate({ distributorId: req.user.id, customerId: b.customerId, lines: b.lines, asOf: b.asOf });
  });
