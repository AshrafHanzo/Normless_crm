/**
 * Shipping with Delhivery from the CRM: the shipments, the pickups booked, the jobs run, and the
 * settings that drive them.
 *
 * `shipments` holds every Delhivery waybill we know about: the ones the CRM created, and the ones
 * created in the Delhivery portal (or by its Shopify channel), which the tracking sync finds by
 * order number. One row per waybill, so an order that was auto-cancelled and created again has two
 * rows, the old one pointing at the new one.
 *
 * Safe to run on every start. Granting the new permissions to owners and admins happens once, on
 * the start that adds the columns.
 */

const db = require('../db/connection');

const DEFAULT_SETTINGS = {
    // Delhivery's own name for the warehouse. Taken from tracking (every shipment carries it), so
    // this is only the fallback before any shipment has been seen.
    pickup_location: 'Normless Warehouse',
    origin_pincode: '',                      // optional: only the charge estimate needs it
    return_address: { name: '', address: '', city: '', state: '', pincode: '', phone: '' },
    seller_name: 'Normless',
    default_mode: 'Surface',
    // Packaging the warehouse uses. `pack_g` is the empty packaging; `max_items` is how many pieces
    // fit. Which one an order gets comes from the packing rules below.
    boxes: [
        { key: 'poly_s', name: 'Small polybag', kind: 'polybag', l: 30, b: 25, h: 3, pack_g: 20, max_items: 2 },
        { key: 'poly_l', name: 'Large polybag', kind: 'polybag', l: 40, b: 35, h: 5, pack_g: 30, max_items: 4 },
        { key: 'box_m', name: 'Medium box', kind: 'box', l: 30, b: 25, h: 10, pack_g: 150, max_items: 4 },
        { key: 'box_l', name: 'Large box', kind: 'box', l: 40, b: 30, h: 15, pack_g: 250, max_items: 8 },
    ],
    default_box: 'poly_s',          // for products no rule mentions
    default_item_g: 300,            // per piece, when Shopify has no weight for the variant
    // [{ match: 'type' | 'product', value: 'Hoodie' | '<product id>', label, box, item_g }]
    // A product rule beats a type rule.
    pack_rules: [],
    // What happens around a shipment.
    shopify_fulfil: true,           // mark the order fulfilled in Shopify with the AWB
    sync_enabled: true,             // pull tracking from Delhivery on a timer
    sync_days: 45,                  // how far back to look for orders shipped from the portal
    auto_pickup: false,             // book the daily pickup automatically
    pickup_time: '18:00:00',
    // Alerts
    alert_risk_days: 2,             // waiting for pickup longer than this is "at risk"
    alert_whatsapp: false,
    ops_phone: '',
};

