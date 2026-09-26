const express = require('express');
const db = require('../db/connection');
const { tableParams, pagination } = require('../utils/table');
const inv = require('../services/inventory');
const PDFDocument = require('pdfkit');
const pickList = require('../services/pick-list');
const renderPickListPdf = require('../services/pick-list-pdf');
const { toCsv } = require('../utils/csv');

const router = express.Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Client column key → SQL expression. Only these can be sorted on.
const ORDER_SORTS = {
  order_number: 'o.order_number',
  customer: "COALESCE(c.first_name || ' ' || c.last_name, c.email)",
  total_price: 'o.total_price',
  financial_status: 'o.financial_status',
  fulfillment_status: 'o.fulfillment_status',
  created_at: 'o.created_at',
};

// GET /api/orders - List with filters and pagination
router.get('/', async (req, res) => {
    try {
        const { search = '', financial_status = '', fulfillment_status = '' } = req.query;
        const t = tableParams(req.query, { sortable: ORDER_SORTS, defaultSort: 'created_at', tiebreak: 'o.id' });

        let conditions = [];
        let params = [];
        let paramCount = 1;

        if (search) {
            conditions.push(`(order_number ILIKE $${paramCount} OR customer_shopify_id ILIKE $${paramCount + 1})`);
            const s = `%${search}%`;
            params.push(s, s);
            paramCount += 2;
        }

        if (financial_status) {
            conditions.push(`financial_status = $${paramCount}`);
            params.push(financial_status);
            paramCount += 1;
        }

        // The same window the pick list uses, so what is exported is what is on screen.
        if (DATE_RE.test(req.query.from || '')) {
            conditions.push(`o.created_at::date >= $${paramCount}`);
            params.push(req.query.from);
            paramCount += 1;
        }
        if (DATE_RE.test(req.query.to || '')) {
            conditions.push(`o.created_at::date <= $${paramCount}`);
            params.push(req.query.to);
            paramCount += 1;
        }

        if (fulfillment_status === 'ON_HOLD') {
            // Shopify reports a held order as simply unfulfilled, so "on hold" is a flag of its
            // own rather than a fulfillment status — asked for by the same dropdown all the same.
            conditions.push('COALESCE(o.on_hold, false) = true');
            // No parameter to bind, so the counter stays where it is.
        } else if (fulfillment_status) {
            conditions.push(`fulfillment_status = $${paramCount}`);
            params.push(fulfillment_status);
            paramCount += 1;
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        // The count has to see the same joined shape as the page query, since a sort (and one day
        // a filter) can reference the customer table.
        const countResult = await db.query(`
            SELECT COUNT(*) as total
            FROM orders o
            LEFT JOIN customers c ON o.customer_shopify_id = c.shopify_id
            ${whereClause}
        `, params);
        const total = parseInt(countResult.rows[0]?.total) || 0;

        const ordersResult = await db.query(`
            SELECT o.*, c.first_name, c.last_name, c.email as customer_email
            FROM orders o
            LEFT JOIN customers c ON o.customer_shopify_id = c.shopify_id
            ${whereClause}
            ${t.orderBy}
            LIMIT $${paramCount} OFFSET $${paramCount + 1}
        `, [...params, t.limit, t.offset]);

        // Which of these could be filled from the RTO shelf. Computed over the page's rows only —
        // one extra query, and it stops a packer printing a garment that is already in the building.
        let rto = {};
        try {
            const shelf = await inv.rtoAvailable();
            if (shelf.length) {
                const index = inv.availabilityIndex(shelf);
                // Same rule as the matcher: a shipped order is past the point where a shelf piece
                // could be part of it, so flagging one only teaches the packer to ignore the flag.
                for (const o of ordersResult.rows) {
                    if (['FULFILLED', 'RESTOCKED'].includes(String(o.fulfillment_status || '').toUpperCase())) continue;
                    if (o.cancelled_at || o.on_hold) continue;
                    const lines = inv.matchesForOrder(o, index);
                    if (lines.length) rto[o.order_number] = lines;
                }
            }
        } catch (rtoErr) {
            console.error('orders RTO check failed:', rtoErr.message);
        }

        res.json({
            orders: ordersResult.rows,
            rto,
            pagination: pagination(total, t),
        });
    } catch (err) {
        console.error('Error fetching orders:', err);
        res.status(500).json({ error: 'Failed to fetch orders' });
    }
});

// GET /api/orders/stats
/* ==========================================================================================
 * The production pick list — what is ordered and not yet sent, grouped for the print floor
 * ========================================================================================== */

const range = (q) => ({
    from: DATE_RE.test(q.from || '') ? q.from : null,
    to: DATE_RE.test(q.to || '') ? q.to : null,
});

/** A filename that says what it holds and when it was taken. */
const fileName = (ext, period) => {
    const span = period.from && period.to
        ? (period.from === period.to ? period.from : `${period.from} to ${period.to}`)
        : 'all open orders';
    return `Pick list — ${span}.${ext}`;
};

/**
 * Content-Disposition for a name that may contain non-Latin-1 characters (an em dash here), which
 * Node rejects in a header value — so the plain form is ASCII and the real name rides in the RFC
 * 5987 parameter browsers prefer.
 */
function contentDisposition(name) {
    const ascii = name.replace(/[^\x20-\x7E]/g, '-').replace(/["\\]/g, '');
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// GET /api/orders/pick-list?from=&to= — the grouped rows, for the screen and the PNG.
router.get('/pick-list', async (req, res) => {
    try {
        res.json(await pickList.build(range(req.query)));
    } catch (err) {
        console.error('pick list error:', err);
        res.status(500).json({ error: 'Failed to build the pick list' });
    }
});

// GET /api/orders/pick-list.csv?from=&to=
router.get('/pick-list.csv', async (req, res) => {
    try {
        const { rows, period } = await pickList.build(range(req.query));
        const csv = toCsv(
            rows.map(r => ({ type: r.type, edition: r.edition, color: r.color, size: r.size, qty: r.qty, orders: r.orders.join(' ') })),
            [{ key: 'type', label: 'Product type' }, { key: 'edition', label: 'Edition' },
             { key: 'color', label: 'Colour' }, { key: 'size', label: 'Size' },
             { key: 'qty', label: 'Qty' }, { key: 'orders', label: 'Orders' }]);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', contentDisposition(fileName('csv', period)));
        res.send(csv);
    } catch (err) {
        console.error('pick list csv error:', err);
        res.status(500).json({ error: 'Failed to export the pick list' });
    }
});

/**
 * GET /api/orders/pick-list.pdf?from=&to=
 *
 * The drawing lives in services/pick-list-pdf.js so it can be rendered from made-up rows in a
 * test — page breaks are the part of a printed document that only shows up on the second page.
 */
router.get('/pick-list.pdf', async (req, res) => {
    try {
        const { rows, summary, period } = await pickList.build(range(req.query));
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', contentDisposition(fileName('pdf', period)));
        renderPickListPdf({ rows, summary, period }).pipe(res);
    } catch (err) {
        console.error('pick list pdf error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to export the pick list' });
    }
});

router.get('/stats', async (req, res) => {
    try {
        const totalOrdersResult = await db.query('SELECT COUNT(*) as count FROM orders');
        const totalOrders = parseInt(totalOrdersResult.rows[0]?.count) || 0;

        const totalRevenueResult = await db.query('SELECT SUM(total_price) as sum FROM orders');
        const totalRevenue = parseFloat(totalRevenueResult.rows[0]?.sum) || 0;

        const avgOrderValueResult = await db.query('SELECT AVG(total_price) as avg FROM orders');
        const avgOrderValue = parseFloat(avgOrderValueResult.rows[0]?.avg) || 0;

        const financialBreakdownResult = await db.query(
            'SELECT financial_status, COUNT(*) as count FROM orders GROUP BY financial_status'
        );
        const financialBreakdown = financialBreakdownResult.rows;

        const fulfillmentBreakdownResult = await db.query(
            'SELECT fulfillment_status, COUNT(*) as count FROM orders GROUP BY fulfillment_status'
        );
        const fulfillmentBreakdown = fulfillmentBreakdownResult.rows;

        // Revenue by month (last 6 months)
        const revenueByMonthResult = await db.query(`
            SELECT
                TO_CHAR(created_at, 'YYYY-MM') as month,
                SUM(total_price) as revenue,
                COUNT(*) as order_count
            FROM orders
            WHERE created_at >= NOW() - INTERVAL '6 months'
            GROUP BY TO_CHAR(created_at, 'YYYY-MM')
            ORDER BY month ASC
        `);
        const revenueByMonth = revenueByMonthResult.rows;

        res.json({ totalOrders, totalRevenue, avgOrderValue, financialBreakdown, fulfillmentBreakdown, revenueByMonth });
    } catch (err) {
        console.error('Error fetching order stats:', err);
        res.status(500).json({ error: 'Failed to fetch order stats' });
    }
});

// GET /api/orders/lookup/:orderName - Find order by barcode value
router.get('/lookup/:orderName', async (req, res) => {
    try {
        let name = req.params.orderName;
        console.log(`[Order Lookup Hit] Searching for: "${name}"`);

        // Search for exact match first
        let orderResult = await db.query(`
            SELECT o.*, c.first_name, c.last_name, c.email as customer_email
            FROM orders o
            LEFT JOIN customers c ON o.customer_shopify_id = c.shopify_id
            WHERE o.order_number = $1
        `, [name]);
        let order = orderResult.rows?.[0];

        // If not found, try adding a '#' if it's missing, or vice versa
        if (!order) {
            const altName = name.startsWith('#') ? name.substring(1) : `#${name}`;
            orderResult = await db.query(`
                SELECT o.*, c.first_name, c.last_name, c.email as customer_email
                FROM orders o
                LEFT JOIN customers c ON o.customer_shopify_id = c.shopify_id
                WHERE o.order_number = $1
            `, [altName]);
            order = orderResult.rows?.[0];
        }

        if (!order) return res.status(404).json({ error: 'Order not found' });

        // Dynamically fetch product images for the line items
        try {
            let lineItems = JSON.parse(order.line_items_json || '[]');
            const token = process.env.SHOPIFY_ACCESS_TOKEN;
            const domain = process.env.SHOPIFY_STORE_DOMAIN;

            if (token && domain) {
                let updated = false;
                for (let li of lineItems) {
                    if (!li.image && li.title) {
                        const url = `https://${domain}/admin/api/2026-04/products.json?title=${encodeURIComponent(li.title)}`;
                        const pRes = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
                        if (pRes.ok) {
                            const pData = await pRes.json();
                            if (pData.products && pData.products.length > 0 && pData.products[0].image) {
                                li.image = pData.products[0].image.src;
                                updated = true;
                            }
                        }
                    }
                }

                if (updated) {
                    order.line_items_json = JSON.stringify(lineItems);
                    // Optionally update the DB so we don't have to fetch it again next time
                    await db.query('UPDATE orders SET line_items_json = $1 WHERE id = $2', [order.line_items_json, order.id]);
                }
            }
        } catch (imgErr) {
            console.error('Failed to fetch images dynamically:', imgErr.message);
        }

        res.json(order);
    } catch (err) {
        console.error('Error looking up order:', err);
        res.status(500).json({ error: 'Failed to look up order' });
    }
});

// GET /api/orders/:id
router.get('/:id', async (req, res) => {
    try {
        const orderResult = await db.query(`
            SELECT o.*, c.first_name, c.last_name, c.email as customer_email
            FROM orders o
            LEFT JOIN customers c ON o.customer_shopify_id = c.shopify_id
            WHERE o.id = $1
        `, [req.params.id]);
        const order = orderResult.rows?.[0];

        if (!order) return res.status(404).json({ error: 'Order not found' });

        res.json(order);
    } catch (err) {
        console.error('Error fetching order:', err);
        res.status(500).json({ error: 'Failed to fetch order' });
    }
});

module.exports = router;
