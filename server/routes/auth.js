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
router.post('/init-db', (req, res) => {
    try {
        const adminCheck = db.prepare('SELECT * FROM admin_users WHERE username = ?').get('normlessfashion@gmail.com');

        if (!adminCheck) {
            console.log('🔄 Reinitializing admin user...');
            const salt = bcrypt.genSaltSync(10);
            const hash = bcrypt.hashSync('hsSeMEiG8MBhSzC', salt);

            db.prepare('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)').run('normlessfashion@gmail.com', hash);
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
router.post('/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }

    const user = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);

    if (!user) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    const validPassword = bcrypt.compareSync(password, user.password_hash);

    if (!validPassword) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
        { id: user.id, username: user.username },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
    );

    res.json({ token, user: { id: user.id, username: user.username } });
});

// GET /api/auth/verify
router.get('/verify', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ valid: false });
    }

    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        res.json({ valid: true, user: { id: decoded.id, username: decoded.username } });
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

        const user = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(email);

        if (!user) {
            // Don't reveal if email exists (security best practice)
            return res.status(200).json({ message: 'If this email exists, a password reset link will be sent shortly.' });
        }

        // Generate reset token
        const resetToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
        const expiresAt = new Date(Date.now() + 1 * 60 * 60 * 1000); // 1 hour

        // Store token in database
        db.prepare(`
            INSERT INTO password_reset_tokens (user_id, token, expires_at)
            VALUES (?, ?, ?)
        `).run(user.id, tokenHash, expiresAt.toISOString());

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
router.post('/reset-password', (req, res) => {
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
        const resetRecord = db.prepare(`
            SELECT * FROM password_reset_tokens
            WHERE token = ? AND used = 0 AND expires_at > datetime('now')
        `).get(tokenHash);

        if (!resetRecord) {
            return res.status(400).json({ message: 'Invalid or expired reset token' });
        }

        // Update password
        const salt = bcrypt.genSaltSync(10);
        const passwordHash = bcrypt.hashSync(password, salt);

        db.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').run(passwordHash, resetRecord.user_id);

        // Mark token as used
        db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').run(resetRecord.id);

        res.status(200).json({ message: 'Password reset successfully' });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({ message: 'Error resetting password' });
    }
});

module.exports = router;
