const path = require('path');

// Load env early so DB_CLIENT / DATABASE_URL are available when this module is
// required (index.js requires this file before calling dotenv.config()).
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

// Choose the driver: use local SQLite when DB_CLIENT=sqlite, or when there is no
// PostgreSQL DATABASE_URL configured. Otherwise use PostgreSQL (Render/prod).
const useSqlite =
    process.env.DB_CLIENT === 'sqlite' ||
    !/^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL || '');

/* ------------------------------------------------------------------ */
/* PostgreSQL adapter (production)                                     */
/* ------------------------------------------------------------------ */
function makePostgres() {
    const { Pool } = require('pg');

    // Local Postgres (same VPS) has no SSL; a managed/remote one needs it.
    const isLocalDb = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '');

    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: isLocalDb ? false : { rejectUnauthorized: false }
    });

    const toPg = (sql) => {
        let paramIndex = 1;
        return sql.replace(/\?/g, () => `$${paramIndex++}`);
    };

    return {
        prepare: (sql) => ({
            get: (...args) => Promise.resolve().then(async () => {
                const client = await pool.connect();
                try {
                    const result = await client.query(toPg(sql), args);
                    return result.rows[0] || null;
                } finally {
                    client.release();
                }
            }),
            run: (...args) => Promise.resolve().then(async () => {
                const client = await pool.connect();
                try {
                    const result = await client.query(toPg(sql), args);
                    return { changes: result.rowCount, lastID: null };
                } finally {
                    client.release();
                }
            }),
            all: (...args) => Promise.resolve().then(async () => {
                const client = await pool.connect();
                try {
                    const result = await client.query(toPg(sql), args);
                    return result.rows;
                } finally {
                    client.release();
                }
            })
        }),
        query: async (sql, params = []) => {
            const client = await pool.connect();
            try {
                return await client.query(sql, params);
            } finally {
                client.release();
            }
        },
        querySync: () => {
            throw new Error('PostgreSQL requires async operations. Use db.query() instead.');
        },
        pragma: () => { /* No-op for PostgreSQL */ },
        exec: async (sql) => {
            const client = await pool.connect();
            try {
                await client.query(sql);
            } finally {
                client.release();
            }
        },
        close: async () => { await pool.end(); }
    };
}

/* ------------------------------------------------------------------ */
/* SQLite adapter (local development / offline)                        */
/* Emulates the pg-style interface used across the codebase and        */
/* translates PostgreSQL-specific SQL into SQLite dialect.             */
/* ------------------------------------------------------------------ */
function makeSqlite() {
    const Database = require('better-sqlite3');
    const dbPath = process.env.SQLITE_PATH || path.join(__dirname, 'crm.db');
    const sqlite = new Database(dbPath);
    sqlite.pragma('journal_mode = WAL');

    // Translate common PostgreSQL-isms into SQLite equivalents.
    const translate = (sql) => sql
        .replace(/\bILIKE\b/gi, 'LIKE')
        .replace(/to_char\s*\(\s*([^,]+?)\s*,\s*'YYYY-MM'\s*\)/gi, "strftime('%Y-%m', $1)")
        .replace(/NOW\(\)\s*-\s*INTERVAL\s*'([^']+)'/gi, "datetime('now','-$1')")
        .replace(/\bNOW\(\)/gi, "datetime('now')");

    // Convert $1,$2 placeholders (and reused ones) into positional ? params,
    // reordering the supplied params to match appearance order. Also coerce
    // JS booleans/undefined which better-sqlite3 cannot bind.
    const convert = (sql, params) => {
        let s = translate(sql);
        let finalParams = params || [];
        if (/\$\d+/.test(s)) {
            const order = [];
            s = s.replace(/\$(\d+)/g, (_m, n) => { order.push(parseInt(n, 10) - 1); return '?'; });
            finalParams = order.map(i => finalParams[i]);
        }
        finalParams = finalParams.map(v =>
            v === true ? 1 : v === false ? 0 : v === undefined ? null : v
        );
        return { sql: s, params: finalParams };
    };

    // Shared implementation for the pg-style query() call.
    const runQuery = (sql, params = []) => {
        const c = convert(sql, params);
        const stmt = sqlite.prepare(c.sql);
        if (stmt.reader) {
            return { rows: stmt.all(...c.params), rowCount: undefined };
        }
        const info = stmt.run(...c.params);
        return { rows: [], rowCount: info.changes };
    };

    return {
        prepare: (sql) => ({
            get: (...args) => Promise.resolve().then(() => {
                const c = convert(sql, args);
                return sqlite.prepare(c.sql).get(...c.params) || null;
            }),
            run: (...args) => Promise.resolve().then(() => {
                const c = convert(sql, args);
                const info = sqlite.prepare(c.sql).run(...c.params);
                return { changes: info.changes, lastID: info.lastInsertRowid };
            }),
            all: (...args) => Promise.resolve().then(() => {
                const c = convert(sql, args);
                return sqlite.prepare(c.sql).all(...c.params);
            })
        }),
        query: async (sql, params = []) => runQuery(sql, params),
        querySync: (sql, params = []) => runQuery(sql, params),
        pragma: (p) => sqlite.pragma(p),
        exec: async (sql) => sqlite.exec(translate(sql)),
        close: async () => sqlite.close(),
        _sqlite: sqlite
    };
}

const db = useSqlite ? makeSqlite() : makePostgres();

console.log(`🗄️  Database driver: ${useSqlite ? 'SQLite (local)' : 'PostgreSQL'}`);

module.exports = db;
