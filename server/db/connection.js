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

// pg requires an error listener on the pool — without one, an idle client hitting a
// dropped connection (e.g. the local SSH tunnel blipping) throws unhandled and takes
// down the whole Node process instead of just failing the next query.
pool.on('error', (err) => {
    console.error('⚠️  Unexpected error on idle PG client (pool recovers automatically):', err.message);
});

// The pool listener above only covers *idle* clients — pg removes it the moment a
// client is checked out. A connection that dies mid-query therefore emits 'error' on
// the client with nobody listening, which crashes the process. Every checkout goes
// through here so a listener is in place for the whole window; the in-flight query
// still rejects, so callers just see a normal failure instead of a dead server.
const withClient = async (fn) => {
    const client = await pool.connect();
    let broken = false;
    const onError = (err) => { broken = true; console.error('⚠️  PG client error mid-query:', err.message); };
    client.on('error', onError);
    try {
        return await fn(client);
    } finally {
        client.removeListener('error', onError);
        // Destroy rather than recycle a client whose connection already failed.
        client.release(broken || undefined);
    }
};

// Convert legacy `?` placeholders to Postgres `$1, $2, …`
const toPg = (sql) => { let i = 1; return sql.replace(/\?/g, () => `$${i++}`); };

const db = {
    prepare: (sql) => ({
        get: (...args) => withClient(async (c) => (await c.query(toPg(sql), args)).rows[0] || null),
        run: (...args) => withClient(async (c) => {
            const r = await c.query(toPg(sql), args);
            return { changes: r.rowCount, lastID: null };
        }),
        all: (...args) => withClient(async (c) => (await c.query(toPg(sql), args)).rows)
    }),
    query: (sql, params = []) => withClient((c) => c.query(sql, params)),
    querySync: () => { throw new Error('PostgreSQL requires async operations. Use db.query().'); },
    pragma: () => { /* no-op */ },
    exec: (sql) => withClient((c) => c.query(sql)).then(() => undefined),
    close: async () => { await pool.end(); }
};

console.log('🗄️  Database driver: PostgreSQL');
module.exports = db;
