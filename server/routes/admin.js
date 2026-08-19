const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/connection');

const router = express.Router();

const ROLES = ['operator', 'admin', 'owner'];

/**
 * Owner is the top of the tree: it is the only role that can grant owner, and the only one that
 * can change an existing owner's role. Without this an admin could promote themselves — the role
 * field used to be written straight through from the request body with no check at all.
 *
 * Returns an error string, or null if the change is allowed.
 */
async function guardRoleChange(req, targetId, nextRole) {
  const actorIsOwner = req.user.role === 'owner';
  const target = (await db.query('SELECT id, username, role FROM admin_users WHERE id = $1', [targetId])).rows[0];
  if (!target) return 'User not found';

  if (target.role === 'owner' && !actorIsOwner) return 'Only an owner can change another owner';
  if (nextRole === 'owner' && !actorIsOwner) return 'Only an owner can make someone else an owner';

  // Demoting the last owner would leave nobody able to run owner-only actions — deleting orders,
  // managing the catalog, or promoting anyone back.
  if (target.role === 'owner' && nextRole !== 'owner') {
    const owners = await db.query("SELECT COUNT(*)::int AS n FROM admin_users WHERE role = 'owner' AND is_active = true");
    if ((owners.rows[0]?.n || 0) <= 1) return 'This is the last owner — promote someone else first';
  }
  return null;
}

