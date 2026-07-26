/**
 * Complete PostgreSQL schema initializer for a FRESH database (VPS / production).
 *
 * Creates every table with the FULL schema the current code expects — including
 * the admin_users role + permission columns that the old migrate.js was missing —
 * then seeds an "owner" admin. Safe to run repeatedly (idempotent).
 *
 * Usage (on the VPS, from the project root):
 *     node server/db/init-postgres.js
 *
 * Requires DATABASE_URL in the environment / .env (postgresql://...).
 */
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

// Local Postgres on the same VPS doesn't need SSL; a managed/remote one does.
const isLocalDb = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '');

async function main() {
    if (!/^postgres/i.test(process.env.DATABASE_URL || '')) {
        console.error('❌ DATABASE_URL is not a PostgreSQL connection string. Aborting.');
        console.error('   Set DATABASE_URL=postgresql://user:pass@localhost:5432/normless_crm in your .env');
        process.exit(1);
    }

    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: isLocalDb ? false : { rejectUnauthorized: false }
    });

    const client = await pool.connect();
    try {
        console.log('🚀 Initializing PostgreSQL schema...');

        await client.query(`
            CREATE TABLE IF NOT EXISTS customers (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                shopify_id TEXT UNIQUE,
                email TEXT,
                first_name TEXT,
                last_name TEXT,
                phone TEXT,
                orders_count INTEGER DEFAULT 0,
                total_spent REAL DEFAULT 0.0,
                tags TEXT,
                crm_status TEXT DEFAULT 'Lead',
                crm_notes TEXT,
                crm_priority TEXT DEFAULT 'Medium',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS orders (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                shopify_id TEXT UNIQUE,
                order_number TEXT,
                customer_shopify_id TEXT,
                total_price REAL,
                currency TEXT,
                financial_status TEXT,
                fulfillment_status TEXT,
                line_items_json TEXT,
                created_at TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS interactions (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                customer_shopify_id TEXT,
                type TEXT,
                content TEXT,
                created_by TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS admin_users (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                username TEXT UNIQUE,
                password_hash TEXT,
                role TEXT DEFAULT 'operator',
                is_active BOOLEAN DEFAULT true,
                last_login TIMESTAMP,
                login_count INTEGER DEFAULT 0,
                can_view_dashboard BOOLEAN DEFAULT true,
                can_view_customers BOOLEAN DEFAULT true,
                can_view_orders BOOLEAN DEFAULT true,
                can_scan_orders BOOLEAN DEFAULT true,
                can_sync_data BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS sync_logs (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                type TEXT,
                status TEXT,
                records_synced INTEGER,
                error_message TEXT,
                started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                completed_at TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS password_reset_tokens (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                user_id INTEGER NOT NULL REFERENCES admin_users(id),
                token TEXT UNIQUE NOT NULL,
                expires_at TIMESTAMP NOT NULL,
                used BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Idempotent guards: if admin_users already existed with the old schema,
        // add the newer columns without failing.
        await client.query(`
            ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'operator';
            ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
            ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS last_login TIMESTAMP;
            ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS login_count INTEGER DEFAULT 0;
            ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_view_dashboard BOOLEAN DEFAULT true;
            ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_view_customers BOOLEAN DEFAULT true;
            ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_view_orders BOOLEAN DEFAULT true;
            ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_scan_orders BOOLEAN DEFAULT true;
            ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_sync_data BOOLEAN DEFAULT true;
            ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

            CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_shopify_id);
            CREATE INDEX IF NOT EXISTS idx_orders_number ON orders(order_number);
            CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
            CREATE INDEX IF NOT EXISTS idx_interactions_customer ON interactions(customer_shopify_id);
        `);

        console.log('✅ Tables ready.');

        // Seed / promote the owner admin.
        const crypto = require('crypto');
        const adminUser = process.env.ADMIN_USERNAME || 'normlessfashion@gmail.com';
        // Password from env; if unset, generate a random one and print it once.
        const generated = !process.env.ADMIN_PASSWORD;
        const adminPass = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64');

        const existing = await client.query('SELECT id FROM admin_users WHERE username = $1', [adminUser]);
        if (existing.rows.length === 0) {
            const hash = bcrypt.hashSync(adminPass, bcrypt.genSaltSync(10));
            await client.query(
                `INSERT INTO admin_users
                    (username, password_hash, role, is_active,
                     can_view_dashboard, can_view_customers, can_view_orders, can_scan_orders, can_sync_data)
                 VALUES ($1, $2, 'owner', true, true, true, true, true, true)`,
                [adminUser, hash]
            );
            console.log(generated
                ? `✅ Owner admin created: ${adminUser} / ${adminPass}  (set ADMIN_PASSWORD in .env to control this)`
                : `✅ Owner admin created: ${adminUser}`);
        } else {
            await client.query(
                `UPDATE admin_users
                 SET role = 'owner', is_active = true,
                     can_view_dashboard = true, can_view_customers = true, can_view_orders = true,
                     can_scan_orders = true, can_sync_data = true
                 WHERE username = $1`,
                [adminUser]
            );
            console.log(`✅ Owner admin ensured: ${adminUser}`);
        }

        console.log('\n✨ PostgreSQL initialization complete!');
    } catch (err) {
        console.error('❌ Init failed:', err.message);
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
}

main();
