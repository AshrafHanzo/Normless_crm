/**
 * Purchasing: the vendor list shared by Normless and Crewfit.
 *
 * Replaces `crewfit_vendors` (a name + phone remembered from the vendor-order form) with a full
 * vendor record — contact, GST and bank details — that both brands' orders and payments hang off.
 * The old table is left in place, unread, until the new pages have been in use for a while.
 *
 * Everything here is safe to run on every start. Copying the old vendors in happens only while the
 * list is empty; granting the new permissions to whoever could see vendor orders happens only on
 * the start that adds the column — so revoking a grant afterwards sticks.
 */

const db = require('../db/connection');

const exists = async (sql, vals) => !!(await db.query(sql, vals)).rows[0];

async function ensureVendorSchema() {
    try {
        const hadPerm = await exists(
            `SELECT 1 FROM information_schema.columns WHERE table_name = 'admin_users' AND column_name = 'can_view_vendors'`);

        await db.exec(`
            -- The Purchasing section. Seeing vendors, changing them, and handling money with them
            -- are three grants: bank details and payments are not every operator's business.
            ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_view_vendors BOOLEAN DEFAULT false;
            ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_edit_vendor_orders BOOLEAN DEFAULT false;
            ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_record_vendor_payments BOOLEAN DEFAULT false;

            CREATE TABLE IF NOT EXISTS vendors (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                name TEXT NOT NULL,
                contact_person TEXT,
                phone TEXT,                     -- 10-digit mobile; WhatsApp updates go here
                whatsapp_updates BOOLEAN NOT NULL DEFAULT true,
                email TEXT,
                address TEXT,
                city TEXT,
                state TEXT,
                gstin TEXT,
                pan TEXT,
                bank_account_name TEXT,
                bank_account_no TEXT,
                bank_ifsc TEXT,
                bank_name TEXT,
                upi_id TEXT,
                categories TEXT,                -- comma-separated: "Blanks, Printing"
                brands TEXT NOT NULL DEFAULT 'both',   -- normless | crewfit | both (informational)
                payment_terms TEXT,             -- what was agreed, in words
                notes TEXT,                     -- internal; never shown to the vendor
                active BOOLEAN NOT NULL DEFAULT true,
                created_by TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE UNIQUE INDEX IF NOT EXISTS vendors_name_idx ON vendors (LOWER(name));

            -- Crewfit's existing vendor orders point at the vendor record; the free-text name stays
            -- as it was typed, and is kept in step when the vendor is renamed.
            ALTER TABLE crewfit_vendor_orders ADD COLUMN IF NOT EXISTS vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL;
            CREATE INDEX IF NOT EXISTS crewfit_vendor_orders_vendor_idx ON crewfit_vendor_orders (vendor_id);
        `);

        // Seeded while the list is empty, so a start that failed half-way tries again next time.
        if (!await exists('SELECT 1 FROM vendors LIMIT 1')) {
            // Everyone the Crewfit side already knows: the remembered list, then any name typed on a
            // vendor order or a bulk order, each with the latest number seen for it.
            await db.query(`
                INSERT INTO vendors (name, phone, brands, created_by)
                SELECT DISTINCT ON (LOWER(TRIM(name))) TRIM(name), NULLIF(phone, ''), 'crewfit', 'migration'
                FROM (
                    SELECT name, phone, 1 AS rank, updated_at AS at FROM crewfit_vendors
                    UNION ALL
                    SELECT vendor, vendor_phone, 2, created_at FROM crewfit_vendor_orders
                    UNION ALL
                    SELECT vendor, NULL, 3, created_at FROM crewfit_orders WHERE vendor IS NOT NULL
                ) seen
                WHERE TRIM(COALESCE(name, '')) <> ''
                ORDER BY LOWER(TRIM(name)), (phone IS NULL OR phone = ''), rank, at DESC
                ON CONFLICT DO NOTHING`);
        }

        // Link any order not yet linked (new ones are linked on save; this catches the rest).
        await db.query(`
            UPDATE crewfit_vendor_orders o SET vendor_id = v.id
            FROM vendors v WHERE o.vendor_id IS NULL AND LOWER(TRIM(o.vendor)) = LOWER(v.name)`);

        if (!hadPerm) {
            // Whoever could open Crewfit vendor orders keeps their access to the same vendors.
            await db.query(`UPDATE admin_users SET can_view_vendors = true, can_edit_vendor_orders = true
                            WHERE can_view_crewfit_vendors = true`);
        }
        await db.query(`UPDATE admin_users SET can_view_vendors = true, can_edit_vendor_orders = true,
                            can_record_vendor_payments = true WHERE role IN ('owner','admin')`);
    } catch (err) {
        console.error('ensureVendorSchema error:', err.message);
    }
}

module.exports = { ensureVendorSchema };
