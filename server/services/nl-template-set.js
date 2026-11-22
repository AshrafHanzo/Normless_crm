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
    // Dispatch delay notice: the delayed items and the day they go out (from the event's settings).
    delayed_items: { label: 'Delayed items', example: 'Dr Doom Hoodie (L)' },
    dispatch_date: { label: 'Dispatch date', example: '27 November' },
    // Support tickets: the reference and what it is about ("address update on order #13533").
    ticket_ref: { label: 'Support ticket number', example: 'CS-0068' },
    ticket_subject: { label: 'What the ticket is about', example: 'size change on order #13091' },
    store_name: { label: 'Store name (Normless)', example: 'Normless' },
    currency: { label: 'Currency (INR)', example: 'INR' },
    // Vendors (Purchasing): filled by services/vendor-wa.
    vendor_name: { label: 'Vendor’s contact name', example: 'Ravi' },
    company: { label: 'Our company (Normless)', example: 'Normless' },
    vendor_order_ref: { label: 'Vendor order number', example: 'VO-005' },
    vendor_brand: { label: 'Brand the order is for', example: 'Normless' },
    vendor_items: { label: 'What was ordered', example: 'Mask × 300, Disk set × 300' },
    vendor_order_value: { label: 'Order value, incl. GST', example: '₹1,77,000 incl. GST' },
    vendor_delivery_by: { label: 'Expected delivery', example: '30 Nov 2026' },
    vendor_change: { label: 'What changed on the order', example: 'delivery date is now 05 Dec 2026' },
    vendor_pay_amount: { label: 'Payment amount, with ₹', example: '₹35,400' },
    vendor_paid_on: { label: 'Payment date', example: '15 Nov 2026' },
    vendor_pay_mode: { label: 'Payment mode', example: 'NEFT' },
    vendor_pay_ref: { label: 'UTR / reference', example: 'HDFCN52026111500001' },
    vendor_pay_for: { label: 'What the payment was for', example: 'order VO-005' },
    vendor_balance: { label: 'Balance still payable to the vendor', example: '₹70,800' },
    vendor_received_on: { label: 'Delivery date', example: '14 Nov 2026' },
    vendor_received: { label: 'What came in', example: 'Mask × 35' },
    vendor_pending: { label: 'What is still to come', example: 'Mask × 49, Disk set × 148' },
    vendor_rejected: { label: 'Pieces rejected at QC', example: '3' },
    vendor_qc_note: { label: 'QC note', example: 'warped edges' },
    vendor_invoice_no: { label: 'Vendor’s invoice number', example: 'SP/INV/1102' },
    vendor_invoice_amount: { label: 'Invoice amount', example: '₹35,400' },
    vendor_invoice_status: { label: 'Invoice decision (accepted / rejected)', example: 'accepted' },
    vendor_invoice_note: { label: 'Invoice note or reason', example: 'Thank you.' },
    vendor_instalment: { label: 'Instalment (e.g. 3 of 5)', example: '3 of 5' },
    vendor_instalment_amount: { label: 'Instalment amount, with ₹', example: '₹35,400' },
    vendor_instalment_due: { label: 'Instalment due date', example: '20 Nov 2026' },
};

