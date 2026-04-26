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
app.use(express.json());
 
// LOUD LOGGER
app.use((req, res, next) => {
    const log = `🚀 [HIT] ${req.method} ${req.url} (Path: ${req.path}) at ${new Date().toISOString()}\n`;
    try {
        fs.appendFileSync('C:\\Users\\abcom\\Desktop\\Personal\\normless_crm\\debug.log', log);
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

// Public routes
app.use('/api/auth', authRoutes);

// Admin routes (require auth)
app.use('/api/admin', authMiddleware, adminRoutes);

// Protected routes
app.use('/api/customers', authMiddleware, customerRoutes);
app.use('/api/orders', authMiddleware, orderRoutes);
app.use('/api/interactions', authMiddleware, interactionRoutes);
app.use('/api/dashboard', authMiddleware, dashboardRoutes);
app.use('/api/sync', authMiddleware, syncRoutes);

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'Normless CRM Backend is running!' });
});

// JSON 404 for missing API routes
app.use('/api', (req, res) => {
    console.log(`🚨 [API 404] No route matched for ${req.url}`);
    res.status(404).json({ error: `API route not found: ${req.url}` });
});

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
        const result = await db.query('SELECT * FROM admin_users WHERE username = $1', ['normlessfashion@gmail.com']);
        if (result.rows.length === 0) {
            console.log('🔄 Admin user missing - reinitializing...');
            const bcrypt = require('bcryptjs');
            const salt = bcrypt.genSaltSync(10);
            const hash = bcrypt.hashSync('hsSeMEiG8MBhSzC', salt);
            await db.query('INSERT INTO admin_users (username, password_hash) VALUES ($1, $2)', ['normlessfashion@gmail.com', hash]);
            console.log('✅ Admin user restored');
        }
    } catch (error) {
        console.error('Error ensuring admin user:', error);
    }
}

// Start Server
app.listen(PORT, async () => {
    console.log(`🚀 Normless CRM Backend running on http://localhost:${PORT}`);

    // Ensure admin user exists
    await ensureAdminUser();

    // START AUTO-SYNC IMMEDIATELY (no user action needed!)
    startAutoSync();
});