async function ensureShippingSchema() {
    try {
        const hadPerm = !!(await db.query(
            `SELECT 1 FROM information_schema.columns WHERE table_name = 'admin_users' AND column_name = 'can_view_shipping'`)).rows[0];

        await db.exec(`
            -- Seeing shipments, and acting on them (creating, cancelling, booking pickups, failed
            -- deliveries). Acting spends money on the Delhivery wallet, so it is its own grant.
            ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_view_shipping BOOLEAN DEFAULT false;
            ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_manage_shipping BOOLEAN DEFAULT false;

            CREATE TABLE IF NOT EXISTS shipments (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                awb TEXT NOT NULL UNIQUE,
                order_number TEXT,              -- "#13584", as Shopify names it
                delhivery_order TEXT,           -- the order id sent to Delhivery ("#13584-R1" for a re-create)
                shopify_order_id TEXT,
                created_via TEXT NOT NULL DEFAULT 'crm',   -- crm | portal
                -- Where the parcel is, as Delhivery last said, and our bucket for it.
                bucket TEXT NOT NULL DEFAULT 'waiting_pickup',
                status_type TEXT,               -- UD, DL, RT, CN, PP, PU
                status TEXT,                    -- Manifested, Not Picked, In Transit, Pending, Dispatched, Delivered, RTO …
                status_code TEXT,               -- NSL: X-UCI, FMEOD-152, EOD-11 …
                instructions TEXT,
                status_location TEXT,
                status_at TIMESTAMP,
                scans JSONB,
                -- The parcel.
                payment_mode TEXT,              -- COD | Prepaid
                cod_amount NUMERIC(12,2),
                total_amount NUMERIC(12,2),
                box TEXT,
                weight_g INTEGER,
                length_cm NUMERIC(8,2), width_cm NUMERIC(8,2), height_cm NUMERIC(8,2),
                shipping_mode TEXT,
                products_desc TEXT,
                consignee_name TEXT,
                consignee_city TEXT,
                consignee_state TEXT,
                consignee_pincode TEXT,
                destination TEXT,
                pickup_location TEXT,
                charge_estimate NUMERIC(10,2),
                -- Dates from Delhivery.
                manifested_at TIMESTAMP,
                picked_up_at TIMESTAMP,
                expected_delivery TIMESTAMP,
                delivered_at TIMESTAMP,
                rto_started_at TIMESTAMP,
                first_attempt_at TIMESTAMP,
                -- Failed deliveries.
                ndr_attempts INTEGER DEFAULT 0,
                ndr_reason TEXT,
                ndr_action TEXT,
                ndr_action_at TIMESTAMP,
                ndr_action_by TEXT,
                -- Cancellation. cancel_kind is 'manual' when someone here cancelled it, 'auto' when
                -- Delhivery did. An auto-cancel stays on the list until it is re-created or marked
                -- as not shipping (cancel_handled).
                cancelled_at TIMESTAMP,
                cancel_kind TEXT,
                cancel_handled TEXT,            -- recreated | not_shipping
                cancel_handled_by TEXT,
                cancel_handled_at TIMESTAMP,
                recreated_from TEXT,            -- the AWB this one replaced
                recreated_as TEXT,              -- the AWB that replaced this one
                at_risk_alerted_at TIMESTAMP,
                -- Shopify.
                shopify_fulfilled BOOLEAN DEFAULT false,
                shopify_error TEXT,
                label_url TEXT,
                created_by TEXT,
                last_tracked_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            -- forward = to the customer; return = a return or exchange pickup from the customer
            -- (Delhivery's OrderType "Pickup"). NULL until tracking has said which.
            ALTER TABLE shipments ADD COLUMN IF NOT EXISTS direction TEXT;
            CREATE INDEX IF NOT EXISTS shipments_order_idx ON shipments (order_number);
            CREATE INDEX IF NOT EXISTS shipments_bucket_idx ON shipments (bucket);
            CREATE INDEX IF NOT EXISTS shipments_created_idx ON shipments (created_at DESC);

            -- Pickups booked from the CRM. Delhivery has no API to list pickups, so what the CRM
            -- booked is all it can show, and what each one took is worked out from tracking.
            CREATE TABLE IF NOT EXISTS shipping_pickups (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                pickup_id TEXT,
                pickup_date DATE NOT NULL,
                pickup_time TEXT,
                location TEXT,
                expected_count INTEGER,
                awbs TEXT[] DEFAULT '{}',       -- what was waiting when it was booked
                status TEXT DEFAULT 'scheduled',
                response JSONB,
                created_by TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Every bulk action and automatic job, with what failed and why.
            CREATE TABLE IF NOT EXISTS shipping_jobs (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                kind TEXT NOT NULL,             -- create | recreate | cancel | pickup | ndr | sync | edit
                title TEXT,
                actor TEXT,
                status TEXT DEFAULT 'running',  -- running | done | done_with_errors | failed
                total INTEGER DEFAULT 0,
                ok INTEGER DEFAULT 0,
                failed INTEGER DEFAULT 0,
                summary TEXT,
                errors JSONB DEFAULT '[]',      -- [{ order_number, awb, error, fixed }]
                started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                finished_at TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS shipping_jobs_started_idx ON shipping_jobs (started_at DESC);

            CREATE TABLE IF NOT EXISTS shipping_settings (
                id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
                data JSONB NOT NULL DEFAULT '{}',
                updated_by TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await db.query(`INSERT INTO shipping_settings (id, data) VALUES (1, $1) ON CONFLICT (id) DO NOTHING`,
            [JSON.stringify(DEFAULT_SETTINGS)]);

        if (!hadPerm) {
            await db.query(`UPDATE admin_users SET can_view_shipping = true, can_manage_shipping = true
                             WHERE role IN ('owner','admin')`);
        }
    } catch (err) {
        console.error('ensureShippingSchema error:', err.message);
    }
}

module.exports = { ensureShippingSchema, DEFAULT_SETTINGS };
