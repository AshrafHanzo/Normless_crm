/**
 * Normless's own automatic-message templates, one for each event the CRM sends on.
 *
 * Written to replace the old provider's set: same events, the same kind of photo header, but every
 * link button points at our /go/ short links. Each says how its gaps are filled (`vars`), where
 * its photo comes from and where its button goes, so picking one for an event needs no setup.
 *
 * Sources a gap can be filled from are listed in SOURCES; nl-automations fills them.
 */

const { BUTTON_BASE } = require('./nl-links');

/** What a gap in a template can be filled with, and an example for Meta's reviewers. */
const SOURCES = {
    first_name: { label: 'Customer’s first name', example: 'Meera' },
    order_number: { label: 'Order number', example: '#94182' },
    order_total: { label: 'Order total (₹)', example: '1,398' },
    cod_amount: { label: 'Amount due on delivery (₹)', example: '1,199' },
    items: { label: 'Items ordered', example: 'AMG Petronas Tee (M) × 1, Ninja Hoodie (L) × 1' },
    product_name: { label: 'First product’s name', example: 'AMG Petronas Tee' },
    cart_total: { label: 'Cart total (₹)', example: '1,398' },
    coupon: { label: 'Coupon code', example: 'COMEBACK10' },
    courier: { label: 'Courier', example: 'Delhivery' },
    tracking_number: { label: 'Tracking number', example: '14901234563321' },
    refund_amount: { label: 'Refund amount (₹)', example: '699' },
    order_total_inr: { label: 'Order total, with ₹', example: '₹1,398' },
    cod_amount_inr: { label: 'Amount due on delivery, with ₹', example: '₹1,199' },
    cart_total_inr: { label: 'Cart total, with ₹', example: '₹1,398' },
    refund_amount_inr: { label: 'Refund amount, with ₹', example: '₹699' },
    refund_note: { label: 'Refund note', example: 'Refund' },
    address: { label: 'Delivery address', example: '12 MG Road, Bengaluru, Karnataka, 560001' },
    store_name: { label: 'Store name (Normless)', example: 'Normless' },
    currency: { label: 'Currency (INR)', example: 'INR' },
};

/** Where a link button can go. Each becomes an /go/ code when the message is sent. */
const LINKS = {
    checkout: 'Their checkout (the abandoned cart)',
    order: 'Their order status page',
    tracking: 'The courier’s tracking page',
    store: 'The Normless store',
};

const EXAMPLE_CODE = 'k3Jx9aQ';

