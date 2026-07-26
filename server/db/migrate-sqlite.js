// Idempotent migration to bring the local SQLite crm.db up to the schema the
// current (PostgreSQL-targeted) code expects: role + permission columns on
// admin_users, the password_reset_tokens table, and an "owner" admin.
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.SQLITE_PATH || path.join(__dirname, 'crm.db');
const db = new Database(dbPath);

const cols = db.prepare('PRAGMA table_info(admin_users)').all().map(c => c.name);
const addColumn = (name, ddl) => {
    if (!cols.includes(name)) {
        db.exec(`ALTER TABLE admin_users ADD COLUMN ${ddl}`);
        console.log(`+ added admin_users.${name}`);
    }
};

addColumn('role', "role TEXT DEFAULT 'operator'");
addColumn('is_active', 'is_active INTEGER DEFAULT 1');
addColumn('last_login', 'last_login DATETIME');
addColumn('login_count', 'login_count INTEGER DEFAULT 0');
addColumn('updated_at', 'updated_at DATETIME'); // no CURRENT_TIMESTAMP default: SQLite forbids it on ALTER
addColumn('can_view_dashboard', 'can_view_dashboard INTEGER DEFAULT 1');
addColumn('can_view_customers', 'can_view_customers INTEGER DEFAULT 1');
addColumn('can_view_orders', 'can_view_orders INTEGER DEFAULT 1');
addColumn('can_scan_orders', 'can_scan_orders INTEGER DEFAULT 1');
addColumn('can_sync_data', 'can_sync_data INTEGER DEFAULT 1');

db.exec(`
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

// Make the seeded admin a full-access owner.
const res = db.prepare(`
    UPDATE admin_users
    SET role = 'owner', is_active = 1,
        can_view_dashboard = 1, can_view_customers = 1, can_view_orders = 1,
        can_scan_orders = 1, can_sync_data = 1
    WHERE username = 'normlessfashion@gmail.com'
`).run();
console.log(`Owner admin updated (${res.changes} row).`);

const users = db.prepare('SELECT id, username, role, is_active FROM admin_users').all();
console.log('admin_users:', JSON.stringify(users));
db.close();
console.log('✅ SQLite migration complete.');
