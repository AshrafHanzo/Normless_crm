const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const db = require('../db/connection');

const router = express.Router();

// Configure email transporter (using Gmail)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER || 'normlessforgot@gmail.com',
        pass: process.env.GMAIL_APP_PASSWORD || 'zxzj ozgu fbho zscu'
    }
});

// POST /api/auth/init-db - Reinitialize database (for recovery)
router.post('/init-db', async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM admin_users WHERE username = $1', ['normlessfashion@gmail.com']);
        const adminCheck = result.rows[0];

        if (!adminCheck) {
            console.log('🔄 Reinitializing admin user...');
            const salt = bcrypt.genSaltSync(10);
            const hash = bcrypt.hashSync('hsSeMEiG8MBhSzC', salt);

            await db.query('INSERT INTO admin_users (username, password_hash) VALUES ($1, $2)', ['normlessfashion@gmail.com', hash]);
            console.log('✅ Admin user recreated');
            res.json({ message: 'Admin user recreated successfully', username: 'normlessfashion@gmail.com' });
        } else {
            res.json({ message: 'Admin user already exists', username: 'normlessfashion@gmail.com' });
        }
    } catch (error) {
        console.error('Error reinitializing database:', error);
        res.status(500).json({ error: 'Failed to reinitialize database' });
    }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }

    try {
        const result = await db.query('SELECT * FROM admin_users WHERE username = $1', [username]);
        const user = result.rows[0];

        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const validPassword = bcrypt.compareSync(password, user.password_hash);

        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.json({ 
            token, 
            user: { 
                id: user.id, 
                username: user.username, 
                role: user.role,
                can_view_dashboard: user.can_view_dashboard,
                can_view_customers: user.can_view_customers,
                can_view_orders: user.can_view_orders,
                can_scan_orders: user.can_scan_orders,
                can_sync_data: user.can_sync_data
            } 
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

// GET /api/auth/verify
router.get('/verify', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ valid: false });
    }

    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // Fetch full user data to get permissions
        const result = await db.query('SELECT * FROM admin_users WHERE id = $1', [decoded.id]);
        const user = result.rows[0];

        if (!user) {
            return res.status(401).json({ valid: false });
        }

        res.json({ 
            valid: true, 
            user: { 
                id: user.id, 
                username: user.username, 
                role: user.role,
                can_view_dashboard: user.can_view_dashboard,
                can_view_customers: user.can_view_customers,
                can_view_orders: user.can_view_orders,
                can_scan_orders: user.can_scan_orders,
                can_sync_data: user.can_sync_data
            } 
        });
    } catch {
        res.status(401).json({ valid: false });
    }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ message: 'Email is required' });
        }

        const result = await db.query('SELECT * FROM admin_users WHERE username = $1', [email]);
        const user = result.rows[0];

        if (!user) {
            // Don't reveal if email exists (security best practice)
            return res.status(200).json({ message: 'If this email exists, a password reset link will be sent shortly.' });
        }

        // Generate reset token
        const resetToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
        const expiresAt = new Date(Date.now() + 1 * 60 * 60 * 1000); // 1 hour

        // Store token in database
        await db.query(
            `INSERT INTO password_reset_tokens (user_id, token, expires_at)
             VALUES ($1, $2, $3)`,
            [user.id, tokenHash, expiresAt.toISOString()]
        );

        // Build reset URL
        const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/reset-password?token=${resetToken}`;

        // Send email
        const mailOptions = {
            from: process.env.GMAIL_USER || 'normlessforgot@gmail.com',
            to: email,
            subject: 'Password Reset - Normless CRM',
            html: `
                <h2>Password Reset Request</h2>
                <p>You requested to reset your password. Click the link below to proceed:</p>
                <a href="${resetUrl}" style="display: inline-block; padding: 10px 20px; background-color: #6366f1; color: white; text-decoration: none; border-radius: 5px;">
                    Reset Password
                </a>
                <p>Or copy this link: ${resetUrl}</p>
                <p>This link expires in 1 hour.</p>
                <p>If you didn't request this, please ignore this email.</p>
            `
        };

        await transporter.sendMail(mailOptions);

        res.status(200).json({ message: 'If this email exists, a password reset link will be sent shortly.' });
    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({ message: 'Error processing request' });
    }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
    try {
        const { token, password } = req.body;

        if (!token || !password) {
            return res.status(400).json({ message: 'Token and password are required' });
        }

        if (password.length < 6) {
            return res.status(400).json({ message: 'Password must be at least 6 characters' });
        }

        // Hash the token to find it
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

        // Find valid token
        const result = await db.query(
            `SELECT * FROM password_reset_tokens
             WHERE token = $1 AND used = false AND expires_at > NOW()`,
            [tokenHash]
        );
        const resetRecord = result.rows[0];

        if (!resetRecord) {
            return res.status(400).json({ message: 'Invalid or expired reset token' });
        }

        // Update password
        const salt = bcrypt.genSaltSync(10);
        const passwordHash = bcrypt.hashSync(password, salt);

        await db.query('UPDATE admin_users SET password_hash = $1 WHERE id = $2', [passwordHash, resetRecord.user_id]);

        // Mark token as used
        await db.query('UPDATE password_reset_tokens SET used = true WHERE id = $1', [resetRecord.id]);

        res.status(200).json({ message: 'Password reset successfully' });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({ message: 'Error resetting password' });
    }
});

module.exports = router;
