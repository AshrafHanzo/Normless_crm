const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = '2026-04';
const GRAPHQL_URL = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;

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
 * Fetch all orders with cursor-based pagination
 */
async function fetchAllOrders() {
    const allOrders = [];
    let hasNextPage = true;
    let cursor = null;

    while (hasNextPage) {
        const query = `
            query ($first: Int!, $after: String) {
                orders(first: $first, after: $after) {
                    pageInfo {
                        hasNextPage
                        endCursor
                    }
                    nodes {
                        id
                        name
                        createdAt
                        totalPriceSet {
                            shopMoney {
                                amount
                                currencyCode
                            }
                        }
                        displayFinancialStatus
                        displayFulfillmentStatus
                        customer {
                            id
                        }
                        lineItems(first: 50) {
                            nodes {
                                title
                                quantity
                                originalUnitPriceSet {
                                    shopMoney {
                                        amount
                                    }
                                }
                                variant {
                                    title
                                }
                            }
                        }
                    }
                }
            }
        `;

        const variables = { first: 100, after: cursor };
        const data = await shopifyGraphQL(query, variables);

        const orders = data.orders.nodes.map(o => ({
            shopify_id: o.id,
            order_number: o.name,
            customer_shopify_id: o.customer ? o.customer.id : null,
            total_price: o.totalPriceSet ? parseFloat(o.totalPriceSet.shopMoney.amount) : 0,
            currency: o.totalPriceSet ? o.totalPriceSet.shopMoney.currencyCode : 'INR',
            financial_status: o.displayFinancialStatus || 'UNKNOWN',
            fulfillment_status: o.displayFulfillmentStatus || 'UNFULFILLED',
            line_items_json: JSON.stringify(o.lineItems.nodes.map(li => ({
                title: li.title,
                quantity: li.quantity,
                price: li.originalUnitPriceSet ? li.originalUnitPriceSet.shopMoney.amount : '0',
                variant: li.variant ? li.variant.title : '',
            }))),
            created_at: o.createdAt,
        }));

        allOrders.push(...orders);
        hasNextPage = data.orders.pageInfo.hasNextPage;
        cursor = data.orders.pageInfo.endCursor;

        console.log(`  Fetched ${allOrders.length} orders so far...`);

        if (hasNextPage) await sleep(500);
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
