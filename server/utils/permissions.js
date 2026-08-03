const db = require('../db/connection');

// Whether this request may see money totals (overall collected/outstanding revenue).
//
// Read from the DB rather than the JWT on purpose: tokens are issued for 7 days and carry only
// id/username/role, so a permission baked into the token would keep working for up to a week
// after the owner revoked it. This is a lookup on a primary key, cached on the request, and only
// runs on the handful of endpoints that actually return revenue.
async function canViewRevenue(req) {
  if (req._canViewRevenue !== undefined) return req._canViewRevenue;

  const role = req.user?.role;
  if (role === 'owner' || role === 'admin') {
    req._canViewRevenue = true;
    return true;
  }
  if (!req.user?.id) {
    req._canViewRevenue = false;
    return false;
  }
  try {
    const r = await db.query('SELECT can_view_revenue FROM admin_users WHERE id = $1', [req.user.id]);
    req._canViewRevenue = !!r.rows[0]?.can_view_revenue;
  } catch (err) {
    // Fail closed: if the flag can't be read, withhold the numbers rather than leak them.
    console.error('canViewRevenue lookup failed:', err.message);
    req._canViewRevenue = false;
  }
  return req._canViewRevenue;
}

module.exports = { canViewRevenue };
