const { Pool } = require('pg');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const dotenv = require('dotenv');

// Load .env file
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

async function batchInsert(pgClient, table, columns, rows, conflictColumn = null) {
    if (rows.length === 0) return;

    const batchSize = 100;
    for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);

        // Build VALUES clause: ($1, $2, ...), ($13, $14, ...)
        const valuePlaceholders = batch.map((_, idx) => {
            const start = idx * columns.length + 1;
            const placeholders = Array.from({ length: columns.length }, (_, j) => `$${start + j}`);
            return `(${placeholders.join(', ')})`;
        }).join(', ');

        const params = batch.flat().map(row =>
            columns.map(col => row[col])
        ).flat();

        let query = `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${valuePlaceholders}`;
        if (conflictColumn) {
            query += ` ON CONFLICT (${conflictColumn}) DO NOTHING`;
        }

        await pgClient.query(query, params);
        process.stdout.write(`\r    ✓ Migrated ${Math.min(i + batchSize, rows.length)}/${rows.length}...`);
    }
    console.log();
}

async function migrate() {
    console.log('🚀 Starting migration from SQLite to PostgreSQL...\n');

    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });

    try {
        const sqlitePath = path.join(__dirname, 'crm.db');
        const sqliteDb = new Database(sqlitePath);

        console.log('📊 Connecting to databases...');
        const pgClient = await pool.connect();
        console.log('✅ Connected to PostgreSQL');

        console.log('\n📋 Creating PostgreSQL tables...');
        await pgClient.query(`
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
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(customer_shopify_id) REFERENCES customers(shopify_id)
            );

            CREATE TABLE IF NOT EXISTS admin_users (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                username TEXT UNIQUE,
                password_hash TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
                user_id INTEGER NOT NULL,
                token TEXT UNIQUE NOT NULL,
                expires_at TIMESTAMP NOT NULL,
                used BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES admin_users(id)
            );
        `);
        console.log('✅ Tables created in PostgreSQL');

        console.log('\n📤 Migrating data from SQLite...');

        // Migrate customers
        const customers = sqliteDb.prepare('SELECT * FROM customers').all();
        console.log(`  • Migrating ${customers.length} customers`);
        await batchInsert(pgClient, 'customers',
            ['shopify_id', 'email', 'first_name', 'last_name', 'phone', 'orders_count', 'total_spent', 'tags', 'crm_status', 'crm_notes', 'crm_priority', 'created_at', 'updated_at'],
            customers,
            'shopify_id'
        );
        console.log(`    ✅ ${customers.length} customers migrated`);

        // Migrate orders
        const orders = sqliteDb.prepare('SELECT * FROM orders').all();
        console.log(`  • Migrating ${orders.length} orders`);
        await batchInsert(pgClient, 'orders',
            ['shopify_id', 'order_number', 'customer_shopify_id', 'total_price', 'currency', 'financial_status', 'fulfillment_status', 'line_items_json', 'created_at'],
            orders,
            'shopify_id'
        );
        console.log(`    ✅ ${orders.length} orders migrated`);

        // Migrate interactions
        const interactions = sqliteDb.prepare('SELECT * FROM interactions').all();
        console.log(`  • Migrating ${interactions.length} interactions`);
        await batchInsert(pgClient, 'interactions',
            ['customer_shopify_id', 'type', 'content', 'created_by', 'created_at'],
            interactions
        );
        console.log(`    ✅ ${interactions.length} interactions migrated`);

        // Migrate admin users
        const adminUsers = sqliteDb.prepare('SELECT * FROM admin_users').all();
        console.log(`  • Migrating ${adminUsers.length} admin users`);
        await batchInsert(pgClient, 'admin_users',
            ['username', 'password_hash', 'created_at'],
            adminUsers,
            'username'
        );
        console.log(`    ✅ ${adminUsers.length} admin users migrated`);

        // Migrate sync logs
        const syncLogs = sqliteDb.prepare('SELECT * FROM sync_logs').all();
        console.log(`  • Migrating ${syncLogs.length} sync logs`);
        await batchInsert(pgClient, 'sync_logs',
            ['type', 'status', 'records_synced', 'error_message', 'started_at', 'completed_at'],
            syncLogs
        );
        console.log(`    ✅ ${syncLogs.length} sync logs migrated`);

        // Ensure admin user exists
        const existingAdmin = await pgClient.query('SELECT * FROM admin_users WHERE username = $1', ['normlessfashion@gmail.com']);
        if (existingAdmin.rows.length === 0) {
            console.log('\n🔐 Creating default admin user...');
            const salt = bcrypt.genSaltSync(10);
            const hash = bcrypt.hashSync('hsSeMEiG8MBhSzC', salt);
            await pgClient.query(
                'INSERT INTO admin_users (username, password_hash) VALUES ($1, $2)',
                ['normlessfashion@gmail.com', hash]
            );
            console.log('✅ Admin user created: normlessfashion@gmail.com');
        } else {
            console.log('✅ Admin user already exists');
        }

        pgClient.release();
        sqliteDb.close();
        await pool.end();

        console.log('\n✨ Migration completed successfully!');
        console.log('✅ PostgreSQL is now your primary database!');
        process.exit(0);
    } catch (error) {
        console.error('\n❌ Migration failed:', error.message || error);
        console.error(error);
        process.exit(1);
    }
}

migrate();