/** Where a link button can go. Each becomes an /go/ code when the message is sent. */
const LINKS = {
    checkout: 'Their checkout (the abandoned cart)',
    order: 'Their order status page',
    tracking: 'The courier’s tracking page',
    store: 'The Normless store',
    vendor_page: 'The vendor’s own page (their private link)',
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
        body: 'Hi {{1}}, thank you for shopping with Normless! 🎉\n\nYour order {{2}} of ₹{{3}} is paid and confirmed.\nItems: {{4}}\n\nWe’ll message you here when it ships.',
        vars: ['first_name', 'order_number', 'order_total', 'items'], link: { text: 'View my order', source: 'order' },
    },
    {
        event: 'dispatch_delay', name: 'nlcrm_dispatch_delay', category: 'UTILITY', image: true,
        body: 'Hi {{1}}, thank you for your Normless order {{2}} 🙏\n\nYour {{3}} is in high demand, so it will be dispatched on {{4}}. Delivery takes 5–7 days after dispatch, depending on your location.\n\nWe’ll send you the tracking details as soon as it ships.',
        vars: ['first_name', 'order_number', 'delayed_items', 'dispatch_date'], link: { text: 'View my order', source: 'order' },
    },
    {
        event: 'order_partial_cod', name: 'nlcrm_order_partial_cod', category: 'UTILITY', image: true,
        body: 'Hi {{1}}, thank you for shopping with Normless! 🎉\n\nYour order {{2}} is confirmed. We have your advance; ₹{{3}} is to be paid in cash on delivery.\nItems: {{4}}\n\nWe’ll message you here when it ships.',
        vars: ['first_name', 'order_number', 'cod_amount', 'items'], link: { text: 'View my order', source: 'order' },
    },
    {
        event: 'order_cod', name: 'nlcrm_order_cod', category: 'UTILITY', image: true,
        body: 'Hi {{1}}, thank you for shopping with Normless! 🎉\n\nYour cash-on-delivery order {{2}} of ₹{{3}} is placed.\nItems: {{4}}\n\nWe’ll message you here when it ships.',
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
        body: 'Hi {{1}}, your order {{2}} is on its way! 🚚\n\nCourier: {{3}}\nTracking number: {{4}}\n\nTap below to follow your parcel.',
        vars: ['first_name', 'order_number', 'courier', 'tracking_number'], link: { text: 'Track my order', source: 'tracking' },
    },
    {
        event: 'out_for_delivery', name: 'nlcrm_out_for_delivery', category: 'UTILITY', image: true,
        body: 'Hi {{1}}, your Normless order {{2}} is out for delivery today 🚚\n\nPlease keep your phone handy so the courier can reach you.',
        vars: ['first_name', 'order_number'], link: { text: 'Track my order', source: 'tracking' },
    },
    {
        event: 'delivered', name: 'nlcrm_order_delivered', category: 'UTILITY', image: false,
        body: 'Hi {{1}}, your Normless order {{2}} has been delivered. We hope you love it!\n\nIf anything isn’t right, just reply to this message within 24 hours.',
        vars: ['first_name', 'order_number'], link: { text: 'View my order', source: 'order' },
    },
    {
        event: 'refund', name: 'nlcrm_refund_issued', category: 'UTILITY', image: false,
        body: 'Hi {{1}}, we’ve issued a refund of ₹{{2}} for your order {{3}}.\n\nBanks usually take 5–7 business days to show it in your account.',
        vars: ['first_name', 'refund_amount', 'order_number'], link: { text: 'View my order', source: 'order' },
    },
    {
        event: 'ticket_raised', name: 'nlcrm_ticket_raised', category: 'UTILITY', image: false,
        body: 'Hi {{1}}, we have raised support ticket {{2}} for your request: {{3}}.\n\nOur team will get back to you here between 9 am and 6 pm. You can reply to this message anytime to ask about it.',
        vars: ['first_name', 'ticket_ref', 'ticket_subject'],
    },
];

