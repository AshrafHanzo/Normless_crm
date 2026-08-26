const express = require('express');
const fs = require('fs');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');
const db = require('./db/connection');

// Load .env from the root directory
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
// Stash the raw bytes alongside the parsed body — the Razorpay webhook needs to HMAC-verify
// the exact raw payload against its signature header, which is lost once JSON.parse runs.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
 
// LOUD LOGGER
app.use((req, res, next) => {
    const log = `🚀 [HIT] ${req.method} ${req.url} (Path: ${req.path}) at ${new Date().toISOString()}\n`;
    try {
        const logPath = path.join(__dirname, 'debug.log');
        fs.appendFileSync(logPath, log);
    } catch (e) {
        console.error('Logging failed:', e.message);
    }
    console.log(log);
    next();
});

// Auth middleware
const authMiddleware = require('./middleware/auth');

// --- THE VIP SCANNER ROUTE (HARDCODED HERE FOR MAX RELIABILITY) ---
app.get('/api/scanner/lookup/:id', authMiddleware, async (req, res) => {
    const id = req.params.id;
    console.log(`🎯 [VIP SCAN HIT] Looking for order: "${id}"`);
    
    try {
        // Search logic (Try exact, then try with/without #)
        let order = await db.prepare(`
            SELECT o.*, c.first_name, c.last_name, c.email as customer_email
            FROM orders o
            LEFT JOIN customers c ON o.customer_shopify_id = c.shopify_id
            WHERE o.order_number = ?
        `).get(id);

        if (!order) {
            const altId = id.startsWith('#') ? id.substring(1) : `#${id}`;
            order = await db.prepare(`
                SELECT o.*, c.first_name, c.last_name, c.email as customer_email
                FROM orders o
                LEFT JOIN customers c ON o.customer_shopify_id = c.shopify_id
                WHERE o.order_number = ?
            `).get(altId);
        }

        if (order) {
            // Dynamically fetch product images for the line items
            try {
                let lineItems = JSON.parse(order.line_items_json || '[]');
                const token = process.env.SHOPIFY_ACCESS_TOKEN;
                const domain = process.env.SHOPIFY_STORE_DOMAIN;
                
                if (token && domain) {
                    let updated = false;
                    for (let li of lineItems) {
                        console.log(`Checking image for: ${li.title}`);
                        // Fetch if main image is missing OR if gallery (all_images) is empty
                        if ((!li.image || !li.all_images || li.all_images.length === 0) && li.title) {
                            const url = `https://${domain}/admin/api/2026-04/products.json?title=${encodeURIComponent(li.title)}`;
                            const pRes = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
                            if (pRes.ok) {
                                const pData = await pRes.json();
                                console.log(`API returned ${pData.products?.length || 0} products`);
                                if (pData.products && pData.products.length > 0) {
                                    const prod = pData.products[0];
                                    if (prod.image) {
                                        li.image = prod.image.src;
                                        updated = true;
                                    }
                                    if (prod.images && prod.images.length > 0) {
                                        // Extract color from variant title (e.g. "Black / M" -> "Black")
                                        const colorPart = li.variant ? li.variant.split(' / ')[0].trim().toLowerCase() : '';
                                        const knownColors = ['black', 'white', 'beige', 'brown', 'blue', 'green', 'red', 'grey', 'yellow', 'pink', 'purple', 'orange', 'navy'];

                                        li.all_images = prod.images
                                            .filter(img => {
                                                // 1. Check if image is explicitly linked to this variant ID
                                                if (li.shopify_variant_id && img.variant_ids && img.variant_ids.includes(li.shopify_variant_id)) return true;

                                                // 2. Check if image alt text matches the color
                                                const alt = img.alt ? img.alt.toLowerCase().trim() : '';
                                                if (colorPart && alt === colorPart) return true;

                                                // 3. If image has a different color in alt text, exclude it
                                                const hasOtherColor = knownColors.some(c => c !== colorPart && alt.includes(c));
                                                if (hasOtherColor) return false;

                                                // 4. If no color information, include it (e.g. size charts, generic close-ups)
                                                return true;
                                            })
                                            .map(img => img.src);

                                        updated = true;
                                        console.log(`Set ${li.all_images.length} filtered images for gallery (Color: ${colorPart})`);
                                    }
                                }
                            } else {
                                console.log(`API Error: ${pRes.status}`);
                            }
                        }
                    }
                    
                    if (updated) {
                        order.line_items_json = JSON.stringify(lineItems);
                        await db.prepare('UPDATE orders SET line_items_json = ? WHERE id = ?').run(order.line_items_json, order.id);
                        console.log('Saved updated line_items_json to DB');
                    }
                } else {
                    console.log('Missing token or domain for dynamic fetch');
                }
            } catch (imgErr) {
                console.error('Failed to fetch images dynamically:', imgErr.message);
            }

            // Process Line Items (Parse JSON and format variants for the UI)
            if (order.line_items_json) {
                try {
                    const rawItems = JSON.parse(order.line_items_json);
                    order.line_items = rawItems.map(item => {
                        // If we have a variant like "Black / XS", split it for the UI specs
                        if (item.variant && !item.options) {
                            const parts = item.variant.split(' / ');
                            item.options = [
                                { name: 'Color', value: parts[0] || 'N/A' },
                                { name: 'Size', value: parts[1] || 'N/A' }
                            ];
                        }
                        return item;
                    });
                } catch (e) {
                    order.line_items = [];
                }
            }
            // Does the RTO shelf already hold one of these? Asked here rather than from the page,
            // because the packer scanning to dispatch may not have inventory access at all — and
            // this is the last moment before a fresh garment is printed for nothing.
            try {
                const inv = require('./services/inventory');
                order.rto_matches = await inv.rtoForOrderNumber(order.order_number);
            } catch (rtoErr) {
                console.error('RTO check failed:', rtoErr.message);
                order.rto_matches = [];
            }

            console.log(`✅ [FOUND] Order ${order.order_number} with ${order.line_items.length} items`);
            return res.json(order);
        } else {
            console.log(`❌ [NOT FOUND] No order matches "${id}"`);
            return res.status(404).json({ error: `Order "${id}" not found in local database.` });
        }
    } catch (err) {
        console.error('🔥 [DB ERROR]', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Routes
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const customerRoutes = require('./routes/customers');
const orderRoutes = require('./routes/orders');
const interactionRoutes = require('./routes/interactions');
const dashboardRoutes = require('./routes/dashboard');
const syncRoutes = require('./routes/sync');
const invoiceRoutes = require('./routes/invoices');
const crewfitRoutes = require('./routes/crewfit');
const crewfitQuotesRoutes = require('./routes/crewfit-quotes');
const { convertQuoteToOrder } = crewfitQuotesRoutes;
const razorpayConfig = require('./config/razorpay');
const crewfitPaymentsRoutes = require('./routes/crewfit-payments');
const { settlePayment } = crewfitPaymentsRoutes;
const crewfitCustomersRoutes = require('./routes/crewfit-customers');
const crewfitVendorOrderRoutes = require('./routes/crewfit-vendor-orders');
const marketingRoutes = require('./routes/marketing');

// Public routes
app.use('/api/auth', authRoutes);

// Razorpay webhook — unauthenticated (Razorpay calls this directly, not a logged-in CRM user),
// so it's registered ahead of the authMiddleware-gated /api/crewfit mount below. Verifies the
// HMAC signature itself instead of relying on a bearer token. On a paid payment link, marks the
// quote Paid and auto-creates the real order from it.
app.post('/api/crewfit/webhooks/razorpay', async (req, res) => {
    const crypto = require('crypto');
    try {
        // Must be the secret for the active mode — a Test-mode webhook is signed with the
        // Test secret and would fail verification against the Live one.
        const secret = razorpayConfig.webhookSecret;
        const signature = req.headers['x-razorpay-signature'];
        if (!secret || !signature || !req.rawBody) return res.status(400).json({ error: 'Missing webhook secret/signature' });
        const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
        if (expected !== signature) return res.status(400).json({ error: 'Invalid signature' });

        const event = req.body;
        if (event.event !== 'payment_link.paid') return res.json({ received: true });

        const linkId = event.payload?.payment_link?.entity?.id;
        if (!linkId) return res.json({ received: true });
        const rzpPaymentId = event.payload?.payment?.entity?.id;

        // Order payments (advance / balance / custom) — settling one moves the order's
        // payment_status and, where relevant, its pipeline status.
        const pr = await db.query('SELECT * FROM crewfit_payments WHERE razorpay_payment_link_id = $1', [linkId]);
        if (pr.rows[0]) {
            const result = await settlePayment(pr.rows[0], { razorpayPaymentId: rzpPaymentId });
            if (result.alreadySettled) console.log(`↩️  Razorpay re-delivery for payment #${pr.rows[0].id} — already settled`);
            return res.json({ received: true });
        }

        const qr = await db.query('SELECT * FROM crewfit_quotes WHERE razorpay_payment_link_id = $1', [linkId]);
        const quote = qr.rows[0];
        if (!quote || quote.converted_order_id) return res.json({ received: true }); // already converted / unknown link

        quote.status = 'Paid'; // so convertQuoteToOrder marks the resulting order Fully Paid
        const orderId = await convertQuoteToOrder(quote);

        await db.query(
            `UPDATE crewfit_quotes SET status = 'Paid', converted_order_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
            [orderId, quote.id]
        );

        console.log(`✅ Razorpay payment_link.paid — quote #${quote.id} converted to order #${orderId}`);
        res.json({ received: true });
    } catch (err) {
        console.error('Razorpay webhook error:', err);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

// Admin routes (require auth)
app.use('/api/admin', authMiddleware, adminRoutes);

// Protected routes
app.use('/api/customers', authMiddleware, customerRoutes);
app.use('/api/orders', authMiddleware, orderRoutes);
app.use('/api/interactions', authMiddleware, interactionRoutes);
app.use('/api/dashboard', authMiddleware, dashboardRoutes);
app.use('/api/sync', authMiddleware, syncRoutes);
app.use('/api/invoices', authMiddleware, invoiceRoutes);
app.use('/api/crewfit/quotes', authMiddleware, crewfitQuotesRoutes);
app.use('/api/crewfit/payments', authMiddleware, crewfitPaymentsRoutes);
app.use('/api/crewfit/customers', authMiddleware, crewfitCustomersRoutes);
app.use('/api/crewfit/vendor-orders', authMiddleware, crewfitVendorOrderRoutes);
app.use('/api/crewfit/invoices', authMiddleware, require('./routes/crewfit-invoices'));
app.use('/api/inventory', authMiddleware, require('./routes/inventory'));
app.use('/api/crewfit', authMiddleware, crewfitRoutes);
app.use('/api/marketing', authMiddleware, marketingRoutes);

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'Normless CRM Backend is running!' });
});

// JSON 404 for missing API routes
app.use('/api', (req, res) => {
    console.log(`🚨 [API 404] No route matched for ${req.url}`);
    res.status(404).json({ error: `API route not found: ${req.url}` });
});

// Uploaded design mocks / production photos (Crewfit orders)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Serve React frontend in production
const clientBuildPath = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientBuildPath));

// Catch-all for SPA routing
app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(clientBuildPath, 'index.html'), (err) => {
      if (err) next();
    });
  } else {
    next();
  }
});

