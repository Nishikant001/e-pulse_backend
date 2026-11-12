# Super Admin and production data behavior

## Super Admin admin management
- `POST /api/admin/superadmin/admins` creates an active admin account.
- The endpoint requires a valid active Admin session whose current database role is `SUPER_ADMIN`.
- Name is limited to 120 characters, email to 190 characters, and password must be 12–256 characters.
- Passwords are hashed with bcrypt (cost 12); password hashes are never returned.
- Supported roles come from `config/erpPermissions.js`.
- `GET /api/admin/superadmin/roles` returns the backend's actual ERP role/permission map.

## Live platform data
- `GET /api/admin/superadmin/overview` reads current AdminUser, Distributor and Customer rows.
- `GET /api/admin/superadmin/distributors` reads current Distributor rows and retailer counts.
- `GET /api/admin/superadmin/onboarding` lists Distributor rows whose status is `pending`.
- No production seed script is added by this change. Automated test fixtures remain under `tests/` only.

## Important limits
- ERP role permissions currently govern ERP integration endpoints only. They are not a complete module-level RBAC system for every Admin page.
- Billing, announcements, platform-wide audit logs and platform settings have no persistent Super Admin APIs in this backend. Their frontend pages intentionally show empty/unavailable states instead of fabricated data.
- This change does not delete or modify any existing production database records. Inspect and back up the live database before any cleanup of suspected demo rows.
