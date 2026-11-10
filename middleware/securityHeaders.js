// middleware/securityHeaders.js — Phase 23. Dependency-free response hardening for the JSON API.
//
// The API serves JSON only (no HTML, no static files), so a locked-down policy is safe:
//   • X-Content-Type-Options / X-Frame-Options / Referrer-Policy / Permissions-Policy / CSP "default-src 'none'; frame-ancestors 'none'"
//   • Cache-Control: no-store on every /api response unless a handler already chose a policy → authenticated, tenant-specific data is never
//     stored by a browser or shared cache. (Handlers that set their own Cache-Control keep it.)
//   • Strict-Transport-Security only in production AND only when the request really arrived over HTTPS (req.secure, which honours TRUST_PROXY).
// The frontend's own headers (CSP for the SPA, HSTS for the site) belong to the web server that serves the built files — see PHASE23_SECURITY_REPORT.md.
function securityHeaders(req, res, next) {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "X-DNS-Prefetch-Control": "off",
  });
  if (process.env.NODE_ENV === "production" && req.secure && process.env.HSTS_DISABLED !== "true") {
    res.set("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
  // Apply the default only when nothing else has set one by the time headers are flushed.
  const writeHead = res.writeHead;
  res.writeHead = function patchedWriteHead(...args) {
    if (!res.getHeader("Cache-Control")) res.setHeader("Cache-Control", "no-store");
    return writeHead.apply(this, args);
  };
  next();
}

module.exports = { securityHeaders };
