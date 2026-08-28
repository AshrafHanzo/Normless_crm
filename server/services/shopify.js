const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = '2026-04';
const GRAPHQL_URL = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;
const REST_BASE = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}`;

async function shopifyGraphQL(query, variables = {}) {
    const response = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
        },
        body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Shopify API error ${response.status}: ${text}`);
    }

    const json = await response.json();

    if (json.errors) {
        throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
    }

    return json.data;
}

// Sleep utility for rate limiting
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch all customers with cursor-based pagination
 */
async function fetchAllCustomers() {
    const allCustomers = [];
    let hasNextPage = true;
    let cursor = null;

    while (hasNextPage) {
        const query = `
            query ($first: Int!, $after: String) {
                customers(first: $first, after: $after) {
                    pageInfo {
                        hasNextPage
                        endCursor
                    }
                    nodes {
                        id
                        email
                        firstName
                        lastName
                        phone
                        numberOfOrders
                        tags
                        createdAt
                        updatedAt
                        amountSpent {
                            amount
                            currencyCode
                        }
                    }
                }
            }
        `;

        const variables = { first: 100, after: cursor };
        const data = await shopifyGraphQL(query, variables);

        const customers = data.customers.nodes.map(c => ({
            shopify_id: c.id,
            email: c.email || '',
            first_name: c.firstName || '',
            last_name: c.lastName || '',
            phone: c.phone || '',
            orders_count: parseInt(c.numberOfOrders) || 0,
            total_spent: c.amountSpent ? parseFloat(c.amountSpent.amount) : 0,
            tags: Array.isArray(c.tags) ? c.tags.join(', ') : (c.tags || ''),
            created_at: c.createdAt,
            updated_at: c.updatedAt,
        }));

        allCustomers.push(...customers);
        hasNextPage = data.customers.pageInfo.hasNextPage;
        cursor = data.customers.pageInfo.endCursor;

        console.log(`  Fetched ${allCustomers.length} customers so far...`);

        // Small delay to respect rate limits
        if (hasNextPage) await sleep(500);
    }

    return allCustomers;
}

/**
 * Order names Shopify currently has on hold.
 *
 * REST reports an on-hold order as simply unfulfilled, so it cannot be told apart there. One
 * GraphQL query with the store's own filter answers it for the whole shop at once, which is far
 * cheaper than asking per order — and on-hold orders are recent by nature, so the 60-day limit on
 * that scope never bites.
 */
async function fetchOnHoldOrderNames() {
    const names = [];
    let after = null;
    for (let page = 0; page < 10; page++) {
        const query = `{ orders(first: 250${after ? `, after: "${after}"` : ''}, query: "fulfillment_status:on_hold") {
            edges { cursor node { name } } pageInfo { hasNextPage } } }`;
        const res = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/api/2026-04/graphql.json`, {
            method: 'POST',
            headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify({ query }),
        });
        if (!res.ok) throw new Error(`Shopify on-hold query failed (${res.status})`);
        const json = await res.json();
        if (json.errors) throw new Error(`Shopify on-hold query: ${JSON.stringify(json.errors)}`);
        const edges = json.data?.orders?.edges || [];
        names.push(...edges.map(e => e.node.name));
        if (!json.data?.orders?.pageInfo?.hasNextPage || !edges.length) break;
        after = edges[edges.length - 1].cursor;
    }
    return names;
}

/**
 * Fetch all orders using REST API (status=any gets ALL orders including closed/archived)
 * GraphQL is limited to ~60 days by read_orders scope, but REST returns everything.
 */
async function fetchAllOrders() {
    const allOrders = [];
    let url = `${REST_BASE}/orders.json?status=any&limit=250&fields=id,name,created_at,total_price,currency,financial_status,fulfillment_status,cancelled_at,customer,line_items`;

    while (url) {
        const response = await fetch(url, {
            headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN }
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Shopify REST API error ${response.status}: ${text}`);
        }

        const data = await response.json();

        const orders = (data.orders || []).map(o => ({
            shopify_id: `gid://shopify/Order/${o.id}`,
            order_number: o.name,
            customer_shopify_id: o.customer ? `gid://shopify/Customer/${o.customer.id}` : null,
            total_price: parseFloat(o.total_price) || 0,
            currency: o.currency || 'INR',
            financial_status: (o.financial_status || 'unknown').toUpperCase(),
            fulfillment_status: (o.fulfillment_status || 'unfulfilled').toUpperCase(),
            // A cancelled order is never shipping, so nothing should be reserved or offered for it.
            cancelled_at: o.cancelled_at || null,
            line_items_json: JSON.stringify((o.line_items || []).map(li => ({
                title: li.title,
                quantity: li.quantity,
                price: li.price || '0',
                variant: li.variant_title || '',
                shopify_variant_id: li.variant_id,
                shopify_product_id: li.product_id,
                options: (li.properties || []).map(p => ({ name: p.name, value: p.value })),
                image: null,
                all_images: []
            }))),
            created_at: o.created_at,
        }));

        allOrders.push(...orders);

        // Parse Link header for next page
        url = null;
        const linkHeader = response.headers.get('Link');
        if (linkHeader) {
            const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
            if (nextMatch) {
                url = nextMatch[1];
            }
        }

        console.log(`  Fetched ${allOrders.length} orders so far...`);

        // Small delay to respect rate limits
        if (url) await sleep(300);
    }

    return allOrders;
}

