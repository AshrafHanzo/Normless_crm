const { Pool } = require('pg');

// Use DATABASE_URL from environment (Render sets this automatically)
// Format: postgresql://user:password@host:port/database
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Create a synchronous wrapper for compatibility with existing code
const db = {
    prepare: (sql) => ({
        get: function(...args) {
            // This is called synchronously but we need async handling
            throw new Error('Use db.query() for async queries instead of db.prepare().get()');
        },
        run: function(...args) {
            throw new Error('Use db.query() for async queries instead of db.prepare().run()');
        },
        all: function(...args) {
            throw new Error('Use db.query() for async queries instead of db.prepare().all()');
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
        // For critical startup operations that need sync behavior
        // This is a workaround - in production, refactor to async
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

