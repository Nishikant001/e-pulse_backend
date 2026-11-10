// services/distributorContext.js
//
// Lets the Admin API reuse the EXISTING, tenant-scoped sales controllers (salesOrder / salesdelivery / salesinvoice) instead of
// re-implementing them: the controller is invoked with a request whose `user` is the TARGET distributor (loaded from the
// database by the admin-authenticated route — never taken from the client). Every ownership check inside the existing
// controllers (customer, product, batch, order, delivery, invoice belong to `req.user.id`) therefore still applies unchanged.
//
// The controller's response is captured and returned; nothing is sent to the client from here.
const { QueryError } = require("./salesQuery");

class SalesError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = "SalesError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

async function loadDistributor(db, id) {
  const d = await db.Distributor.findOne({ where: { id }, attributes: ["id", "distributor_code", "name", "email"] }); // never loads the password hash
  if (!d) throw new SalesError(404, "DISTRIBUTOR_NOT_FOUND", "Distributor not found");
  return d;
}

function invokeAsDistributor(distributor, handler, { body = {}, params = {}, query = {} } = {}) {
  const req = {
    user: { id: distributor.id, distributor_code: distributor.distributor_code, name: distributor.name, email: distributor.email },
    body, params, query, headers: {}, cookies: {},
  };
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { finish({ status: this.statusCode, body: b }); return this; },
      send(b) { finish({ status: this.statusCode, body: b }); return this; },
      set() { return this; },
      setHeader() { return this; },
    };
    Promise.resolve(handler(req, res)).then(() => finish({ status: res.statusCode, body: null })).catch(reject);
  });
}

// Convert a failed controller response into a SalesError carrying the controller's own message.
function unwrap(result, fallback) {
  if (result.status >= 400) {
    const b = result.body || {};
    const message = b.error || b.message || fallback;
    const code = result.status === 404 ? "NOT_FOUND" : result.status === 400 ? "REJECTED" : "FAILED";
    throw new SalesError(result.status, code, message, b.details);
  }
  return result.body;
}

module.exports = { SalesError, QueryError, loadDistributor, invokeAsDistributor, unwrap };