// Vendors (Purchasing). Transactional, so UTILITY; one button to their own page. Meta refuses a body
// that starts or ends on a variable, so each opens with a greeting and closes on a sentence.
SET.push(
    {
        event: 'vendor_link', name: 'nlcrm_vendor_page', category: 'UTILITY', image: false,
        body: 'Hi {{1}}, this is your vendor page with {{2}}.\n\nYour orders, deliveries, payments and invoices are always up to date there, and you can upload your invoices on it.',
        vars: ['vendor_name', 'company'], link: { text: 'Open my page', source: 'vendor_page' },
    },
    {
        event: 'vendor_order', name: 'nlcrm_vendor_new_order', category: 'UTILITY', image: false,
        body: 'Hello {{1}}, we have placed a new purchase order {{2}} with you for {{3}}.\n\nItems ordered: {{4}}\nOrder value: {{5}}\nExpected delivery by: {{6}}\n\nPlease confirm that you have received this order by replying to this message. The full order is on your vendor page.',
        vars: ['vendor_name', 'vendor_order_ref', 'vendor_brand', 'vendor_items', 'vendor_order_value', 'vendor_delivery_by'], link: { text: 'View order', source: 'vendor_page' },
    },
    {
        event: 'vendor_order_changed', name: 'nlcrm_vendor_order_updated', category: 'UTILITY', image: false,
        body: 'Hello {{1}}, our order {{2}} has been updated: {{3}}.\n\nPlease check the latest details on your vendor page.',
        vars: ['vendor_name', 'vendor_order_ref', 'vendor_change'], link: { text: 'View order', source: 'vendor_page' },
    },
    {
        event: 'vendor_payment', name: 'nlcrm_vendor_payment_sent', category: 'UTILITY', image: false,
        body: 'Hello {{1}}, we have sent you a payment of {{2}} on {{3}} by {{4}}.\n\nBank reference (UTR): {{5}}\nPaid for: {{6}}\nBalance still payable to you after this payment: {{7}}\n\nThank you for working with us. Every payment and the full statement are on your vendor page.',
        vars: ['vendor_name', 'vendor_pay_amount', 'vendor_paid_on', 'vendor_pay_mode', 'vendor_pay_ref', 'vendor_pay_for', 'vendor_balance'], link: { text: 'View statement', source: 'vendor_page' },
    },
    {
        event: 'vendor_delivery', name: 'nlcrm_vendor_delivery_received', category: 'UTILITY', image: false,
        body: 'Hello {{1}}, we have received your delivery dated {{2}} against our order {{3}}.\n\nReceived in this lot: {{4}}\nStill to come on the order: {{5}}\n\nThank you. You can see every delivery we recorded on your vendor page.',
        vars: ['vendor_name', 'vendor_received_on', 'vendor_order_ref', 'vendor_received', 'vendor_pending'], link: { text: 'View order', source: 'vendor_page' },
    },
    {
        event: 'vendor_rejected', name: 'nlcrm_vendor_qc_rejected', category: 'UTILITY', image: false,
        body: 'Hello {{1}}, from your delivery dated {{2}} against our order {{3}}, {{4}} pieces did not pass our quality check.\n\nWhat we found: {{5}}\n\nThese pieces are still owed on the order. Please arrange replacements and let us know when they will be sent.',
        vars: ['vendor_name', 'vendor_received_on', 'vendor_order_ref', 'vendor_rejected', 'vendor_qc_note'], link: { text: 'View order', source: 'vendor_page' },
    },
    {
        event: 'vendor_invoice', name: 'nlcrm_vendor_invoice_reviewed', category: 'UTILITY', image: false,
        body: 'Hello {{1}}, your invoice number {{2}} for {{3}} has been {{4}} by our accounts team.\n\nNote: {{5}}\n\nYou can see the status of all your invoices, and upload new ones, on your vendor page.',
        vars: ['vendor_name', 'vendor_invoice_no', 'vendor_invoice_amount', 'vendor_invoice_status', 'vendor_invoice_note'], link: { text: 'View invoices', source: 'vendor_page' },
    },
    {
        event: 'vendor_instalment_due', name: 'nlcrm_vendor_instalment_due', category: 'UTILITY', image: false,
        body: 'Hello {{1}}, this is to let you know that instalment {{2}} of {{3}} for our order {{4}} is scheduled to be paid on {{5}}.\n\nYou can see the full payment plan and every payment made on your vendor page.',
        vars: ['vendor_name', 'vendor_instalment', 'vendor_instalment_amount', 'vendor_order_ref', 'vendor_instalment_due'], link: { text: 'View payment plan', source: 'vendor_page' },
    },
);

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
