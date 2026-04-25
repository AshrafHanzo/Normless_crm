const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/connection');

const router = express.Router();

// GET /api/admin/users - List all users (admin only)
router.get('/users', (req, res) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const users = db.prepare(`
      SELECT id, username, role, is_active, last_login, login_count, created_at,
             can_view_dashboard, can_view_customers, can_view_orders, can_scan_orders, can_sync_data
      FROM admin_users
      ORDER BY created_at DESC
    `).all();

    res.json(users);
  } catch (err) {
    console.error('Error fetching users:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// POST /api/admin/users - Create new user (admin only)
router.post('/users', (req, res) => {
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

    db.prepare(`
      INSERT INTO admin_users (
        username, password_hash, role, is_active,
        can_view_dashboard, can_view_customers, can_view_orders, can_scan_orders, can_sync_data
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
    `).run(
      username, hash, role || 'operator',
      permissions?.dashboard !== false ? 1 : 0,
      permissions?.customers !== false ? 1 : 0,
      permissions?.orders !== false ? 1 : 0,
      permissions?.scanner !== false ? 1 : 0,
      permissions?.sync !== false ? 1 : 0
    );

    res.json({ success: true, message: 'User created' });
  } catch (err) {
    console.error('Error creating user:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// PUT /api/admin/users/:id - Update user (admin only)
router.put('/users/:id', (req, res) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { role, is_active, permissions } = req.body;

    db.prepare(`
      UPDATE admin_users SET
        role = COALESCE(?, role),
        is_active = COALESCE(?, is_active),
        can_view_dashboard = COALESCE(?, can_view_dashboard),
        can_view_customers = COALESCE(?, can_view_customers),
        can_view_orders = COALESCE(?, can_view_orders),
        can_scan_orders = COALESCE(?, can_scan_orders),
        can_sync_data = COALESCE(?, can_sync_data),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      role || null,
      is_active !== undefined ? (is_active ? 1 : 0) : null,
      permissions?.dashboard !== undefined ? (permissions.dashboard ? 1 : 0) : null,
      permissions?.customers !== undefined ? (permissions.customers ? 1 : 0) : null,
      permissions?.orders !== undefined ? (permissions.orders ? 1 : 0) : null,
      permissions?.scanner !== undefined ? (permissions.scanner ? 1 : 0) : null,
      permissions?.sync !== undefined ? (permissions.sync ? 1 : 0) : null,
      req.params.id
    );

    res.json({ success: true, message: 'User updated' });
  } catch (err) {
    console.error('Error updating user:', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// DELETE /api/admin/users/:id - Delete user (admin only)
router.delete('/users/:id', (req, res) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (req.params.id == req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    db.prepare('DELETE FROM admin_users WHERE id = ?').run(req.params.id);
    res.json({ success: true, message: 'User deleted' });
  } catch (err) {
    console.error('Error deleting user:', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// GET /api/admin/user/:id - Get user permissions
router.get('/user/:id', (req, res) => {
  try {
    const user = db.prepare(`
      SELECT id, username, role, is_active,
             can_view_dashboard, can_view_customers, can_view_orders, can_scan_orders, can_sync_data
      FROM admin_users
      WHERE id = ?
    `).get(req.params.id);

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
router.post('/change-password', (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new passwords required' });
    }

    const user = db.prepare('SELECT password_hash FROM admin_users WHERE id = ?').get(req.user.id);
    const validPassword = bcrypt.compareSync(currentPassword, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Current password incorrect' });
    }

    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync(newPassword, salt);

    db.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
    res.json({ success: true, message: 'Password changed' });
  } catch (err) {
    console.error('Error changing password:', err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// GET /api/admin/stats - Admin dashboard stats
router.get('/stats', (req, res) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const totalUsers = db.prepare('SELECT COUNT(*) as count FROM admin_users').get().count;
    const activeUsers = db.prepare('SELECT COUNT(*) as count FROM admin_users WHERE is_active = 1').get().count;
    const operators = db.prepare("SELECT COUNT(*) as count FROM admin_users WHERE role = 'operator'").get().count;

    res.json({ totalUsers, activeUsers, operators });
  } catch (err) {
    console.error('Error fetching stats:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

module.exports = router;