// GET /api/admin/users - List all users (admin only)
router.get('/users', async (req, res) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const result = await db.query(`
      SELECT id, username, role, is_active, last_login, login_count, created_at,
             can_view_dashboard, can_view_customers, can_view_orders, can_scan_orders, can_sync_data,
             can_access_normless, can_access_crewfit,
             can_view_crewfit_followups, can_view_crewfit_orders, can_view_crewfit_catalog, can_view_crewfit_analytics, can_view_crewfit_calculator, can_view_crewfit_payments, can_view_crewfit_customers, can_view_revenue, can_view_invoices, can_view_crewfit_vendors, can_view_crewfit_invoices, can_edit_crewfit_orders, can_view_marketing, can_dispatch_marketing, can_view_inventory, can_edit_inventory
      FROM admin_users
      ORDER BY created_at DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching users:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// POST /api/admin/users - Create new user (admin only)
router.post('/users', async (req, res) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { username, password, role, permissions } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    if (role !== undefined && role !== null && !ROLES.includes(role)) {
      return res.status(400).json({ error: 'Unknown role' });
    }
    if (role === 'owner' && req.user.role !== 'owner') {
      return res.status(403).json({ error: 'Only an owner can make someone else an owner' });
    }

    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync(password, salt);
    const p = permissions || {};

    await db.query(`
      INSERT INTO admin_users (
        username, password_hash, role, is_active,
        can_view_dashboard, can_view_customers, can_view_orders, can_scan_orders, can_sync_data,
        can_access_normless, can_access_crewfit,
        can_view_crewfit_followups, can_view_crewfit_orders, can_view_crewfit_catalog, can_view_crewfit_analytics, can_view_crewfit_calculator, can_view_crewfit_payments, can_view_crewfit_customers, can_view_revenue, can_view_invoices, can_view_crewfit_vendors, can_view_crewfit_invoices, can_edit_crewfit_orders, can_view_marketing, can_dispatch_marketing
      ) VALUES ($1, $2, $3, true, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)
    `, [
      username, hash, role || 'operator',
      !!p.dashboard, !!p.customers, !!p.orders, !!p.scanner, !!p.sync,
      !!p.normless, !!p.crewfit, !!p.crewfit_followups, !!p.crewfit_orders, !!p.crewfit_catalog, !!p.crewfit_analytics, !!p.crewfit_calculator, !!p.crewfit_payments, !!p.crewfit_customers, !!p.revenue, !!p.invoices, !!p.crewfit_vendors,
      !!p.crewfit_invoices, !!p.crewfit_orders_edit,
      !!p.marketing, !!p.marketing_dispatch,
      !!p.inventory, !!p.inventory_edit
    ]);

    res.json({ success: true, message: 'User created' });
  } catch (err) {
    console.error('Error creating user:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// PUT /api/admin/users/:id - Update user (admin only)
router.put('/users/:id', async (req, res) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { role, is_active, permissions } = req.body;
    if (role !== undefined) {
      if (!ROLES.includes(role)) return res.status(400).json({ error: 'Unknown role' });
      const bad = await guardRoleChange(req, req.params.id, role);
      if (bad) return res.status(403).json({ error: bad });
    }
    // Deactivating an owner strands the account the same way demoting them would.
    if (is_active === false) {
      const bad = await guardRoleChange(req, req.params.id, 'operator');
      if (bad) return res.status(403).json({ error: bad });
    }
    const PERM_MAP = {
      dashboard: 'can_view_dashboard', customers: 'can_view_customers', orders: 'can_view_orders',
      scanner: 'can_scan_orders', sync: 'can_sync_data',
      normless: 'can_access_normless', crewfit: 'can_access_crewfit',
      crewfit_followups: 'can_view_crewfit_followups', crewfit_orders: 'can_view_crewfit_orders', crewfit_catalog: 'can_view_crewfit_catalog',
      crewfit_analytics: 'can_view_crewfit_analytics', crewfit_calculator: 'can_view_crewfit_calculator',
      crewfit_payments: 'can_view_crewfit_payments', crewfit_customers: 'can_view_crewfit_customers', revenue: 'can_view_revenue',
      invoices: 'can_view_invoices', crewfit_vendors: 'can_view_crewfit_vendors',
      crewfit_invoices: 'can_view_crewfit_invoices', crewfit_orders_edit: 'can_edit_crewfit_orders',
      inventory: 'can_view_inventory', inventory_edit: 'can_edit_inventory',
      marketing: 'can_view_marketing', marketing_dispatch: 'can_dispatch_marketing',
    };

    const sets = [], vals = [];
    if (role !== undefined) { vals.push(role); sets.push(`role = $${vals.length}`); }
    if (is_active !== undefined) { vals.push(is_active); sets.push(`is_active = $${vals.length}`); }
    if (permissions) for (const [k, col] of Object.entries(PERM_MAP)) {
      if (permissions[k] !== undefined) { vals.push(!!permissions[k]); sets.push(`${col} = $${vals.length}`); }
    }
    if (!sets.length) return res.json({ success: true, message: 'No changes' });
    vals.push(req.params.id);
    await db.query(`UPDATE admin_users SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${vals.length}`, vals);

    res.json({ success: true, message: 'User updated' });
  } catch (err) {
    console.error('Error updating user:', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// DELETE /api/admin/users/:id - Delete user (admin only)
router.delete('/users/:id', async (req, res) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (req.params.id == req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    // Deleting an owner strands the account exactly as demoting the last one would.
    const bad = await guardRoleChange(req, req.params.id, 'operator');
    if (bad) return res.status(403).json({ error: bad });

    await db.query('DELETE FROM admin_users WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'User deleted' });
  } catch (err) {
    console.error('Error deleting user:', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// GET /api/admin/user/:id - Get user permissions
router.get('/user/:id', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, username, role, is_active,
             can_view_dashboard, can_view_customers, can_view_orders, can_scan_orders, can_sync_data
      FROM admin_users
      WHERE id = $1
    `, [req.params.id]);
    const user = result.rows?.[0];

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(user);
  } catch (err) {
    console.error('Error fetching user:', err);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// POST /api/admin/change-password - Change own password
router.post('/change-password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new passwords required' });
    }

    const result = await db.query('SELECT password_hash FROM admin_users WHERE id = $1', [req.user.id]);
    const user = result.rows?.[0];
    const validPassword = bcrypt.compareSync(currentPassword, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Current password incorrect' });
    }

    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync(newPassword, salt);

    await db.query('UPDATE admin_users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
    res.json({ success: true, message: 'Password changed' });
  } catch (err) {
    console.error('Error changing password:', err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// GET /api/admin/stats - Admin dashboard stats
router.get('/stats', async (req, res) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const totalUsersResult = await db.query('SELECT COUNT(*) as count FROM admin_users');
    const totalUsers = parseInt(totalUsersResult.rows[0]?.count) || 0;

    const activeUsersResult = await db.query('SELECT COUNT(*) as count FROM admin_users WHERE is_active = true');
    const activeUsers = parseInt(activeUsersResult.rows[0]?.count) || 0;

    const operatorsResult = await db.query("SELECT COUNT(*) as count FROM admin_users WHERE role = 'operator'");
    const operators = parseInt(operatorsResult.rows[0]?.count) || 0;

    res.json({ totalUsers, activeUsers, operators });
  } catch (err) {
    console.error('Error fetching stats:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

module.exports = router;
