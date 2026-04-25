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
 * Fetch all orders using REST API (status=any gets ALL orders including closed/archived)
 * GraphQL is limited to ~60 days by read_orders scope, but REST returns everything.
 */
async function fetchAllOrders() {
    const allOrders = [];
    let url = `${REST_BASE}/orders.json?status=any&limit=250&fields=id,name,created_at,total_price,currency,financial_status,fulfillment_status,customer,line_items`;

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
 * Test the API connection
 */
async function testConnection() {
    const query = `{ shop { name email myshopifyDomain } }`;
    return await shopifyGraphQL(query);
}

module.exports = {
    fetchAllCustomers,
    fetchAllOrders,
    testConnection,
    shopifyGraphQL,
};
