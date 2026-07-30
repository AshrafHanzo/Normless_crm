const path = require('path');

// Load env early so DATABASE_URL is available when this module is required
// (index.js requires this file before calling dotenv.config()).
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { Pool } = require('pg');

// PostgreSQL ONLY — local dev and production both use Postgres.
// Local dev reaches the VPS Postgres over an SSH tunnel (localhost:5432);
// a managed/remote DB needs SSL, a local/tunnelled one does not.
const isLocalDb = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isLocalDb ? false : { rejectUnauthorized: false }
});

// Convert legacy `?` placeholders to Postgres `$1, $2, …`
const toPg = (sql) => { let i = 1; return sql.replace(/\?/g, () => `$${i++}`); };

const db = {
    prepare: (sql) => ({
        get: (...args) => pool.connect().then(async (c) => {
            try { return (await c.query(toPg(sql), args)).rows[0] || null; } finally { c.release(); }
        }),
        run: (...args) => pool.connect().then(async (c) => {
            try { const r = await c.query(toPg(sql), args); return { changes: r.rowCount, lastID: null }; } finally { c.release(); }
        }),
        all: (...args) => pool.connect().then(async (c) => {
            try { return (await c.query(toPg(sql), args)).rows; } finally { c.release(); }
        })
    }),
    query: async (sql, params = []) => {
        const c = await pool.connect();
        try { return await c.query(sql, params); } finally { c.release(); }
    },
    querySync: () => { throw new Error('PostgreSQL requires async operations. Use db.query().'); },
    pragma: () => { /* no-op */ },
    exec: async (sql) => {
        const c = await pool.connect();
        try { await c.query(sql); } finally { c.release(); }
    },
    close: async () => { await pool.end(); }
};

console.log('🗄️  Database driver: PostgreSQL');
module.exports = db;
