/**
 * Purchasing: vendors, the orders raised to them, and what has been paid — shared by Normless
 * and Crewfit.
 *
 * `vendor_orders` is Crewfit's old `crewfit_vendor_orders`, renamed in place and tagged with a
 * brand, so every existing order, ref number and link carries over untouched. `vendors` replaced
 * `crewfit_vendors` (a name + phone remembered from the order form), which is left in place,
 * unread, for now.
 *
 * Payments: one row per payment made, with the UTR, split across orders by allocations. What is
 * paid on an order is the sum of its allocations; money not allocated is credit "on account".
 *
 * Everything here is safe to run on every start. The one-off steps run only on the start that
 * first needs them: copying the old vendors in (while the list is empty), granting the new
 * permissions (when the column is added), and turning orders already marked Paid into payments
 * (when the payments table is created).
 */

const db = require('../db/connection');

const exists = async (sql, vals) => !!(await db.query(sql, vals)).rows[0];
const hasTable = (name) => exists(`SELECT 1 WHERE to_regclass($1) IS NOT NULL`, [`public.${name}`]);

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
        `);

        // Crewfit's vendor orders become everyone's: same rows, same ids, same VO numbers.
        if (await hasTable('crewfit_vendor_orders') && !await hasTable('vendor_orders')) {
            await db.exec(`
                ALTER TABLE crewfit_vendor_orders RENAME TO vendor_orders;
                ALTER INDEX IF EXISTS crewfit_vendor_orders_date_idx RENAME TO vendor_orders_date_idx;
                ALTER INDEX IF EXISTS crewfit_vendor_orders_ref_idx RENAME TO vendor_orders_ref_idx;
                ALTER INDEX IF EXISTS crewfit_vendor_orders_vendor_idx RENAME TO vendor_orders_vendor_idx;
            `);
        }

        const hadPayments = await hasTable('vendor_payments');
        await db.exec(`
            CREATE TABLE IF NOT EXISTS vendor_orders (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                ref_no INTEGER,
                order_date DATE NOT NULL,
                vendor TEXT NOT NULL,           -- the name as typed; kept in step on a rename
                vendor_phone TEXT,
                delivery_date DATE,
                status TEXT DEFAULT 'Pending',
                payment_status TEXT DEFAULT 'Not Paid',
                -- [{ product_type, gsm, rate, colors:[{ color, sizes:{S:2,...} }] }]   apparel
                -- [{ kind:'simple', product_type, qty, rate }]                         anything else
                items TEXT,
                notes TEXT,
                total_qty INTEGER DEFAULT 0,
                total_amount NUMERIC,           -- worked out from the lines' rates
                confirmed_at TIMESTAMP,
                sent_at TIMESTAMP,
                created_by TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            ALTER TABLE vendor_orders ADD COLUMN IF NOT EXISTS delivery_date DATE;
            ALTER TABLE vendor_orders ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'Not Paid';
            ALTER TABLE vendor_orders ADD COLUMN IF NOT EXISTS vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL;
            -- Every order already here is Crewfit's.
            ALTER TABLE vendor_orders ADD COLUMN IF NOT EXISTS brand TEXT NOT NULL DEFAULT 'crewfit';
            ALTER TABLE vendor_orders ADD COLUMN IF NOT EXISTS title TEXT;
            -- The vendor's quotation number, as printed on it (e.g. EDS0109136).
            ALTER TABLE vendor_orders ADD COLUMN IF NOT EXISTS quote_ref TEXT;
            -- The agreed total, GST included, when it isn't simply rate × quantity — a quote
            -- that gives one figure for the whole job.
            ALTER TABLE vendor_orders ADD COLUMN IF NOT EXISTS total_override NUMERIC;
            -- Sum of this order's payment allocations, kept here so lists can sort and filter on it.
            ALTER TABLE vendor_orders ADD COLUMN IF NOT EXISTS paid_amount NUMERIC NOT NULL DEFAULT 0;
            CREATE INDEX IF NOT EXISTS vendor_orders_date_idx ON vendor_orders (order_date DESC);
            CREATE UNIQUE INDEX IF NOT EXISTS vendor_orders_ref_idx ON vendor_orders (ref_no);
            CREATE INDEX IF NOT EXISTS vendor_orders_vendor_idx ON vendor_orders (vendor_id);
            CREATE INDEX IF NOT EXISTS vendor_orders_brand_idx ON vendor_orders (brand);

            CREATE TABLE IF NOT EXISTS vendor_payments (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
                paid_on DATE NOT NULL,
                amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
                mode TEXT,                      -- NEFT | IMPS | UPI | RTGS | Cheque | Cash
                reference TEXT,                 -- UTR / bank transaction no. / cheque no.
                paid_from TEXT,                 -- which of our accounts
                note TEXT,
                proof_path TEXT,                -- under server/storage/vendors, never served publicly
                proof_name TEXT,
                proof_mime TEXT,
                source TEXT NOT NULL DEFAULT 'manual',   -- manual | migrated
                created_by TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_by TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS vendor_payments_vendor_idx ON vendor_payments (vendor_id, paid_on DESC);

            CREATE TABLE IF NOT EXISTS vendor_payment_allocations (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                payment_id INTEGER NOT NULL REFERENCES vendor_payments(id) ON DELETE CASCADE,
                order_id INTEGER NOT NULL REFERENCES vendor_orders(id) ON DELETE CASCADE,
                amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
                UNIQUE (payment_id, order_id)
            );
            CREATE INDEX IF NOT EXISTS vendor_payment_alloc_order_idx ON vendor_payment_allocations (order_id);

            -- The payment plan agreed for an order: advance, then instalments. A schedule, not a
            -- gate — payments are never matched to an instalment; whatever is paid on the order
            -- covers the instalments in order (services/vendor-plan).
            CREATE TABLE IF NOT EXISTS vendor_order_instalments (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                order_id INTEGER NOT NULL REFERENCES vendor_orders(id) ON DELETE CASCADE,
                seq INTEGER NOT NULL,
                label TEXT,
                amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
                percent NUMERIC(6,3),           -- set when it was agreed as a share of the total
                due_kind TEXT NOT NULL DEFAULT 'date',   -- date | delivery
                due_date DATE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS vendor_order_instalments_order_idx ON vendor_order_instalments (order_id, seq);

            -- Goods in: each delivery against an order, as the vendor's lot arrived. Lines are
            -- [{ product, color, size, received, rejected }] — matched to the order's lines by
            -- product, colour and size (services/vendor-receipts).
            CREATE TABLE IF NOT EXISTS vendor_receipts (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                order_id INTEGER NOT NULL REFERENCES vendor_orders(id) ON DELETE CASCADE,
                received_on DATE NOT NULL,
                challan_no TEXT,
                note TEXT,
                lines TEXT NOT NULL,
                received_qty INTEGER NOT NULL DEFAULT 0,
                rejected_qty INTEGER NOT NULL DEFAULT 0,
                created_by TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_by TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS vendor_receipts_order_idx ON vendor_receipts (order_id, received_on);
            -- Sums of the receipts, kept on the order so lists can show and sort on them.
            ALTER TABLE vendor_orders ADD COLUMN IF NOT EXISTS received_qty INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE vendor_orders ADD COLUMN IF NOT EXISTS rejected_qty INTEGER NOT NULL DEFAULT 0;

            -- A vendor's usual terms as a template a new order's plan can start from:
            -- [{ label, percent | amount, due_kind: 'days' | 'delivery', days }]
            ALTER TABLE vendors ADD COLUMN IF NOT EXISTS default_plan TEXT;
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
                    SELECT vendor, vendor_phone, 2, created_at FROM vendor_orders
                    UNION ALL
                    SELECT vendor, NULL, 3, created_at FROM crewfit_orders WHERE vendor IS NOT NULL
                ) seen
                WHERE TRIM(COALESCE(name, '')) <> ''
                ORDER BY LOWER(TRIM(name)), (phone IS NULL OR phone = ''), rank, at DESC
                ON CONFLICT DO NOTHING`);
        }

        // Link any order not yet linked (new ones are linked on save; this catches the rest).
        await db.query(`
            UPDATE vendor_orders o SET vendor_id = v.id
            FROM vendors v WHERE o.vendor_id IS NULL AND LOWER(TRIM(o.vendor)) = LOWER(v.name)`);

        if (!hadPayments) {
            // Orders already marked Paid that carry a value become one payment each, so balances
            // are right from the first day. No UTR was ever recorded for them, and they are marked
            // as migrated so they aren't flagged as missing one. Orders marked Paid with no value
            // keep the hand-set flag: there is no amount to record.
            const paid = (await db.query(`
                SELECT id, vendor_id, COALESCE(total_override, total_amount) AS total,
                       COALESCE(updated_at::date, order_date) AS paid_on
                FROM vendor_orders
                WHERE payment_status = 'Paid' AND vendor_id IS NOT NULL
                  AND COALESCE(total_override, total_amount) > 0`)).rows;
            for (const o of paid) {
                await db.transaction(async (c) => {
                    const p = (await c.query(
                        `INSERT INTO vendor_payments (vendor_id, paid_on, amount, note, source, created_by)
                         VALUES ($1, $2, $3, 'Marked paid before payments were recorded', 'migrated', 'migration')
                         RETURNING id`, [o.vendor_id, o.paid_on, o.total])).rows[0];
                    await c.query('INSERT INTO vendor_payment_allocations (payment_id, order_id, amount) VALUES ($1, $2, $3)',
                        [p.id, o.id, o.total]);
                    await c.query('UPDATE vendor_orders SET paid_amount = $1 WHERE id = $2', [o.total, o.id]);
                });
            }
        }

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
