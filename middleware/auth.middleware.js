const jwt = require("jsonwebtoken");
require("dotenv").config();

module.exports = function (req, res, next) {
  let token = null;

  // 1️⃣ Try cookie
  if (req.cookies?.access_token) {
    token = req.cookies.access_token;
  }

  // 2️⃣ Try Authorization header (Bearer token)
  if (!token && req.headers.authorization) {
    token = req.headers.authorization.split(" ")[1];
  }

  if (!token) {
    return res.status(401).json({
      message: "Access Denied: No token provided",
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({
      message: "Unauthorized: Invalid or expired token",
    });
  }
};
