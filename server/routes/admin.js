const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/connection');

const router = express.Router();

// GET /api/admin/users - List all users (admin only)
router.get('/users', async (req, res) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const result = await db.query(`
      SELECT id, username, role, is_active, last_login, login_count, created_at,
             can_view_dashboard, can_view_customers, can_view_orders, can_scan_orders, can_sync_data
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

    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync(password, salt);

    await db.query(`
      INSERT INTO admin_users (
        username, password_hash, role, is_active,
        can_view_dashboard, can_view_customers, can_view_orders, can_scan_orders, can_sync_data
      ) VALUES ($1, $2, $3, true, $4, $5, $6, $7, $8)
    `, [
      username, hash, role || 'operator',
      permissions?.dashboard !== false ? true : false,
      permissions?.customers !== false ? true : false,
      permissions?.orders !== false ? true : false,
      permissions?.scanner !== false ? true : false,
      permissions?.sync !== false ? true : false
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

    await db.query(`
      UPDATE admin_users SET
        role = COALESCE($1, role),
        is_active = COALESCE($2, is_active),
        can_view_dashboard = COALESCE($3, can_view_dashboard),
        can_view_customers = COALESCE($4, can_view_customers),
        can_view_orders = COALESCE($5, can_view_orders),
        can_scan_orders = COALESCE($6, can_scan_orders),
        can_sync_data = COALESCE($7, can_sync_data),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $8
    `, [
      role || null,
      is_active !== undefined ? is_active : null,
      permissions?.dashboard !== undefined ? permissions.dashboard : null,
      permissions?.customers !== undefined ? permissions.customers : null,
      permissions?.orders !== undefined ? permissions.orders : null,
      permissions?.scanner !== undefined ? permissions.scanner : null,
      permissions?.sync !== undefined ? permissions.sync : null,
      req.params.id
    ]);

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