/**
 * Number of orders created in a window, from Shopify's own count endpoint.
 *
 * Deliberately separate from fetchOrdersInRange: counting is not subject to the 60-day order-data
 * restriction that listing is, so comparing the two reveals when a range is only partially
 * readable instead of letting it look empty.
 */
async function countOrders(createdAtMin, createdAtMax) {
    const url = `${REST_BASE}/orders/count.json?status=any`
        + `&created_at_min=${encodeURIComponent(createdAtMin)}`
        + `&created_at_max=${encodeURIComponent(createdAtMax)}`;
    const response = await fetch(url, { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } });
    if (!response.ok) {
        throw new Error(`Shopify REST API error ${response.status}: ${await response.text()}`);
    }
    return parseInt((await response.json()).count, 10) || 0;
}

/**
 * Full order payloads created in a window, following Link-header pagination.
 * Unlike fetchAllOrders this keeps the raw order (addresses, fulfillments, money fields), which
 * the GST register needs and the trimmed sync shape does not carry.
 */
async function fetchOrdersInRange(createdAtMin, createdAtMax) {
    const all = [];
    let url = `${REST_BASE}/orders.json?status=any&limit=250`
        + `&created_at_min=${encodeURIComponent(createdAtMin)}`
        + `&created_at_max=${encodeURIComponent(createdAtMax)}`;

    while (url) {
        const response = await fetch(url, { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } });
        if (!response.ok) {
            throw new Error(`Shopify REST API error ${response.status}: ${await response.text()}`);
        }

        const data = await response.json();
        all.push(...(data.orders || []));

        url = null;
        const linkHeader = response.headers.get('Link');
        if (linkHeader) {
            const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
            if (nextMatch) url = nextMatch[1];
        }
        if (url) await sleep(300);
    }

    return all;
}

/**
 * The active product catalogue, trimmed to what a picker needs: title, image and the sellable
 * variants. Uses REST rather than GraphQL because products carry no read-window restriction and
 * the Link-header pagination is already the pattern here.
 *
 * Results are cached in memory — the catalogue changes rarely, and this is called on every open
 * of the influencer-order form, which shouldn't mean a multi-page Shopify crawl each time.
 */
const PRODUCT_CACHE_MS = 5 * 60 * 1000;
let productCache = { at: 0, products: null };

async function fetchProducts({ force = false } = {}) {
    if (!force && productCache.products && Date.now() - productCache.at < PRODUCT_CACHE_MS) {
        return productCache.products;
    }
    if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ACCESS_TOKEN) {
        throw new Error('Shopify is not configured on the server');
    }

    const all = [];
    let url = `${REST_BASE}/products.json?status=active&limit=250`
        + `&fields=id,title,handle,status,image,images,variants,product_type`;

    while (url) {
        const response = await fetch(url, { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } });
        if (!response.ok) {
            throw new Error(`Shopify REST API error ${response.status}: ${await response.text()}`);
        }
        const data = await response.json();

        for (const p of data.products || []) {
            // A variant image beats the product's hero shot — the colour actually being sent is
            // what the packer and the influencer both need to see.
            const byId = new Map((p.images || []).map(img => [img.id, img.src]));
            all.push({
                id: p.id,
                title: p.title,
                product_type: p.product_type || '',
                image: p.image?.src || null,
                variants: (p.variants || []).map(v => ({
                    id: v.id,
                    title: v.title === 'Default Title' ? '' : v.title,
                    sku: v.sku || '',
                    price: v.price || null,
                    available: typeof v.inventory_quantity === 'number' ? v.inventory_quantity : null,
                    image: (v.image_id && byId.get(v.image_id)) || p.image?.src || null,
                })),
            });
        }

        url = null;
        const linkHeader = response.headers.get('Link');
        const nextMatch = linkHeader && linkHeader.match(/<([^>]+)>;\s*rel="next"/);
        if (nextMatch) url = nextMatch[1];
        if (url) await sleep(300);
    }

    all.sort((a, b) => a.title.localeCompare(b.title));
    productCache = { at: Date.now(), products: all };
    return all;
}

/**
 * Test the API connection
 */
async function testConnection() {
    const query = `{ shop { name email myshopifyDomain } }`;
    return await shopifyGraphQL(query);
}

module.exports = {
    fetchAllCustomers,
    fetchAllOrders,
    fetchOnHoldOrderNames,
    fetchProducts,
    countOrders,
    fetchOrdersInRange,
    testConnection,
    shopifyGraphQL,
};