// Auto-Sync Service - Starts automatically
const syncService = require('./services/sync');
let autoSyncInterval = null;
let isSyncing = false;

function startAutoSync() {
    const intervalSeconds = 30; // Default 30 seconds

    console.log(`⏱️  Starting auto-sync (every ${intervalSeconds} seconds)...`);

    autoSyncInterval = setInterval(() => {
        if (!isSyncing) {
            isSyncing = true;
            syncService.syncAll()
                .then(async () => {
                    isSyncing = false;
                    // A new order that wants something already on the RTO shelf is flagged here,
                    // so the notice exists whether or not anyone has the page open.
                    try {
                        const { raised } = await require('./services/inventory').syncRtoAlerts();
                        if (raised) console.log(`↩  ${raised} RTO notice${raised > 1 ? 's' : ''} raised`);
                    } catch (e) { console.error('RTO alert sync failed:', e.message); }
                    console.log(`✨ Auto-sync completed at ${new Date().toLocaleTimeString()}`);
                })
                .catch(err => {
                    isSyncing = false;
                    console.error('❌ Auto-sync failed:', err.message);
                });
        }
    }, intervalSeconds * 1000);

    console.log(`✅ Auto-sync is ACTIVE! Syncing every ${intervalSeconds} seconds`);
}

// Initialize database on startup (for PostgreSQL recovery)
async function ensureAdminUser() {
    try {
        const username = process.env.ADMIN_USERNAME || 'normlessfashion@gmail.com';
        const result = await db.query('SELECT id FROM admin_users WHERE username = $1', [username]);
        if (result.rows.length === 0) {
            console.log('🔄 Admin user missing - creating owner...');
            const bcrypt = require('bcryptjs');
            const crypto = require('crypto');
            // Password comes from env; if unset, generate a random one and print it once.
            const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64');
            const hash = bcrypt.hashSync(password, bcrypt.genSaltSync(10));
            await db.query(
                `INSERT INTO admin_users (username, password_hash, role, is_active,
                    can_view_dashboard, can_view_customers, can_view_orders, can_scan_orders, can_sync_data)
                 VALUES ($1, $2, 'owner', true, true, true, true, true, true)`,
                [username, hash]
            );
            console.log(process.env.ADMIN_PASSWORD
                ? `✅ Owner admin created: ${username}`
                : `✅ Owner admin created: ${username} / ${password}  (set ADMIN_PASSWORD in .env to control this)`);
        }
    } catch (error) {
        console.error('Error ensuring admin user:', error);
    }
}

