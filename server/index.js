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
                .then(() => {
                    isSyncing = false;
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
                can_view_marketing=true, can_dispatch_marketing=true
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
                status TEXT DEFAULT 'Requested',
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
    // Ensure influencer marketing schema
    await ensureMarketingSchema();

    // START AUTO-SYNC IMMEDIATELY (no user action needed!)
    startAutoSync();
});
