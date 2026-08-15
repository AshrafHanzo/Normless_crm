const db = require('../db/connection');

// Permission columns this helper is allowed to read. The column name is interpolated into the
// query (parameters can't stand in for identifiers), so it must never come straight from a caller
// without passing through this list.
const COLUMNS = new Set([
  'can_view_dashboard', 'can_view_customers', 'can_view_orders', 'can_scan_orders', 'can_sync_data',
  'can_access_normless', 'can_access_crewfit', 'can_view_crewfit_followups', 'can_view_crewfit_orders',
  'can_view_crewfit_catalog', 'can_view_crewfit_analytics', 'can_view_crewfit_calculator',
  'can_view_crewfit_payments', 'can_view_crewfit_customers', 'can_view_revenue', 'can_view_invoices',
  'can_view_crewfit_vendors', 'can_view_crewfit_invoices', 'can_view_marketing', 'can_dispatch_marketing',
]);

// Whether this request holds a given permission.
//
// Read from the DB rather than the JWT on purpose: tokens are issued for 7 days and carry only
// id/username/role, so a permission baked into the token would keep working for up to a week
// after the owner revoked it — and, since the token has no permission claims at all, reading them
// off req.user would silently deny everyone. This is a lookup on a primary key, cached per
// request, and only runs on endpoints that actually gate on it.
async function hasPermission(req, column) {
  if (!COLUMNS.has(column)) throw new Error(`Unknown permission column: ${column}`);

  req._perms = req._perms || {};
  if (req._perms[column] !== undefined) return req._perms[column];

  const role = req.user?.role;
  if (role === 'owner' || role === 'admin') {
    req._perms[column] = true;
    return true;
  }
  if (!req.user?.id) {
    req._perms[column] = false;
    return false;
  }
  try {
    const r = await db.query(`SELECT ${column} FROM admin_users WHERE id = $1`, [req.user.id]);
    req._perms[column] = !!r.rows[0]?.[column];
  } catch (err) {
    // Fail closed: if the flag can't be read, withhold access rather than leak.
    console.error(`${column} lookup failed:`, err.message);
    req._perms[column] = false;
  }
  return req._perms[column];
}

// Whether this request may see money totals (overall collected/outstanding revenue).
const canViewRevenue = (req) => hasPermission(req, 'can_view_revenue');

module.exports = { hasPermission, canViewRevenue };