// Ensure the Crewfit products catalog table exists + is seeded, and that the
// orders table has the `product` column. Idempotent; safe on every boot.
async function ensureCrewfitSchema() {
    try {
        await db.exec(`
            CREATE TABLE IF NOT EXISTS crewfit_products (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                name TEXT, category TEXT, fit TEXT, gsm TEXT, material TEXT,
                from_price NUMERIC, blurb TEXT,
                features TEXT, colors TEXT, tiers TEXT,
                active BOOLEAN DEFAULT true, sort_order INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            -- HSN drives the tax register's HSN-wise summary, and polos, tees and sweatshirts
            -- are genuinely different headings.
            ALTER TABLE crewfit_products ADD COLUMN IF NOT EXISTS hsn TEXT;
        `);
        // Per-brand + per-page access columns on admin_users
        try {
            await db.exec(`
                ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_access_normless BOOLEAN DEFAULT false;
                ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_access_crewfit BOOLEAN DEFAULT false;
                ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_view_crewfit_followups BOOLEAN DEFAULT false;
                ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_view_crewfit_orders BOOLEAN DEFAULT false;
                ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_view_crewfit_catalog BOOLEAN DEFAULT false;
                ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_view_crewfit_analytics BOOLEAN DEFAULT false;
                ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_view_crewfit_calculator BOOLEAN DEFAULT false;
                ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_view_crewfit_payments BOOLEAN DEFAULT false;
                ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_view_crewfit_customers BOOLEAN DEFAULT false;
                -- Not a page permission: gates the money totals shown across Payments, Customers
                -- and the dashboard, so staff can work orders without seeing overall revenue.
                ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_view_revenue BOOLEAN DEFAULT false;
                -- Normless GST sales invoicing (the Invoices menu).
                ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_view_invoices BOOLEAN DEFAULT false;
                -- Crewfit purchase orders raised to manufacturing vendors.
                ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_view_crewfit_vendors BOOLEAN DEFAULT false;
                ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_view_crewfit_invoices BOOLEAN DEFAULT false;
                -- Write access to bulk orders, separate from seeing them: a read-only operator
                -- can open every order but change none.
                ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_edit_crewfit_orders BOOLEAN DEFAULT false;
                ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_approve_marketing BOOLEAN DEFAULT false;
                -- Normless influencer marketing: the roster and the seeding orders raised against it.
                ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_view_marketing BOOLEAN DEFAULT false;
                -- Separate from the page itself: only production fills in AWB/tracking and marks
                -- an influencer order dispatched. Marketing sees those fields but can't edit them.
                ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_dispatch_marketing BOOLEAN DEFAULT false;
            `);
            await db.query(`UPDATE admin_users SET can_access_normless=true, can_access_crewfit=true,
                can_view_crewfit_followups=true, can_view_crewfit_orders=true, can_view_crewfit_catalog=true,
                can_view_crewfit_analytics=true, can_view_crewfit_calculator=true, can_view_crewfit_payments=true,
                can_view_crewfit_customers=true, can_view_revenue=true, can_view_invoices=true,
                can_view_crewfit_vendors=true, can_view_crewfit_invoices=true, can_edit_crewfit_orders=true,
                can_view_marketing=true, can_dispatch_marketing=true,
                can_view_inventory=true, can_edit_inventory=true, can_approve_marketing=true
                WHERE role IN ('owner','admin')`);
        } catch (e) { console.error('admin perms ensure:', e.message); }

        try {
            await db.exec(`
                ALTER TABLE crewfit_orders ADD COLUMN IF NOT EXISTS product TEXT;
                ALTER TABLE crewfit_orders ADD COLUMN IF NOT EXISTS printing TEXT;
                ALTER TABLE crewfit_orders ADD COLUMN IF NOT EXISTS delivery_location TEXT;
                ALTER TABLE crewfit_orders ADD COLUMN IF NOT EXISTS billing_name TEXT;
                ALTER TABLE crewfit_orders ADD COLUMN IF NOT EXISTS contact_person TEXT;
                ALTER TABLE crewfit_orders ADD COLUMN IF NOT EXISTS billing_mobile TEXT;
                ALTER TABLE crewfit_orders ADD COLUMN IF NOT EXISTS billing_email TEXT;
                ALTER TABLE crewfit_orders ADD COLUMN IF NOT EXISTS gst_number TEXT;
                ALTER TABLE crewfit_orders ADD COLUMN IF NOT EXISTS billing_address TEXT;
                ALTER TABLE crewfit_orders ADD COLUMN IF NOT EXISTS unit_price NUMERIC;
                ALTER TABLE crewfit_orders ADD COLUMN IF NOT EXISTS line_items TEXT;
                ALTER TABLE crewfit_orders ADD COLUMN IF NOT EXISTS invoices TEXT;
                CREATE SEQUENCE IF NOT EXISTS crewfit_invoice_seq START 1;
                ALTER TABLE crewfit_orders ADD COLUMN IF NOT EXISTS whatsapp_number TEXT;
                ALTER TABLE crewfit_orders ADD COLUMN IF NOT EXISTS tracking_sent_at TIMESTAMP;
                ALTER TABLE crewfit_orders ADD COLUMN IF NOT EXISTS product_total NUMERIC;
                ALTER TABLE crewfit_orders ADD COLUMN IF NOT EXISTS shipping NUMERIC;
                ALTER TABLE crewfit_orders ADD COLUMN IF NOT EXISTS gst_amount NUMERIC;
                ALTER TABLE crewfit_orders ADD COLUMN IF NOT EXISTS grand_total NUMERIC;
                ALTER TABLE crewfit_orders ADD COLUMN IF NOT EXISTS advance NUMERIC;
                ALTER TABLE crewfit_orders ADD COLUMN IF NOT EXISTS balance NUMERIC;
                ALTER TABLE crewfit_orders ADD COLUMN IF NOT EXISTS photos_sent_at TIMESTAMP;
                -- Place of supply decides CGST+SGST vs IGST on the tax invoice and in the register.
                -- The billing address is free text, so the state has to be held on its own.
                ALTER TABLE crewfit_orders ADD COLUMN IF NOT EXISTS place_of_supply TEXT;
            `);
        } catch { /* orders table may not exist yet */ }

        // Crewfit quotes — priced + sent on WhatsApp; becomes a real order once the customer
        // confirms (manual, via the prefilled order form) or, optionally, once a Razorpay
        // payment link is paid (see the /api/crewfit/webhooks/razorpay handler).
        try {
            await db.exec(`
                CREATE TABLE IF NOT EXISTS crewfit_quotes (
                    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                    customer_name TEXT, contact_number TEXT,
                    zone_id TEXT, zone_label TEXT,
                    line_items TEXT, product_total NUMERIC, shipping_charge NUMERIC, gst_amount NUMERIC, grand_total NUMERIC,
                    notes TEXT, status TEXT DEFAULT 'Draft',
                    razorpay_payment_link_id TEXT, razorpay_short_url TEXT,
                    converted_order_id INTEGER, created_by TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
                ALTER TABLE crewfit_quotes ADD COLUMN IF NOT EXISTS gst_amount NUMERIC;
            `);
        } catch (e) { console.error('crewfit_quotes ensure:', e.message); }

        // Crewfit tax documents, promoted out of crewfit_orders.invoices (JSONB) so a tax register
        // can be built from them: queryable by date, indexable, and — unlike a column on the order
        // — able to outlive the order it belongs to. Six issued numbers (0001–0006) were already
        // lost when their orders were deleted; nothing here may go the same way.
        //
        // Two independent series. A proforma acknowledges an advance and carries no GST, so it must
        // never consume a tax invoice number; the tax invoice is issued once for the full order
        // value when the balance lands. `status` records reclassification: the advance documents
        // issued before this split existed were sent as tax invoices and are proformas in truth.
        try {
            await db.exec(`
                CREATE TABLE IF NOT EXISTS crewfit_invoices (
                    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                    order_id INTEGER,
                    doc_type TEXT NOT NULL,            -- 'tax_invoice' | 'proforma'
                    number TEXT NOT NULL,
                    series TEXT NOT NULL,              -- 'CREWFIT' | 'PRO'
                    fy TEXT NOT NULL,
                    seq INTEGER,
                    issue_date DATE NOT NULL,
                    status TEXT NOT NULL DEFAULT 'issued',  -- 'issued' | 'reclassified' | 'cancelled'
                    note TEXT,
                    qty INTEGER,
                    taxable NUMERIC, gst_pct NUMERIC, gst_amount NUMERIC, gross NUMERIC,
                    place_of_supply TEXT, gstin TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
                CREATE UNIQUE INDEX IF NOT EXISTS crewfit_invoices_number_idx ON crewfit_invoices (number);
                CREATE INDEX IF NOT EXISTS crewfit_invoices_order_idx ON crewfit_invoices (order_id);
                CREATE INDEX IF NOT EXISTS crewfit_invoices_date_idx ON crewfit_invoices (issue_date);
                CREATE SEQUENCE IF NOT EXISTS crewfit_proforma_seq START 1;
            `);
        } catch (e) { console.error('crewfit_invoices ensure:', e.message); }

        // Razorpay payment links. One row per link ever generated — the advance and balance
        // halves of an order, plus standalone "custom" links not tied to any order. Kept in
        // its own table (rather than columns on the order) so the Payments tab can show the
        // full transaction history, including cancelled and superseded links.
        try {
            await db.exec(`
                CREATE TABLE IF NOT EXISTS crewfit_payments (
                    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                    order_id INTEGER, kind TEXT NOT NULL DEFAULT 'custom',
                    customer_name TEXT, contact_number TEXT, email TEXT,
                    amount NUMERIC NOT NULL, description TEXT, notes TEXT,
                    status TEXT NOT NULL DEFAULT 'Created',
                    razorpay_payment_link_id TEXT, razorpay_short_url TEXT,
                    razorpay_payment_id TEXT, razorpay_mode TEXT,
                    paid_at TIMESTAMP, cancelled_at TIMESTAMP,
                    sent_at TIMESTAMP, created_by TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
                ALTER TABLE crewfit_payments ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMP;
                CREATE INDEX IF NOT EXISTS crewfit_payments_link_idx ON crewfit_payments (razorpay_payment_link_id);
                CREATE INDEX IF NOT EXISTS crewfit_payments_order_idx ON crewfit_payments (order_id);
            `);
        } catch (e) { console.error('crewfit_payments ensure:', e.message); }

        // Purchase orders raised to manufacturing vendors. Deliberately standalone — one vendor
        // order can cover several styles at once, so tying it to a single customer order would
        // fit the minority case.
        try {
            await db.exec(`
                CREATE TABLE IF NOT EXISTS crewfit_vendor_orders (
                    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                    ref_no INTEGER,
                    order_date DATE NOT NULL,
                    vendor TEXT NOT NULL,
                    vendor_phone TEXT,
                    delivery_date DATE,
                    status TEXT DEFAULT 'Pending',
                    payment_status TEXT DEFAULT 'Not Paid',
                    -- [{ product_type, gsm, rate, colors:[{ color, sizes:{S:2,...} }] }]
                    items TEXT,
                    notes TEXT,
                    total_qty INTEGER DEFAULT 0,
                    total_amount NUMERIC,
                    confirmed_at TIMESTAMP,
                    sent_at TIMESTAMP,
                    created_by TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
                ALTER TABLE crewfit_vendor_orders ADD COLUMN IF NOT EXISTS delivery_date DATE;
                ALTER TABLE crewfit_vendor_orders ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'Not Paid';
                CREATE INDEX IF NOT EXISTS crewfit_vendor_orders_date_idx ON crewfit_vendor_orders (order_date DESC);
                CREATE UNIQUE INDEX IF NOT EXISTS crewfit_vendor_orders_ref_idx ON crewfit_vendor_orders (ref_no);

                -- Remembers vendors and their WhatsApp numbers so the dropdown fills itself as
                -- new names are typed in; a vendor typed once is offered from then on.
                CREATE TABLE IF NOT EXISTS crewfit_vendors (
                    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                    name TEXT NOT NULL,
                    phone TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
                CREATE UNIQUE INDEX IF NOT EXISTS crewfit_vendors_name_idx ON crewfit_vendors (LOWER(name));
            `);
        } catch (e) { console.error('crewfit_vendor_orders ensure:', e.message); }

        const c = await db.query('SELECT COUNT(*) AS n FROM crewfit_products');
        if (parseInt(c.rows[0].n, 10) === 0) {
            const products = require('./data/crewfitProducts');
            for (let i = 0; i < products.length; i++) {
                const p = products[i];
                await db.query(
                    `INSERT INTO crewfit_products (name, category, fit, gsm, material, from_price, blurb, features, colors, tiers, sort_order)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
                    [p.name, p.category, p.fit, String(p.gsm), p.material, p.from, p.blurb,
                     JSON.stringify(p.features), JSON.stringify(p.colors), JSON.stringify(p.tiers), i]
                );
            }
            console.log(`✅ Seeded ${products.length} Crewfit products`);
        }
    } catch (err) {
        console.error('ensureCrewfitSchema error:', err.message);
    }
}

// Who changed what on a Crewfit order, and when.
//
// One row per field per change, rather than a snapshot of the order: the questions this has to
// answer are "who moved this to Dispatched" and "how long did it sit in production", and both are
// about a single field's history, not the whole record's.
async function ensureOrderAuditSchema() {
    try {
        await db.exec(`
            CREATE TABLE IF NOT EXISTS crewfit_order_audit (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                order_id INTEGER NOT NULL,
                sl_no INTEGER,
                customer_name TEXT,
                field TEXT NOT NULL,
                old_value TEXT,
                new_value TEXT,
                action TEXT NOT NULL DEFAULT 'update',  -- 'create' | 'update' | 'delete'
                changed_by TEXT,
                changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS crewfit_audit_order_idx ON crewfit_order_audit (order_id, changed_at);
            CREATE INDEX IF NOT EXISTS crewfit_audit_when_idx ON crewfit_order_audit (changed_at DESC);
            CREATE INDEX IF NOT EXISTS crewfit_audit_who_idx ON crewfit_order_audit (changed_by);
        `);
    } catch (e) { console.error('crewfit audit schema ensure:', e.message); }
}

// Blank-garment inventory (Normless → Inventory menu).
//
// Stock is held per BLANK — a plain garment in one colour and size — not per design. Seventy-odd
// Oversize designs are all printed on the same blank, so "Oversized Tee / Black / L" is a single
// pool that any of them draws from. Shopify's own per-variant counts track finished designs and
// will never agree with these, by design.
async function ensureInventorySchema() {
    try {
        await db.exec(`
            CREATE TABLE IF NOT EXISTS inventory_items (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                blank_type TEXT NOT NULL,
                color TEXT NOT NULL,
                size TEXT NOT NULL,
                qty INTEGER NOT NULL DEFAULT 0,
                reorder_level INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE UNIQUE INDEX IF NOT EXISTS inventory_items_key_idx
                ON inventory_items (blank_type, color, size);

            -- Every change to a count, with what caused it. An order contributes exactly one row
            -- per (order, variant): the sync re-imports the same orders every 30 seconds, so the
            -- unique key below is what stops a sale being deducted twice. Re-processing an edited
            -- order updates the row and moves stock by the difference.
            CREATE TABLE IF NOT EXISTS inventory_movements (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                item_id INTEGER NOT NULL,
                delta INTEGER NOT NULL,
                reason TEXT NOT NULL,           -- 'order' | 'restock' | 'adjustment' | 'opening'
                source_ref TEXT,                -- '<shopify_order_id>:<variant_id>' for orders
                order_number TEXT,
                note TEXT,
                needs_review BOOLEAN DEFAULT false,
                review_reason TEXT,
                created_by TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE UNIQUE INDEX IF NOT EXISTS inventory_movements_source_idx
                ON inventory_movements (source_ref) WHERE source_ref IS NOT NULL;
            CREATE INDEX IF NOT EXISTS inventory_movements_item_idx ON inventory_movements (item_id);

            -- Local cache of what each Shopify product IS, so an order line can be resolved to a
            -- blank without calling Shopify per order. Refreshed on demand from the Products API.
            CREATE TABLE IF NOT EXISTS shopify_products (
                shopify_id BIGINT PRIMARY KEY,
                title TEXT,
                product_type TEXT,
                sku_prefix TEXT,
                blank_type TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Every blank the Shopify catalogue implies, whether or not any has been counted yet.
            -- Without this the grid could only show blanks that already have stock, and a shop
            -- starting from zero would have no cell to type its first count into.
            CREATE TABLE IF NOT EXISTS inventory_catalog (
                blank_type TEXT NOT NULL,
                color TEXT NOT NULL,
                size TEXT NOT NULL,
                PRIMARY KEY (blank_type, color, size)
            );

            -- Order lines we could not resolve to a blank, kept rather than dropped: silently
            -- ignoring a sale is how an inventory drifts away from the shelf.
            CREATE TABLE IF NOT EXISTS inventory_unmapped (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                source_ref TEXT UNIQUE,
                order_number TEXT,
                product_title TEXT,
                product_type TEXT,
                variant TEXT,
                qty INTEGER,
                reason TEXT,
                dismissed BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            ALTER TABLE inventory_unmapped ADD COLUMN IF NOT EXISTS dismissed BOOLEAN DEFAULT false;

            -- Every colour/size a product is sold in. The blank grid only needs the garment, but
            -- an RTO piece is a printed one — it belongs to a design, so putting one on the shelf
            -- by hand means picking a product and one of its variants.
            CREATE TABLE IF NOT EXISTS shopify_variants (
                variant_id BIGINT PRIMARY KEY,
                shopify_product_id BIGINT NOT NULL,
                variant TEXT,
                color TEXT,
                size TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS shopify_variants_product_idx ON shopify_variants (shopify_product_id);

            -- Printed garments that came back — RTO, refused, undelivered. Not blank stock: the
            -- piece carries a design and can only go out again to an order for that same design
            -- and variant, which is what makes matching it to open orders worth doing.
            --
            -- Counts rather than a row per garment: a parcel of three comes back as one line, and
            -- pieces leave it one at a time. available = qty - qty_used - qty_written_off.
            CREATE TABLE IF NOT EXISTS inventory_rto (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                shopify_product_id BIGINT,
                variant_id BIGINT,             -- what an order line is matched on; exact, unlike text
                product_title TEXT NOT NULL,
                variant TEXT,
                color TEXT,
                size TEXT,
                blank_type TEXT,               -- where the blank credit goes when the piece is reused
                qty INTEGER NOT NULL DEFAULT 1,
                qty_used INTEGER NOT NULL DEFAULT 0,
                qty_written_off INTEGER NOT NULL DEFAULT 0,
                source_order_number TEXT,
                -- '<shopify_order_id>:<variant_id>', so scanning the same returned parcel twice
                -- cannot put the same garments on the shelf twice.
                source_ref TEXT,
                reason TEXT,
                note TEXT,
                location TEXT,
                created_by TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE UNIQUE INDEX IF NOT EXISTS inventory_rto_source_idx
                ON inventory_rto (source_ref) WHERE source_ref IS NOT NULL;

            -- What happened to each returned piece, so "where did that one go" has an answer.
            CREATE TABLE IF NOT EXISTS inventory_rto_events (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                rto_id INTEGER NOT NULL,
                kind TEXT NOT NULL,            -- 'in' | 'used' | 'damaged' | 'removed'
                qty INTEGER NOT NULL,
                order_number TEXT,             -- the order it went out to, for 'used'
                note TEXT,
                created_by TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS inventory_rto_events_rto_idx ON inventory_rto_events (rto_id);

            -- Write-offs. A ruined blank and a ruined printed piece cost different things and come
            -- off different shelves, so which one it was is recorded rather than assumed.
            CREATE TABLE IF NOT EXISTS inventory_damaged (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                kind TEXT NOT NULL,            -- 'blank' | 'finished'
                blank_type TEXT, color TEXT, size TEXT,
                shopify_product_id BIGINT, variant_id BIGINT, product_title TEXT, variant TEXT,
                rto_id INTEGER,                -- set when the piece came off the RTO shelf
                qty INTEGER NOT NULL,
                stage TEXT,                    -- printing | stitching | packing | courier | other
                reason TEXT,
                note TEXT,
                movement_id INTEGER,           -- the blank deduction this caused, so it can be undone
                created_by TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS inventory_damaged_created_idx ON inventory_damaged (created_at DESC);

            -- A standing "you already have this one" notice, raised once when an order is first
            -- seen to want something the RTO shelf holds.
            --
            -- Kept as a row rather than recomputed from the order's status, because the prompt has
            -- to outlive the condition that raised it: an order is marked fulfilled at handover,
            -- which is around when it gets printed, so a notice that vanished on fulfilment
            -- disappeared at the moment it still mattered. It goes only when a person says what
            -- they did — sent the returned piece, or printed a fresh one anyway — and that answer
            -- is the history of how often the shelf actually saved a garment.
            CREATE TABLE IF NOT EXISTS inventory_rto_alerts (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                source TEXT NOT NULL,               -- 'shop' | 'seeding'
                order_ref TEXT NOT NULL,            -- '#10634' or 'M005'
                shopify_order_id TEXT,
                marketing_id INTEGER,
                customer TEXT,
                order_date TIMESTAMP,
                shopify_product_id BIGINT,
                variant_id BIGINT,
                product_title TEXT NOT NULL,
                variant TEXT,
                color TEXT,
                size TEXT,
                blank_type TEXT,
                qty INTEGER NOT NULL DEFAULT 1,
                -- One notice per order and garment, whatever else changes about either.
                match_key TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'open',  -- open | used | skipped
                rto_id INTEGER,                       -- the shelf entry it was served from
                resolution_note TEXT,
                resolved_by TEXT,
                resolved_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE UNIQUE INDEX IF NOT EXISTS inventory_rto_alerts_key_idx ON inventory_rto_alerts (match_key);
            CREATE INDEX IF NOT EXISTS inventory_rto_alerts_status_idx ON inventory_rto_alerts (status);

            -- CREATE TABLE IF NOT EXISTS leaves an existing table alone, so anything added to the
            -- definitions above after they first ran has to arrive as its own ALTER.
            ALTER TABLE inventory_rto ADD COLUMN IF NOT EXISTS variant_id BIGINT;
            ALTER TABLE inventory_damaged ADD COLUMN IF NOT EXISTS variant_id BIGINT;
            CREATE INDEX IF NOT EXISTS inventory_rto_variant_idx ON inventory_rto (variant_id);
        `);
        await db.exec(`
            ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_view_inventory BOOLEAN DEFAULT false;
            ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_edit_inventory BOOLEAN DEFAULT false;
        `);
    } catch (e) { console.error('inventory schema ensure:', e.message); }
}

// GST sales invoicing (Normless → Invoices menu)
async function ensureGstSchema() {
    try {
        await db.exec(`
            -- One row per Shopify order that has ever appeared on a GST sales report. The invoice
            -- number is assigned once and never recomputed: regenerating a period must reproduce
            -- the exact numbers already filed, so this table — not the report — is the record.
            CREATE TABLE IF NOT EXISTS gst_invoice_numbers (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                fy TEXT NOT NULL,
                seq INTEGER NOT NULL,
                invoice_no TEXT NOT NULL,
                order_name TEXT NOT NULL,
                order_date DATE,
                assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE UNIQUE INDEX IF NOT EXISTS gst_invoice_order_idx ON gst_invoice_numbers (fy, order_name);
            CREATE UNIQUE INDEX IF NOT EXISTS gst_invoice_seq_idx ON gst_invoice_numbers (fy, seq);

            -- Where each financial year's numbering starts. Needed because FY 26-27 was invoiced
            -- by hand in "GST Sales FY 26-27.xlsx" up to NL/2594 before this module existed, and
            -- those orders are past Shopify's 60-day read window so they can't be back-filled.
            CREATE TABLE IF NOT EXISTS gst_sequences (
                fy TEXT PRIMARY KEY,
                seed INTEGER NOT NULL DEFAULT 0,
                note TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            INSERT INTO gst_sequences (fy, seed, note)
            VALUES ('26-27', 2594, 'Continues the hand-kept workbook, which ended at NL/2594/26-27 on 30 Jun 2026')
            ON CONFLICT (fy) DO NOTHING;

            -- Download history shown under the generator.
            CREATE TABLE IF NOT EXISTS gst_reports (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                period_label TEXT,
                from_date DATE NOT NULL,
                to_date DATE NOT NULL,
                filename TEXT NOT NULL,
                stored_name TEXT NOT NULL,
                row_count INTEGER DEFAULT 0,
                total_qty INTEGER DEFAULT 0,
                taxable_value NUMERIC DEFAULT 0,
                gst_total NUMERIC DEFAULT 0,
                gross_total NUMERIC DEFAULT 0,
                invoice_from TEXT,
                invoice_to TEXT,
                generated_by TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS gst_reports_created_idx ON gst_reports (created_at DESC);
            -- Sales and purchase registers share this history table.
            ALTER TABLE gst_reports ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'sales';

            -- Suppliers exist purely to autofill the purchase form: three vendors account for
            -- 74 of the first 102 bills, so retyping their GSTIN and address every time is the
            -- bulk of the data entry. Purchases snapshot these values rather than joining to
            -- them (see below), so editing a supplier never rewrites a filed return.
            CREATE TABLE IF NOT EXISTS gst_suppliers (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                name TEXT NOT NULL,
                gstin TEXT,
                location TEXT,
                default_particulars TEXT,
                default_gst_pct NUMERIC,
                default_rate NUMERIC,
                intra_state BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE UNIQUE INDEX IF NOT EXISTS gst_suppliers_key_idx
                ON gst_suppliers (LOWER(name), COALESCE(NULLIF(gstin, ''), ''));

            -- One row per supplier bill, entered by hand — there is no upstream system holding
            -- purchases the way Shopify holds sales.
            --
            -- Money is stored as entered, not recomputed on read: 22 of the first 102 bills have
            -- a GST value that isn't taxable x rate (Delhivery rounds to whole rupees), and input
            -- tax credit is claimed on what the vendor actually charged. The figures on the bill
            -- win over the formula.
            CREATE TABLE IF NOT EXISTS gst_purchases (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                purchase_date DATE NOT NULL,
                particulars TEXT,
                company_name TEXT NOT NULL,
                invoice_no TEXT NOT NULL,
                location TEXT,
                gstin TEXT,
                gst_pct NUMERIC NOT NULL DEFAULT 0,
                qty NUMERIC,
                rate NUMERIC,
                taxable NUMERIC NOT NULL DEFAULT 0,
                gst_amount NUMERIC NOT NULL DEFAULT 0,
                gross NUMERIC NOT NULL DEFAULT 0,
                cgst NUMERIC NOT NULL DEFAULT 0,
                sgst NUMERIC NOT NULL DEFAULT 0,
                igst NUMERIC NOT NULL DEFAULT 0,
                supplier_id INTEGER REFERENCES gst_suppliers(id) ON DELETE SET NULL,
                source TEXT DEFAULT 'manual',
                created_by TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            -- The realistic entry error is booking the same bill twice. Unregistered suppliers
            -- have no GSTIN, so fall back to the company name as the identity.
            CREATE UNIQUE INDEX IF NOT EXISTS gst_purchases_bill_idx ON gst_purchases
                (LOWER(COALESCE(NULLIF(gstin, ''), company_name)), LOWER(invoice_no));
            CREATE INDEX IF NOT EXISTS gst_purchases_date_idx ON gst_purchases (purchase_date);
        `);
    } catch (err) {
        console.error('ensureGstSchema error:', err.message);
    }
}

// Influencer marketing (Normless → Marketing menu): the roster of creators we collab with, and
// the seeding orders raised against them. Orders are deliberately not Shopify orders — most go
// out as barter with no transaction — but they carry the Shopify order number when one exists.
async function ensureMarketingSchema() {
    try {
        await db.exec(`
            CREATE TABLE IF NOT EXISTS marketing_influencers (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                name TEXT NOT NULL,
                content_type TEXT,
                platform TEXT DEFAULT 'Instagram',
                profile_url TEXT,
                collab_type TEXT DEFAULT 'Barter',
                location TEXT,
                payment_per_video TEXT,
                total_content INTEGER DEFAULT 0,
                email TEXT,
                contact_number TEXT,
                address TEXT,
                notes TEXT,
                active BOOLEAN DEFAULT true,
                created_by TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS marketing_influencers_name_idx ON marketing_influencers (LOWER(name));

            CREATE TABLE IF NOT EXISTS marketing_orders (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                ref_no INTEGER,
                influencer_id INTEGER REFERENCES marketing_influencers(id) ON DELETE SET NULL,
                -- Snapshot of where this parcel actually went. Kept on the order rather than read
                -- through the influencer, so correcting a creator's current address later never
                -- rewrites the address a past parcel was sent to.
                name TEXT, email TEXT, contact_number TEXT, address TEXT,
                collab_type TEXT,
                -- [{ product, variant, sku, qty, image, shopify_product_id, shopify_variant_id }]
                items TEXT,
                total_qty INTEGER DEFAULT 0,
                order_date DATE NOT NULL,
                status TEXT DEFAULT 'Pending Approval',
                notes TEXT,
                -- Production & dispatch half of the sheet
                fulfilled_date DATE,
                shopify_order_number TEXT,
                shipping_partner TEXT,
                awb TEXT,
                tracking_link TEXT,
                created_by TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            -- Who released this order for dispatch. An order is raised by marketing and only
            -- leaves once someone signs it off, so the approval is recorded on the order rather
            -- than inferred from its status.
            ALTER TABLE marketing_orders ADD COLUMN IF NOT EXISTS approved_by TEXT;
            ALTER TABLE marketing_orders ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP;
            -- The sheet's original vocabulary predates the approval step; these are the same two
            -- stages named for what they are now waiting on.
            UPDATE marketing_orders SET status = 'Pending Approval' WHERE status = 'Requested';
            UPDATE marketing_orders SET status = 'Dispatch Pending' WHERE status = 'Packed';
            CREATE UNIQUE INDEX IF NOT EXISTS marketing_orders_ref_idx ON marketing_orders (ref_no);
            CREATE INDEX IF NOT EXISTS marketing_orders_date_idx ON marketing_orders (order_date DESC);
            CREATE INDEX IF NOT EXISTS marketing_orders_influencer_idx ON marketing_orders (influencer_id);
        `);
    } catch (err) {
        console.error('ensureMarketingSchema error:', err.message);
    }
}

// Start Server
app.listen(PORT, async () => {
    console.log(`🚀 Normless CRM Backend running on http://localhost:${PORT}`);

    // Ensure admin user exists
    await ensureAdminUser();
    // Ensure Crewfit catalog schema + seed
    await ensureCrewfitSchema();
    // Ensure GST sales invoicing schema
    await ensureGstSchema();
    await ensureInventorySchema();
    await ensureOrderAuditSchema();
    // Ensure influencer marketing schema
    await ensureMarketingSchema();

    // START AUTO-SYNC IMMEDIATELY (no user action needed!)
    startAutoSync();
});