const SET = [
    {
        event: 'cart_1', name: 'nlcrm_cart_reminder_1', category: 'MARKETING', image: true,
        body: 'Hi {{1}}, you left {{2}} in your cart 🛒\n\nYour size is still available — finish your order before it sells out.',
        vars: ['first_name', 'product_name'], link: { text: 'Complete my order', source: 'checkout' },
    },
    {
        event: 'cart_2', name: 'nlcrm_cart_reminder_2', category: 'MARKETING', image: true,
        body: 'Hi {{1}}, still thinking about {{2}}?\n\nYour cart is saved — checking out takes less than a minute.',
        vars: ['first_name', 'product_name'], link: { text: 'Finish checkout', source: 'checkout' },
    },
    {
        event: 'cart_3', name: 'nlcrm_cart_reminder_3', category: 'MARKETING', image: true,
        body: 'Hi {{1}}, your cart with {{2}} is about to expire.\n\nUse code {{3}} at checkout for an extra discount on your order.',
        vars: ['first_name', 'product_name', 'coupon'], link: { text: 'Use my discount', source: 'checkout' },
    },
    {
        event: 'order_prepaid', name: 'nlcrm_order_prepaid', category: 'UTILITY', image: true,
        body: 'Hi {{1}}, thank you for shopping with Normless! 🎉\n\nYour order {{2}} of ₹{{3}} is paid and confirmed. We’ll message you here when it ships.\n\nItems: {{4}}',
        vars: ['first_name', 'order_number', 'order_total', 'items'], link: { text: 'View my order', source: 'order' },
    },
    {
        event: 'order_partial_cod', name: 'nlcrm_order_partial_cod', category: 'UTILITY', image: true,
        body: 'Hi {{1}}, thank you for shopping with Normless! 🎉\n\nYour order {{2}} is confirmed. We have your advance; ₹{{3}} is to be paid in cash on delivery.\n\nItems: {{4}}',
        vars: ['first_name', 'order_number', 'cod_amount', 'items'], link: { text: 'View my order', source: 'order' },
    },
    {
        event: 'order_cod', name: 'nlcrm_order_cod', category: 'UTILITY', image: true,
        body: 'Hi {{1}}, thank you for shopping with Normless! 🎉\n\nYour cash-on-delivery order {{2}} of ₹{{3}} is placed. We’ll message you here when it ships.\n\nItems: {{4}}',
        vars: ['first_name', 'order_number', 'order_total', 'items'], link: { text: 'View my order', source: 'order' },
    },
    {
        event: 'cod_confirm', name: 'nlcrm_cod_confirm', category: 'UTILITY', image: true,
        body: 'Hi {{1}}, please confirm your cash-on-delivery order {{2}} of ₹{{3}}.\n\nItems: {{4}}\n\nTap Confirm so we can ship it, or Cancel if you no longer want it.',
        vars: ['first_name', 'order_number', 'order_total', 'items'], replies: ['Confirm order', 'Cancel order'],
    },
    {
        event: 'order_cancelled', name: 'nlcrm_order_cancelled', category: 'UTILITY', image: false,
        body: 'Hi {{1}}, your Normless order {{2}} has been cancelled.\n\nIf you have any questions about it, just reply to this message.',
        vars: ['first_name', 'order_number'], link: { text: 'Shop again', source: 'store' },
    },
    {
        event: 'fulfilled', name: 'nlcrm_order_shipped', category: 'UTILITY', image: true,
        body: 'Hi {{1}}, your order {{2}} is on its way! 🚚\n\nCourier: {{3}}\nTracking number: {{4}}',
        vars: ['first_name', 'order_number', 'courier', 'tracking_number'], link: { text: 'Track my order', source: 'tracking' },
    },
    {
        event: 'refund', name: 'nlcrm_refund_issued', category: 'UTILITY', image: false,
        body: 'Hi {{1}}, we’ve issued a refund of ₹{{2}} for your order {{3}}.\n\nBanks usually take 5–7 business days to show it in your account.',
        vars: ['first_name', 'refund_amount', 'order_number'], link: { text: 'View my order', source: 'order' },
    },
];

const FOOTER = 'Normless';

/** Meta's parts for one of them. `imageHandle` is the uploaded sample photo for a photo header. */
function components(t, imageHandle = null) {
    const out = [];
    if (t.image) out.push({ type: 'HEADER', format: 'IMAGE', example: { header_handle: [imageHandle] } });
    out.push({ type: 'BODY', text: t.body, example: { body_text: [t.vars.map(v => SOURCES[v].example)] } });
    out.push({ type: 'FOOTER', text: FOOTER });
    if (t.link) {
        out.push({ type: 'BUTTONS', buttons: [{ type: 'URL', text: t.link.text, url: `${BUTTON_BASE()}{{1}}`, example: [`${BUTTON_BASE()}${EXAMPLE_CODE}`] }] });
    } else if (t.replies) {
        out.push({ type: 'BUTTONS', buttons: t.replies.map(text => ({ type: 'QUICK_REPLY', text })) });
    }
    return out;
}

const byEvent = (event) => SET.find(t => t.event === event) || null;
const byName = (name) => SET.find(t => t.name === name) || null;

module.exports = { SET, SOURCES, LINKS, components, byEvent, byName };
