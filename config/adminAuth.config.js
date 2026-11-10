// Admin portal authentication settings.
//
// The Admin portal uses its OWN signing secret (ADMIN_JWT_SECRET) — never JWT_SECRET, which signs Distributor
// tokens. Because the secrets differ, a Distributor token can never verify as an Admin token (and the reverse).
// If ADMIN_JWT_SECRET is missing, too short, or equal to JWT_SECRET, the Admin portal FAILS CLOSED (503).

const MIN_SECRET_LENGTH = 32;

function getAdminAuthConfig() {
  const secret = process.env.ADMIN_JWT_SECRET || "";
  const usable = secret.length >= MIN_SECRET_LENGTH && secret !== process.env.JWT_SECRET;
  const ttlMinutes = Number.parseInt(process.env.ADMIN_ACCESS_TOKEN_TTL_MINUTES, 10);
  const minutes = Number.isFinite(ttlMinutes) && ttlMinutes > 0 && ttlMinutes <= 1440 ? ttlMinutes : 240;

  return {
    secret: usable ? secret : null,
    issuer: "pharma-dms-admin",
    audience: "admin-portal",
    expiresInSeconds: minutes * 60,
    cookieName: "adminAccessToken",
    // The cookie is only ever sent to /api/admin/* — never to the Distributor endpoints.
    cookieOptions: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/api/admin",
    },
  };
}

module.exports = { getAdminAuthConfig, MIN_SECRET_LENGTH };
