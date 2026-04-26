const { Pool } = require('pg');

// Use DATABASE_URL from environment (Render sets this automatically)
// Format: postgresql://user:password@host:port/database
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Create a synchronous-looking wrapper for PostgreSQL
const db = {
    prepare: (sql) => ({
        get: function(...args) {
            // Return a promise-like object that can be awaited
            return Promise.resolve().then(async () => {
                const client = await pool.connect();
                try {
                    // Convert SQLite ? placeholders to PostgreSQL $1, $2, etc
                    let pgSql = sql;
                    let paramIndex = 1;
                    pgSql = pgSql.replace(/\?/g, () => `$${paramIndex++}`);

                    const result = await client.query(pgSql, args);
                    return result.rows[0] || null;
                } finally {
                    client.release();
                }
            });
        },
        run: function(...args) {
            return Promise.resolve().then(async () => {
                const client = await pool.connect();
                try {
                    let pgSql = sql;
                    let paramIndex = 1;
                    pgSql = pgSql.replace(/\?/g, () => `$${paramIndex++}`);

                    const result = await client.query(pgSql, args);
                    return { changes: result.rowCount, lastID: null };
                } finally {
                    client.release();
                }
            });
        },
        all: function(...args) {
            return Promise.resolve().then(async () => {
                const client = await pool.connect();
                try {
                    let pgSql = sql;
                    let paramIndex = 1;
                    pgSql = pgSql.replace(/\?/g, () => `$${paramIndex++}`);

                    const result = await client.query(pgSql, args);
                    return result.rows;
                } finally {
                    client.release();
                }
            });
        }
    }),
    query: async (sql, params = []) => {
        const client = await pool.connect();
        try {
            const result = await client.query(sql, params);
            return result;
        } finally {
            client.release();
        }
    },
    querySync: (sql, params = []) => {
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
    close: async () => {
        await pool.end();
    }
};

module.exports = db;

