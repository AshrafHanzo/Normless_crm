const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'crm.db');
const db = new Database(dbPath, { verbose: console.log });

console.log('Initializing database schema...');

// Create tables
db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shopify_id TEXT UNIQUE,
        order_number TEXT,
        customer_shopify_id TEXT,
        total_price REAL,
        currency TEXT,
        financial_status TEXT,
        fulfillment_status TEXT,
        line_items_json TEXT,
        created_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS interactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_shopify_id TEXT,
        type TEXT, -- 'note', 'call', 'email'
        content TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(customer_shopify_id) REFERENCES customers(shopify_id)
    );

    CREATE TABLE IF NOT EXISTS admin_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password_hash TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sync_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT, -- 'full' or 'incremental'
        status TEXT, -- 'success' or 'error'
        records_synced INTEGER,
        error_message TEXT,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token TEXT UNIQUE NOT NULL,
        expires_at DATETIME NOT NULL,
        used BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES admin_users(id)
    );
`);

// Seed Admin User (normlessfashion@gmail.com / hsSeMEiG8MBhSzC)
const adminCheck = db.prepare('SELECT * FROM admin_users WHERE username = ?').get('normlessfashion@gmail.com');

if (!adminCheck) {
    console.log('Seeding default admin user...');
    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync('hsSeMEiG8MBhSzC', salt);

    db.prepare('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)').run('normlessfashion@gmail.com', hash);
    console.log('Admin user created: username: normlessfashion@gmail.com | password: hsSeMEiG8MBhSzC');
} else {
    console.log('Admin user already exists.');
}

console.log('Database initialization complete!');
db.close();
